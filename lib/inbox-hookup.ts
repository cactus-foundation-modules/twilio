import { getSiteUrl } from '@/lib/config/env'
import { listIncomingNumbers, twilioFetch, type TwilioRegion } from './twilio'
import { resolveNumberRegion } from './numbers'

// Points a Twilio number's "text comes in" and "call status changes" webhooks at
// this site's activity address, so the unified inbox hears of a text or a
// finished call at once (app/api/webhooks/twilio/activity).
//
// NEVER OVERWRITES SOMEONE ELSE'S. A number whose incoming-text URL already
// goes elsewhere - a live chat tool that takes texts through Twilio, say -
// would silently stop reaching it. Those are left alone and reported, so a
// person decides. Blank, or already ours, is fair game.
//
// Written to the number's own processing Region: webhook config is per-Region
// at Twilio (see setNumberVoiceUrl).

export type HookupState = 'connected' | 'already' | 'other'

export type HookupResult = {
  phoneNumber: string
  /** Incoming texts. `null` where the number cannot receive them. */
  texts: HookupState | null
  /** Where texts go now, when `texts` is 'other'. */
  textsElsewhere?: string
  /** Calls finishing. */
  calls: HookupState
  callsElsewhere?: string
  error?: string
}

const OUR_PATH = '/api/m/twilio/webhooks/activity'

export function activityUrl(): string {
  return `${getSiteUrl()}${OUR_PATH}`
}

function isOurs(url: string): boolean {
  return url === activityUrl()
}

type NumberResource = {
  sms_url?: string | null
  sms_application_sid?: string | null
  status_callback?: string | null
  capabilities?: { sms?: boolean }
}

export async function connectNumberToInbox(
  sid: string,
  phoneNumber: string,
  region: TwilioRegion,
): Promise<HookupResult> {
  const path = `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`
  const current = (await twilioFetch(path, { region })) as NumberResource
  const url = activityUrl()
  const form: Record<string, string> = {}
  const result: HookupResult = { phoneNumber, texts: null, calls: 'already' }

  if (current.capabilities?.sms === true) {
    const existing = current.sms_url ?? ''
    if (current.sms_application_sid) {
      result.texts = 'other'
      result.textsElsewhere = 'a Twilio application'
    } else if (existing && !isOurs(existing)) {
      result.texts = 'other'
      result.textsElsewhere = existing
    } else if (isOurs(existing)) {
      result.texts = 'already'
    } else {
      form.SmsUrl = url
      form.SmsMethod = 'POST'
      result.texts = 'connected'
    }
  }

  const callHook = current.status_callback ?? ''
  if (callHook && !isOurs(callHook)) {
    result.calls = 'other'
    result.callsElsewhere = callHook
  } else if (!callHook) {
    form.StatusCallback = url
    form.StatusCallbackMethod = 'POST'
    result.calls = 'connected'
  }

  if (Object.keys(form).length > 0) {
    await twilioFetch(path, { method: 'POST', form, region })
  }
  return result
}

/** Every number on the account. One that fails does not stop the rest. */
export async function connectAllNumbersToInbox(): Promise<HookupResult[]> {
  const numbers = await listIncomingNumbers()
  const results: HookupResult[] = []
  for (const n of numbers) {
    try {
      const region = await resolveNumberRegion(n.phoneNumber)
      results.push(await connectNumberToInbox(n.sid, n.phoneNumber, region))
    } catch (err) {
      results.push({
        phoneNumber: n.phoneNumber,
        texts: null,
        calls: 'already',
        error: err instanceof Error ? err.message : 'Twilio refused',
      })
    }
  }
  return results
}

/** For the places that already touch a number: tidy-up that must never fail
 *  the save it rides on. */
export async function connectNumberQuietly(sid: string, phoneNumber: string, region: TwilioRegion): Promise<void> {
  try {
    await connectNumberToInbox(sid, phoneNumber, region)
  } catch (err) {
    console.error('[twilio] could not connect', phoneNumber, 'to the inbox', err)
  }
}
