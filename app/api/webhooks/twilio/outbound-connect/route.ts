// POST /api/m/twilio/webhooks/outbound-connect?to=... - second leg of the
// Make Call flow. Twilio posts here when the admin presses a key during the
// Gather; we respond with TwiML that dials the target, presenting the site's
// Twilio number (the From of this leg) as caller ID. Signature-validated over
// the full URL including the query string; no session (Twilio is the caller).
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured } from '@/modules/twilio/lib/twilio'

function twiml(inner: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { 'Content-Type': 'text/xml' },
  })
}

const E164 = /^\+[1-9]\d{7,14}$/

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
  const url = `${getSiteUrl()}/api/m/twilio/webhooks/outbound-connect${request.nextUrl.search}`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  const to = request.nextUrl.searchParams.get('to') ?? ''
  // From on this leg is the site's Twilio number - the admin leg was placed
  // From that number - so it doubles as the outbound caller ID.
  const callerId = params.From ?? ''

  // E.164 only ever contains + and digits, so no XML escaping needed.
  if (!params.Digits || !E164.test(to) || !E164.test(callerId)) {
    return twiml('<Hangup/>')
  }
  return twiml(`<Say>Connecting.</Say><Dial callerId="${callerId}">${to}</Dial>`)
}
