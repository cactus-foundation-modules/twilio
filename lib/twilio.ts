// Thin Twilio REST client. Credentials come from env vars managed on the core
// admin settings page (Twilio tab). No SDK dependency - the three calls this
// module needs are plain REST.
import { createHmac, timingSafeEqual } from 'crypto'

const API_BASE = 'https://api.twilio.com/2010-04-01'

export function getTwilioConfig(): { accountSid: string; authToken: string } | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !authToken) return null
  return { accountSid, authToken }
}

export function isTwilioConfigured(): boolean {
  return getTwilioConfig() !== null
}

function authHeader(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`
}

async function twilioFetch(path: string, init?: { method?: string; form?: Record<string, string> }): Promise<unknown> {
  const config = getTwilioConfig()
  if (!config) throw new Error('Twilio is not configured')

  const headers: Record<string, string> = {
    Authorization: authHeader(config.accountSid, config.authToken),
  }
  let body: string | undefined
  if (init?.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(init.form).toString()
  }

  const res = await fetch(`${API_BASE}/Accounts/${config.accountSid}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { message?: string } | null
    throw new Error(detail?.message ?? `Twilio API error ${res.status}`)
  }
  return res.json()
}

// Connection test - fetches the account's friendly name.
export async function fetchAccountName(): Promise<string> {
  const data = await twilioFetch('.json') as { friendly_name?: string }
  return data.friendly_name ?? 'Twilio account'
}

// `from` must be an SMS-capable Twilio number on the account - callers go
// through lib/numbers.ts sendSiteSms, which resolves the site's default.
export async function sendSms(to: string, body: string, from: string): Promise<void> {
  await twilioFetch('/Messages.json', {
    method: 'POST',
    form: { To: to, From: from, Body: body },
  })
}

export type IncomingNumber = {
  sid: string
  phoneNumber: string
  friendlyName: string
  voiceUrl: string
  smsCapable: boolean
  voiceCapable: boolean
}

export async function listIncomingNumbers(): Promise<IncomingNumber[]> {
  const data = await twilioFetch('/IncomingPhoneNumbers.json?PageSize=100') as {
    incoming_phone_numbers?: Array<{
      sid: string
      phone_number: string
      friendly_name: string
      voice_url: string | null
      capabilities?: { voice?: boolean; sms?: boolean }
    }>
  }
  return (data.incoming_phone_numbers ?? []).map((n) => ({
    sid: n.sid,
    phoneNumber: n.phone_number,
    friendlyName: n.friendly_name,
    voiceUrl: n.voice_url ?? '',
    smsCapable: n.capabilities?.sms === true,
    voiceCapable: n.capabilities?.voice === true,
  }))
}

// Escapes text for embedding in TwiML (e.g. inside <Say>).
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Places an outbound call that plays the given TwiML - used to preview the
// forwarding greeting. `from` must be a Twilio number on the account.
export async function placeCall(to: string, from: string, twiml: string): Promise<void> {
  await twilioFetch('/Calls.json', {
    method: 'POST',
    form: { To: to, From: from, Twiml: twiml },
  })
}

// Points the number's voice webhook at `url`, or clears it when url is empty.
export async function setNumberVoiceUrl(sid: string, url: string): Promise<void> {
  await twilioFetch(`/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
    method: 'POST',
    form: { VoiceUrl: url, VoiceMethod: 'POST' },
  })
}

// Validates Twilio's X-Twilio-Signature header: HMAC-SHA1 over the full webhook
// URL plus the POST params concatenated in key-sorted order, base64-encoded.
// https://www.twilio.com/docs/usage/security#validating-requests
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  const config = getTwilioConfig()
  if (!config) return false

  let data = url
  for (const key of Object.keys(params).sort()) {
    data += key + params[key]
  }
  const expected = createHmac('sha1', config.authToken).update(data, 'utf8').digest('base64')

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}
