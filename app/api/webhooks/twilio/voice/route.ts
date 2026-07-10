// POST /api/m/twilio/webhooks/voice - Twilio calls this when one of the
// site's numbers receives a call. Responds with TwiML that dials the
// configured forward-to number. Signature-validated; no session (Twilio is
// the caller).
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured, escapeXml } from '@/modules/twilio/lib/twilio'
import { getEnabledRuleForNumber } from '@/modules/twilio/lib/forwarding'

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
  const rule = called ? await getEnabledRuleForNumber(called) : null

  // E.164 targets only ever contain + and digits, so no XML escaping needed -
  // normalisePhone enforced that on the way in.
  if (rule?.forwardTo && /^\+[1-9]\d{7,14}$/.test(rule.forwardTo)) {
    // Optional greeting before the dial. Voice ids were validated against the
    // curated list on save, but only ever contain [A-Za-z.-] anyway.
    let greeting = ''
    if (rule.greetingMessage) {
      const voiceAttr = rule.greetingVoice ? ` voice="${rule.greetingVoice}"` : ''
      greeting = `<Say${voiceAttr}>${escapeXml(rule.greetingMessage)}</Say>`
    }
    const recordAttr = rule.recordCalls ? ' record="record-from-answer-dual"' : ''
    return twiml(`${greeting}<Dial${recordAttr}>${rule.forwardTo}</Dial>`)
  }
  return twiml('<Reject/>')
}
