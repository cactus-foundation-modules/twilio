// POST /api/m/twilio/webhooks/voicemail - the follow-on step for a call that
// the voice webhook dialled out. Twilio requests this twice over a voicemail's
// life, and the params say which stage it is:
//
//  1. The <Dial> finished. DialCallStatus says how. Anything other than a
//     connected call sends the caller to voicemail.
//  2. The <Record> finished, so RecordingSid is present. The message gets
//     written down and the admin notified, then the call hangs up - without the
//     hangup the recording's action URL would loop back round.
//
// Signature-validated; no session (Twilio is the caller). The recording itself
// stays in the Twilio account; stage 2 is the only point at which it is known
// to be a voicemail rather than a recorded forwarded call, which is why the
// call log's voicemail marking hangs off this request.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { getRuleForNumber } from '@/modules/twilio/lib/forwarding'
import { voicemailTwiml } from '@/modules/twilio/lib/voicemail'
import { recordVoicemail } from '@/modules/twilio/lib/voicemail-log'

// Dial outcomes that mean the caller never got through to a person. 'completed'
// and 'answered' are a real conversation; 'canceled' is the caller ringing off
// before anyone could pick up, so there is nobody left to leave a message.
const NO_ANSWER_STATUSES = new Set(['no-answer', 'busy', 'failed'])

// RecordingSid is always sent alongside RecordingUrl, but the URL ends in the
// SID anyway, so the pair are treated as two ways of being told the same thing.
function recordingSidFromUrl(url: string): string {
  const last = url.split('?')[0]!.split('/').pop() ?? ''
  return /^RE[0-9a-f]{32}$/i.test(last) ? last : ''
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

  const signature = request.headers.get('x-twilio-signature') ?? ''
  const url = `${getSiteUrl()}/api/m/twilio/webhooks/voicemail`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  // Stage 2: the message has been recorded and saved. Twilio requests this even
  // when the caller ends the message by hanging up (Digits is then 'hangup'),
  // so every message that produced a recording lands here.
  if (params.RecordingSid || params.RecordingUrl) {
    const recordingSid = params.RecordingSid || recordingSidFromUrl(params.RecordingUrl ?? '')
    if (recordingSid) {
      // Logged, never thrown: the caller has already rung off, and a failure to
      // write the row must not turn into a Twilio error on a message that was
      // recorded perfectly well. The recording still appears in the call log,
      // just without the voicemail marking.
      try {
        await recordVoicemail({
          recordingSid,
          callSid: params.CallSid ?? '',
          fromNumber: params.From ?? '',
          toNumber: params.To ?? '',
          durationSeconds: parseInt(params.RecordingDuration ?? '', 10) || 0,
        })
      } catch (err) {
        console.error('[twilio] failed to record voicemail', recordingSid, err)
      }
    }
    return twiml('<Hangup/>')
  }

  // Stage 1: the dial is over.
  const status = params.DialCallStatus ?? ''
  if (!NO_ANSWER_STATUSES.has(status)) {
    return twiml('<Hangup/>')
  }

  const called = params.To ?? ''
  const rule = called ? await getRuleForNumber(called) : null
  // The rule could have had voicemail switched off mid-call. Hanging up beats
  // recording a message nobody has anywhere to listen to.
  if (!rule?.voicemailEnabled) {
    return twiml('<Hangup/>')
  }

  return twiml(voicemailTwiml(rule))
}
