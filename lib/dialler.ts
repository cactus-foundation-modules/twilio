// The site's dialler, published to core's `core.dialler` seam.
//
// It is the same click-to-dial the settings screen uses (lib/click-to-dial.ts),
// wrapped in the shape core defined - so a module that has a customer's number
// on screen can ring it without knowing that Twilio exists, and this module
// gains no knowledge of whoever is calling it either.
//
// SERVER ONLY: the manifest entry sets serverOnly, because everything below
// reaches the account's credentials.
import type { Dialler, DialRequest, DialResult, DiallerNumber } from '@/lib/dialler/types'
import { isTwilioConfigured } from './twilio'
import { getSiteNumbers } from './numbers'
import { placeClickToDial, voiceCapableNumbers } from './click-to-dial'

/** The site's own numbers that can actually place a call.
 *
 *  The site's chosen numbers rather than every number on the account: an
 *  account may hold numbers bought for something else entirely, and the ones an
 *  owner has added on the settings page are the ones they mean by "our
 *  numbers". Cross-checked against the account for voice capability, because an
 *  SMS-only number in a caller-ID menu is a refusal waiting to happen. */
async function numbers(): Promise<DiallerNumber[]> {
  if (!isTwilioConfigured()) return []
  const [site, voice] = await Promise.all([getSiteNumbers(), voiceCapableNumbers()])
  return site
    .filter((n) => voice.has(n.phoneNumber))
    .map((n) => ({
      number: n.phoneNumber,
      label: n.friendlyName?.trim() ? `${n.friendlyName} (${n.phoneNumber})` : n.phoneNumber,
    }))
}

/** Configured means "could ring somebody now": credentials AND a number to ring
 *  them from. Anything less and a consumer should not offer the button. */
async function isConfigured(): Promise<boolean> {
  if (!isTwilioConfigured()) return false
  try {
    return (await numbers()).length > 0
  } catch {
    // The account being unreachable this second is not the same as the site
    // having no telephony. It is still not a call anybody can place right now.
    return false
  }
}

async function dial(request: DialRequest): Promise<DialResult> {
  try {
    const result = await placeClickToDial({
      fromNumber: request.from,
      to: request.to,
      callMeAt: request.callMeAt,
    })
    return result.ok ? { ok: true } : { ok: false, reason: result.reason }
  } catch (err) {
    // Core's seam has one shape for "it did not happen", and a consumer showing
    // a sentence is a better answer than a screen that falls over.
    console.error('[twilio] could not place the call:', err)
    return { ok: false, reason: 'The call could not be placed. Twilio did not accept it.' }
  }
}

export const twilioDialler: Dialler = {
  label: 'Twilio',
  isConfigured,
  numbers,
  dial,
}
