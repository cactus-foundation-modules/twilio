// POST /api/m/twilio/webhooks/voice - Twilio calls this when one of the
// site's numbers receives a call. Responds with TwiML that dials the
// configured forward-to number, sends the caller to voicemail, or rejects the
// call. Signature-validated; no session (Twilio is the caller).
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured, escapeXml } from '@/modules/twilio/lib/twilio'
import { getRuleForNumber, isRuleOpenNow } from '@/modules/twilio/lib/forwarding'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { greetingAudioUrl } from '@/modules/twilio/lib/greeting-audio'
import { voiceForRegion } from '@/modules/twilio/lib/voices'
import { voicemailTwiml, voicemailUrl } from '@/modules/twilio/lib/voicemail'
import { getTwilioSettings } from '@/modules/twilio/lib/settings'

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

  // Withheld numbers arrive as an empty From, 'anonymous', 'restricted', or
  // Twilio's +266696687 marker (spells ANONYMOUS on a keypad). What happens
  // next is the number's own choice: ring through like anyone else, straight
  // to voicemail, or rejected outright.
  const anonymous = !E164.test(params.From ?? '') || params.From === '+266696687'
  if (anonymous && rule.anonymousCallers === 'reject') return twiml('<Reject/>')

  // Some voices only exist for US-processed calls (voices.ts, usOnly): swap
  // them for their regional stand-in here rather than answering an Irish call
  // with TwiML its Region cannot say - that is Twilio error 13520 and a dead
  // line after the greeting.
  const region = await resolveNumberRegion(called)
  rule.greetingVoice = voiceForRegion(rule.greetingVoice, region)
  rule.voicemailVoice = voiceForRegion(rule.voicemailVoice, region)

  // Whether the number is shut is worth knowing separately from whether the
  // call can be forwarded: a caller ringing out of hours can be told so, rather
  // than hearing the same "nobody is available" as a call that rang out.
  const open = await isRuleOpenNow(rule)
  // E.164 targets only ever contain + and digits, so no XML escaping is needed -
  // normalisePhone enforced that on the way in.
  const canForward =
    rule.enabled && E164.test(rule.forwardTo) && open && !(anonymous && rule.anonymousCallers === 'voicemail')

  if (!canForward) {
    // Forwarding off, no usable target, the number shut for the day, or a
    // withheld caller the number sends straight to voicemail. With voicemail on
    // the caller records a message instead of hearing the call greeting, which
    // promises a forward that is not going to happen.
    return rule.voicemailEnabled ? twiml(voicemailTwiml(rule, !open)) : twiml('<Reject/>')
  }

  // Optional greeting before the dial: an uploaded file plays, otherwise the
  // typed message is said. Voice ids were validated against the curated list
  // on save, but only ever contain [A-Za-z.-] anyway.
  let greeting = ''
  if (rule.greetingAudioMediaId) {
    greeting = `<Play>${escapeXml(greetingAudioUrl(rule.greetingAudioMediaId))}</Play>`
  } else if (rule.greetingMessage) {
    const voiceAttr = rule.greetingVoice ? ` voice="${rule.greetingVoice}"` : ''
    greeting = `<Say${voiceAttr}>${escapeXml(rule.greetingMessage)}</Say>`
  }
  const recordAttr = rule.recordCalls ? ' record="record-from-answer-dual"' : ''
  // Optionally present the called Twilio number as caller ID on the
  // forwarded leg (allowed - the account owns it). Same E.164 shape as
  // forwardTo, so no XML escaping needed either.
  const callerIdAttr = rule.showCalledNumber && E164.test(called) ? ` callerId="${called}"` : ''
  // The dial gets a ring limit and an action URL whenever there is anything to
  // do after an unanswered ring: voicemail to take, a second number to try, an
  // auto-text or email alert to send. Twilio requests the URL when the dial
  // finishes and the voicemail route decides what happens next. With none of
  // those, the dial keeps Twilio's own default timeout and no action.
  const settings = await getTwilioSettings()
  const needsDialAction =
    rule.voicemailEnabled ||
    E164.test(rule.forwardToSecond) ||
    rule.missedCallSmsEnabled ||
    (settings.notifyMissedCallEmail && settings.notifyEmail !== '')
  const actionAttrs = needsDialAction
    ? ` timeout="${rule.ringTimeout}" action="${escapeXml(voicemailUrl())}" method="POST"`
    : ''

  return twiml(
    `${greeting}<Dial${recordAttr}${callerIdAttr}${actionAttrs}>${rule.forwardTo}</Dial>`
  )
}
