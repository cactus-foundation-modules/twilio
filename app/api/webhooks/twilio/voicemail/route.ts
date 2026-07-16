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
import { planVoicemailRequest, voicemailTwiml } from '@/modules/twilio/lib/voicemail'
import { recordVoicemail } from '@/modules/twilio/lib/voicemail-log'

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

  const plan = planVoicemailRequest({
    stage: request.nextUrl.searchParams.get('stage'),
    dialCallStatus: params.DialCallStatus,
    recordingSid: params.RecordingSid,
    recordingUrl: params.RecordingUrl,
    recordingDuration: params.RecordingDuration,
  })

  if (plan.action === 'log-message') {
    // Logged, never thrown: the caller has already rung off, and a failure to
    // write the row must not turn into a Twilio error on a message that was
    // recorded perfectly well. The recording still appears in the call log,
    // just without the voicemail marking.
    try {
      await recordVoicemail({
        recordingSid: plan.recordingSid,
        callSid: params.CallSid ?? '',
        fromNumber: params.From ?? '',
        toNumber: params.To ?? '',
        durationSeconds: plan.durationSeconds,
      })
    } catch (err) {
      console.error('[twilio] failed to record voicemail', plan.recordingSid, err)
    }
    return twiml('<Hangup/>')
  }

  if (plan.action === 'take-message') {
    const called = params.To ?? ''
    const rule = called ? await getRuleForNumber(called) : null
    // The rule could have had voicemail switched off mid-call. Hanging up beats
    // recording a message nobody has anywhere to listen to.
    if (!rule?.voicemailEnabled) return twiml('<Hangup/>')
    return twiml(voicemailTwiml(rule))
  }

  return twiml('<Hangup/>')
}
