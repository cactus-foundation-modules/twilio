// POST /api/m/twilio/webhooks/activity - the one address Twilio is told to ring
// whenever something happens on a call or a text: an incoming text, a call
// finishing (either direction), an outgoing text changing state.
//
// Its ONLY job is to tell the rest of the site there is something new, so the
// unified inbox copies the phone channel now rather than at its next hourly
// tick. Nothing is written here; calls and texts are read live from Twilio.
//
// Signature-validated; no session (Twilio is the caller). An incoming text
// gets an empty <Response/> back - without one Twilio logs a 12300 warning, and
// a TwiML body with no <Message> is how it is told not to auto-reply. Anything
// else gets 204.
import { NextRequest, NextResponse, after } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { announceConversationArrived } from '@/lib/conversations/arrived'
import { validateTwilioSignature, isTwilioConfigured } from '@/modules/twilio/lib/twilio'

// Call and text states that mean the record in Twilio's log is now final or
// has just appeared. In-flight states (ringing, queued, sending) are skipped:
// each would cost a fetch of the whole channel to learn nothing new.
const CALL_DONE = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled'])
const MESSAGE_SETTLED = new Set(['received', 'sent', 'delivered', 'undelivered', 'failed'])

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>'

export async function POST(request: NextRequest) {
  if (!isTwilioConfigured()) return new NextResponse('Not configured', { status: 503 })

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }

  const signature = request.headers.get('x-twilio-signature') ?? ''
  const url = `${getSiteUrl()}/api/m/twilio/webhooks/activity${request.nextUrl.search}`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  const isText = Boolean(params.MessageSid)
  const state = (isText ? (params.MessageStatus ?? params.SmsStatus) : params.CallStatus) ?? ''
  const worthTelling = isText ? MESSAGE_SETTLED.has(state) : CALL_DONE.has(state)

  if (worthTelling) {
    // After the response, so Twilio is never kept waiting on the inbox's fetch.
    // The announcer never throws, and the hourly tick is still behind it.
    after(() =>
      announceConversationArrived({
        moduleName: 'twilio',
        providerId: 'twilio',
        conversationId: params.CallSid ?? params.MessageSid ?? '',
      }),
    )
  }

  // An incoming text carries its Body; the status callback for a text we sent
  // does not, and wants nothing back.
  if (isText && params.Body !== undefined) {
    return new NextResponse(EMPTY_TWIML, { status: 200, headers: { 'content-type': 'text/xml' } })
  }
  return new NextResponse(null, { status: 204 })
}
