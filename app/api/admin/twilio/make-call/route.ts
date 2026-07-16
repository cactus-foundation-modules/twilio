// POST /api/m/twilio/admin/make-call - two-leg click-to-dial. Twilio rings
// the admin first (from the chosen site number, so that's the caller ID they
// see), reads out who is about to be called, and connects the outbound leg
// once any key is pressed. The outbound leg presents the Twilio number as
// caller ID, so calls go out under the site's own identity.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteUrl } from '@/lib/config/env'
import { isTwilioConfigured, listIncomingNumbers, placeCall, escapeXml } from '@/modules/twilio/lib/twilio'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { normalisePhone } from '@/modules/twilio/lib/verification'

const Body = z.object({
  // The Twilio number the call goes out from (must be on the account).
  fromNumber: z.string().min(1),
  // Who to dial once the admin has picked up and pressed a key.
  to: z.string().min(1),
  // Where to ring the admin.
  callMeAt: z.string().min(1),
})

// Reads a phone number digit by digit so <Say> doesn't attempt it as one
// enormous quantity.
function spellOut(number: string): string {
  return number.replace('+', 'plus ').split('').join(' ')
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured. Add your credentials on the settings page first.', 503)
  }

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')

  const to = normalisePhone(parsed.data.to)
  if (!to) return errorResponse('Number to call must be in international format, e.g. +447700900123')

  const callMeAt = normalisePhone(parsed.data.callMeAt)
  if (!callMeAt) return errorResponse('Your own number must be in international format, e.g. +447700900123')

  // The from number must be a voice-capable number on the connected account -
  // never trust a caller-supplied caller ID beyond that.
  let fromNumber: string
  try {
    const numbers = await listIncomingNumbers()
    const match = numbers.find((n) => n.phoneNumber === parsed.data.fromNumber)
    if (!match) return errorResponse('That number is not on the connected Twilio account')
    if (!match.voiceCapable) return errorResponse('That number cannot make voice calls')
    fromNumber = match.phoneNumber
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to verify number', 502)
  }

  // `to` is E.164 (+ and digits only) so it is URL- and XML-safe as-is, but
  // encodeURIComponent keeps the query robust regardless.
  const actionUrl = `${getSiteUrl()}/api/m/twilio/webhooks/outbound-connect?to=${encodeURIComponent(to)}`
  const prompt = `You are about to call ${spellOut(to)}. Press any key to connect, or hang up to cancel.`
  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather numDigits="1" timeout="20" action="${escapeXml(actionUrl)}" method="POST">` +
    `<Say>${escapeXml(prompt)}</Say>` +
    `</Gather>` +
    `<Say>No key pressed. Goodbye.</Say>` +
    `</Response>`

  try {
    // Dial out through the from-number's own Region so the call is processed
    // and logged where the rest of that number's traffic lives.
    const region = await resolveNumberRegion(fromNumber)
    await placeCall(callMeAt, fromNumber, twiml, region)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to place call', 502)
  }
}
