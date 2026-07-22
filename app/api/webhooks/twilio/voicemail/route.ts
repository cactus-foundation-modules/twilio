// POST /api/m/twilio/webhooks/voicemail - the follow-on step for a call that
// the voice webhook dialled out. Twilio requests this twice over a voicemail's
// life, and the URL says which stage it is:
//
//  1. The <Dial> finished. DialCallStatus says how. Anything other than a
//     connected call sends the caller to voicemail.
//  2. The <Record> finished: `?stage=recording`. The message gets written down
//     and the admin notified, then the call hangs up - without the hangup the
//     recording's action URL would loop back round.
//
// The stage is read off the URL and never inferred from the recording
// parameters, because a <Dial record="..."> sends RecordingUrl to its own
// action URL too - see RECORDING_STAGE in lib/voicemail.ts. Which stage this is
// gets decided by the pure planVoicemailRequest; this route only does the IO.
//
// Signature-validated over the full URL including the query string; no session
// (Twilio is the caller). The recording itself stays in the Twilio account;
// stage 2 is the only point at which it is known to be a voicemail rather than
// a recorded forwarded call, which is why the call log's voicemail marking
// hangs off this request.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { getRuleForNumber } from '@/modules/twilio/lib/forwarding'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { voiceForRegion } from '@/modules/twilio/lib/voices'
import { planVoicemailRequest, secondLegUrl, voicemailTwiml } from '@/modules/twilio/lib/voicemail'
import { recordVoicemail } from '@/modules/twilio/lib/voicemail-log'
import { sendMissedCallEmail, sendMissedCallText } from '@/modules/twilio/lib/notify'
import { escapeXml } from '@/modules/twilio/lib/twilio'
import type { ForwardingRule } from '@/modules/twilio/lib/forwarding'

const E164 = /^\+[1-9]\d{7,14}$/

// The second forwarding leg's <Dial>: same recording and caller-ID choices as
// the first, its own action marker so the planner knows there is no third try.
function secondDialTwiml(rule: ForwardingRule, called: string): string {
  const recordAttr = rule.recordCalls ? ' record="record-from-answer-dual"' : ''
  const callerIdAttr = rule.showCalledNumber && E164.test(called) ? ` callerId="${called}"` : ''
  return (
    `<Dial${recordAttr}${callerIdAttr} timeout="${rule.ringTimeout}" ` +
    `action="${escapeXml(secondLegUrl())}" method="POST">${rule.forwardToSecond}</Dial>`
  )
}

// The one point where a call is known to be definitively missed: every leg
// rang out. Auto-text and email alert both hang off it, each already a no-op
// when switched off, and neither is allowed to break the TwiML response.
async function notifyMissedCall(rule: ForwardingRule, fromNumber: string): Promise<void> {
  await Promise.all([
    sendMissedCallText(rule, fromNumber),
    sendMissedCallEmail(rule.phoneNumber, fromNumber),
  ])
}

function twiml(inner: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { 'Content-Type': 'text/xml' },
  })
}

export async function POST(request: NextRequest) {
  if (!isTwilioConfigured()) {
    return new NextResponse('Not configured', { status: 503 })
  }

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }

  // Twilio signs the exact URL it was given, query string included.
  const signature = request.headers.get('x-twilio-signature') ?? ''
  const url = `${getSiteUrl()}/api/m/twilio/webhooks/voicemail${request.nextUrl.search}`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  // The rule drives the planner's second-leg decision as well as the response,
  // so it is fetched up front. Recording-stage requests skip it: their number
  // lookup would only repeat what the row already knows.
  const stage = request.nextUrl.searchParams.get('stage')
  const called = params.To ?? ''
  const rule = stage ? null : called ? await getRuleForNumber(called) : null

  const plan = planVoicemailRequest(
    {
      stage,
      leg: request.nextUrl.searchParams.get('leg'),
      dialCallStatus: params.DialCallStatus,
      recordingSid: params.RecordingSid,
      recordingUrl: params.RecordingUrl,
      recordingDuration: params.RecordingDuration,
    },
    { hasSecondLeg: !!rule && E164.test(rule.forwardToSecond) }
  )

  if (plan.action === 'log-message') {
    // Logged, never thrown: the caller has already rung off, and a failure to
    // write the row must not turn into a Twilio error on a message that was
    // recorded perfectly well. The recording still appears in the call log,
    // just without the voicemail marking.
    try {
      const recordedRule = called ? await getRuleForNumber(called) : null
      await recordVoicemail({
        recordingSid: plan.recordingSid,
        callSid: params.CallSid ?? '',
        fromNumber: params.From ?? '',
        toNumber: called,
        durationSeconds: plan.durationSeconds,
        transcriptionRequested: recordedRule?.transcribeVoicemail ?? false,
      })
    } catch (err) {
      console.error('[twilio] failed to record voicemail', plan.recordingSid, err)
    }
    return twiml('<Hangup/>')
  }

  if (plan.action === 'dial-second') {
    // First number rang out but there is a second one to try before anything
    // is declared missed. rule is non-null here: the plan only says so when
    // the context said the rule holds a second leg.
    if (!rule) return twiml('<Hangup/>')
    return twiml(secondDialTwiml(rule, called))
  }

  if (plan.action === 'take-message') {
    // Every leg rang out: the call is missed, whatever happens next. The
    // auto-text and email alert fire exactly once, here.
    if (rule) await notifyMissedCall(rule, params.From ?? '')
    // The rule could have had voicemail switched off mid-call. Hanging up beats
    // recording a message nobody has anywhere to listen to.
    if (!rule?.voicemailEnabled) return twiml('<Hangup/>')
    // Same Region-availability swap as the voice webhook: a us-only voice on a
    // non-US call is error 13520, not a greeting.
    rule.voicemailVoice = voiceForRegion(rule.voicemailVoice, await resolveNumberRegion(called))
    // Always the open-hours greeting, never the closed one: getting here means
    // the voice webhook dialled out, which it only does inside opening hours.
    // The caller heard the phone ring and nobody picked up, so "we're closed"
    // would be a lie - even for a call that rings past closing time.
    return twiml(voicemailTwiml(rule))
  }

  return twiml('<Hangup/>')
}
