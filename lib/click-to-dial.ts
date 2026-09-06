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
// THE TWO TYPED NUMBERS ARE READ THE WAY PEOPLE TYPE THEM. Everywhere else in
// this module a phone number arrives from Twilio already in international form
// and is checked strictly (normalisePhone in ./verification); these two come off
// somebody's keyboard, where "020 8138 0512" is a whole number. Core's toE164
// puts the site's dialling code on, and the strict shape is still what leaves
// here - Twilio would refuse anything else.
//
// A REFUSAL IS A SENTENCE, NOT AN EXCEPTION. "That number is not on the
// connected account" is something the person at the keyboard can act on, so it
// comes back as a value. Only the genuinely exceptional - Twilio unreachable -
// throws.
import { getSiteUrl } from '@/lib/config/env'
import { toE164 } from '@/lib/phone'
import { siteDiallingCode } from '@/lib/phone.server'
import { isTwilioConfigured, listIncomingNumbers, placeCall, escapeXml } from './twilio'
import { resolveNumberRegion } from './numbers'

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
  'bad-to': 'That does not look like a number to call. Try it as 020 8138 0512, or in full as +44 20 8138 0512.',
  'bad-call-me-at': 'Your own number does not look right. Try it as 07700 900123, or in full as +44 7700 900123.',
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

  const diallingCode = await siteDiallingCode()

  const to = toE164(input.to, diallingCode)
  if (!to) return refuse('bad-to')

  const callMeAt = toE164(input.callMeAt, diallingCode)
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
