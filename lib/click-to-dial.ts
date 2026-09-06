// Two-leg click-to-dial, in one place.
//
// Twilio rings the person placing the call first - from the chosen site number,
// so that is the caller ID they see - reads out who is about to be called, and
// connects the outbound leg once any key is pressed. The outbound leg presents
// the site number as caller ID, so calls go out under the site's own identity.
//
// It lives here rather than in the route because two things now place a call:
// the settings screen's own dialler, and core's `core.dialler` seam, which is
// how a module that knows nothing about Twilio (the unified inbox, say) rings a
// customer. Two copies of this would be two sets of caller-ID checks, and only
// one of them would get fixed.
//
// A REFUSAL IS A SENTENCE, NOT AN EXCEPTION. "That number is not on the
// connected account" is something the person at the keyboard can act on, so it
// comes back as a value. Only the genuinely exceptional - Twilio unreachable -
// throws.
import { getSiteUrl } from '@/lib/config/env'
import { isTwilioConfigured, listIncomingNumbers, placeCall, escapeXml } from './twilio'
import { resolveNumberRegion } from './numbers'
import { normalisePhone } from './verification'

export type DialRefusal =
  | 'not-configured'
  | 'bad-to'
  | 'bad-call-me-at'
  | 'unknown-number'
  | 'not-voice-capable'

export type ClickToDialResult =
  | { ok: true }
  | { ok: false; code: DialRefusal; reason: string }

const REFUSALS: Record<DialRefusal, string> = {
  'not-configured': 'Twilio is not set up yet, so there is nothing to place the call with.',
  'bad-to': 'The number to call must be in international format, e.g. +447700900123.',
  'bad-call-me-at': 'Your own number must be in international format, e.g. +447700900123.',
  'unknown-number': 'That number is not on the connected Twilio account.',
  'not-voice-capable': 'That number cannot make voice calls.',
}

function refuse(code: DialRefusal): ClickToDialResult {
  return { ok: false, code, reason: REFUSALS[code] }
}

// Reads a phone number digit by digit so <Say> doesn't attempt it as one
// enormous quantity.
function spellOut(number: string): string {
  return number.replace('+', 'plus ').split('').join(' ')
}

/** Numbers on the connected account that can actually make a call. */
export async function voiceCapableNumbers(): Promise<Set<string>> {
  const numbers = await listIncomingNumbers()
  return new Set(numbers.filter((n) => n.voiceCapable).map((n) => n.phoneNumber))
}

export async function placeClickToDial(input: {
  /** Which of the account's numbers the call goes out as. */
  fromNumber: string
  /** Who to dial once the caller has picked up and pressed a key. */
  to: string
  /** Where to ring the caller, first. */
  callMeAt: string
}): Promise<ClickToDialResult> {
  if (!isTwilioConfigured()) return refuse('not-configured')

  const to = normalisePhone(input.to)
  if (!to) return refuse('bad-to')

  const callMeAt = normalisePhone(input.callMeAt)
  if (!callMeAt) return refuse('bad-call-me-at')

  // The from number must be a voice-capable number on the connected account -
  // never trust a caller-supplied caller ID beyond that.
  const numbers = await listIncomingNumbers()
  const match = numbers.find((n) => n.phoneNumber === input.fromNumber)
  if (!match) return refuse('unknown-number')
  if (!match.voiceCapable) return refuse('not-voice-capable')
  const fromNumber = match.phoneNumber

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

  // Dial out through the from-number's own Region so the call is processed and
  // logged where the rest of that number's traffic lives.
  const region = await resolveNumberRegion(fromNumber)
  await placeCall(callMeAt, fromNumber, twiml, region)
  return { ok: true }
}
