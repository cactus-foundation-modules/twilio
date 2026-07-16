// POST /api/m/twilio/webhooks/voice - Twilio calls this when one of the
// site's numbers receives a call. Responds with TwiML that dials the
// configured forward-to number, sends the caller to voicemail, or rejects the
// call. Signature-validated; no session (Twilio is the caller).
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured, escapeXml } from '@/modules/twilio/lib/twilio'
import { getRuleForNumber, isRuleOpenNow } from '@/modules/twilio/lib/forwarding'
import { voicemailTwiml, voicemailUrl } from '@/modules/twilio/lib/voicemail'

const E164 = /^\+[1-9]\d{7,14}$/

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
  const url = `${getSiteUrl()}/api/m/twilio/webhooks/voice`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  const called = params.To ?? ''
  const rule = called ? await getRuleForNumber(called) : null
  if (!rule) return twiml('<Reject/>')

  // E.164 targets only ever contain + and digits, so no XML escaping is needed -
  // normalisePhone enforced that on the way in.
  const canForward = rule.enabled && E164.test(rule.forwardTo) && (await isRuleOpenNow(rule))

  if (!canForward) {
    // Forwarding off, no usable target, or the number is shut for the day. With
    // voicemail on the caller records a message instead of hearing the call
    // greeting, which promises a forward that is not going to happen.
    return rule.voicemailEnabled ? twiml(voicemailTwiml(rule)) : twiml('<Reject/>')
  }

  // Optional greeting before the dial. Voice ids were validated against the
  // curated list on save, but only ever contain [A-Za-z.-] anyway.
  let greeting = ''
  if (rule.greetingMessage) {
    const voiceAttr = rule.greetingVoice ? ` voice="${rule.greetingVoice}"` : ''
    greeting = `<Say${voiceAttr}>${escapeXml(rule.greetingMessage)}</Say>`
  }
  const recordAttr = rule.recordCalls ? ' record="record-from-answer-dual"' : ''
  // Optionally present the called Twilio number as caller ID on the
  // forwarded leg (allowed - the account owns it). Same E.164 shape as
  // forwardTo, so no XML escaping needed either.
  const callerIdAttr = rule.showCalledNumber && E164.test(called) ? ` callerId="${called}"` : ''
  // With voicemail on, the dial gets a ring limit and an action URL: when the
  // forwarded leg is not picked up, Twilio requests that URL and the voicemail
  // route decides what happens next. Without voicemail there is nothing to fall
  // back to, so the dial keeps Twilio's own default timeout and no action.
  const voicemailAttrs = rule.voicemailEnabled
    ? ` timeout="${rule.ringTimeout}" action="${escapeXml(voicemailUrl())}" method="POST"`
    : ''

  return twiml(
    `${greeting}<Dial${recordAttr}${callerIdAttr}${voicemailAttrs}>${rule.forwardTo}</Dial>`
  )
}
