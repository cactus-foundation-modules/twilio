// POST /api/m/twilio/webhooks/voicemail - the follow-on step for a call that
// the voice webhook dialled out. Twilio requests this twice over a voicemail's
// life, and the params say which stage it is:
//
//  1. The <Dial> finished. DialCallStatus says how. Anything other than a
//     connected call sends the caller to voicemail.
//  2. The <Record> finished, so RecordingSid is present. Nothing left to do but
//     hang up - without this the recording's action URL would loop back round.
//
// Signature-validated; no session (Twilio is the caller). The recording itself
// stays in the Twilio account and shows up against the call in the call log,
// same as a recorded forwarded call.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { getRuleForNumber } from '@/modules/twilio/lib/forwarding'
import { voicemailTwiml } from '@/modules/twilio/lib/voicemail'

// Dial outcomes that mean the caller never got through to a person. 'completed'
// and 'answered' are a real conversation; 'canceled' is the caller ringing off
// before anyone could pick up, so there is nobody left to leave a message.
const NO_ANSWER_STATUSES = new Set(['no-answer', 'busy', 'failed'])

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

  // Stage 2: the message has been recorded and saved.
  if (params.RecordingSid || params.RecordingUrl) {
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
