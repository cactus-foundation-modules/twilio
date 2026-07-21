// Thin Twilio REST client. Credentials come from env vars managed on the core
// admin settings page (Twilio tab). No SDK dependency - the calls this module
// needs are plain REST.
//
// Regions: Twilio runs isolated regional instances (us1/ie1/au1) for data
// residency. Three facts drive the shape of everything below.
//
//   1. The account itself lives in one "home" Region (see getHomeRegion). The
//      account listing, the Routes API and the connection test all run there,
//      and its credentials are the main Account SID + Auth token. An account
//      homed outside us1 is REJECTED by api.twilio.com - the classic
//      "Authenticate" error - so the home Region must match where it lives.
//   2. Each number's inbound processing Region is set PER NUMBER, via the
//      Routes API, from the home Region.
//   3. A call or text is processed - and its records stored - in the Region
//      that number is routed to. Query the wrong Region's API and the records
//      simply are not there. So every log/recording/outbound call must target
//      the Region of the number it concerns.
//
// https://www.twilio.com/docs/global-infrastructure/understanding-twilio-regions
import { createHmac, timingSafeEqual } from 'crypto'

export const TWILIO_REGIONS = ['us1', 'ie1', 'au1'] as const
export type TwilioRegion = (typeof TWILIO_REGIONS)[number]

export const TWILIO_REGION_LABELS: Record<TwilioRegion, string> = {
  us1: 'United States',
  ie1: 'Ireland',
  au1: 'Australia',
}

export function isTwilioRegion(value: string): value is TwilioRegion {
  return (TWILIO_REGIONS as readonly string[]).includes(value)
}

// The account's home Region - its control plane. Twilio provisions every
// account in one Region for data residency: a US account is us1 (the default),
// an account created for Ireland is ie1, and so on. Number listing, the Routes
// API and the connection test all run against the home Region, and its
// credentials are the main Account SID + Auth token.
//
// Crucially, an account homed outside us1 has its credentials REJECTED by
// api.twilio.com (us1) - the classic "Authenticate" failure - so this must
// match where the account actually lives. Set per install via
// TWILIO_HOME_REGION; defaults to us1.
export function getHomeRegion(): TwilioRegion {
  const value = process.env.TWILIO_HOME_REGION
  return value && isTwilioRegion(value) ? value : 'us1'
}

// Twilio FQDNs are {product}.{edge}.{region}.twilio.com. The bare
// {product}.{region}.twilio.com form was switched off on 28 April 2026, so the
// edge is not optional for a non-US Region - omitting it silently routes the
// request back to us1, which is exactly the bug this module exists to avoid.
// https://www.twilio.com/docs/global-infrastructure/using-the-twilio-rest-api-in-a-non-us-region
const REGION_EDGE: Record<Exclude<TwilioRegion, 'us1'>, string> = {
  ie1: 'dublin',
  au1: 'sydney',
}

function regionHost(product: 'api' | 'routes', region: TwilioRegion): string {
  return region === 'us1'
    ? `${product}.twilio.com`
    : `${product}.${REGION_EDGE[region]}.${region}.twilio.com`
}

// "Any given Auth token or API key is only valid for the Twilio Region in which
// it was created" - so a Region the site talks to needs its own token, found in
// the Twilio console under API keys & tokens with that Region selected. The
// Account SID is the same across Regions.
// https://www.twilio.com/docs/global-infrastructure/manage-regional-api-credentials
//
// The home Region's token is the main TWILIO_AUTH_TOKEN. Any OTHER Region the
// account also routes numbers to gets its own TWILIO_AUTH_TOKEN_<REGION>, e.g.
// TWILIO_AUTH_TOKEN_IE1. Because the mapping keys off the home Region, a us1
// home yields the historical layout (main = us1, extras = ie1/au1) unchanged.
export function regionTokenEnvVar(region: TwilioRegion): string {
  return region === getHomeRegion()
    ? 'TWILIO_AUTH_TOKEN'
    : `TWILIO_AUTH_TOKEN_${region.toUpperCase()}`
}

// Thrown when a number is routed to a Region the site has no token for. Its
// message is shown to admins verbatim, so it names the fix.
export class MissingRegionTokenError extends Error {
  constructor(public readonly region: TwilioRegion) {
    super(
      `No Twilio auth token for the ${TWILIO_REGION_LABELS[region]} region. ` +
      `Add ${regionTokenEnvVar(region)} on the Twilio settings tab - it is a different ` +
      `token from your main one, found in the Twilio console with ${region.toUpperCase()} selected.`
    )
    this.name = 'MissingRegionTokenError'
  }
}

// A failed Twilio REST response, carrying the detail that turns a bare
// "Authenticate" into something diagnosable: which Region and host were hit,
// the HTTP status, and Twilio's own numeric error code. The `message` is shown
// to admins verbatim on the settings tab.
export class TwilioApiError extends Error {
  constructor(
    public readonly region: TwilioRegion,
    public readonly host: string,
    public readonly httpStatus: number,
    public readonly twilioCode: number | null,
    message: string
  ) {
    super(message)
    this.name = 'TwilioApiError'
  }
}

// Builds a TwilioApiError from a non-OK response, reading Twilio's JSON error
// body ({ code, message, more_info }) when present. Twilio code 20003 is an
// authentication failure - by far the most common regional-credential mistake -
// so it gets a plain-English hint naming the likely cause instead of the bare
// word "Authenticate".
async function twilioError(res: Response, region: TwilioRegion, host: string): Promise<TwilioApiError> {
  const body = (await res.json().catch(() => null)) as
    | { message?: string; code?: number; more_info?: string }
    | null
  const code = typeof body?.code === 'number' ? body.code : null
  const base = body?.message ?? `Twilio API error ${res.status}`
  const label = TWILIO_REGION_LABELS[region]
  const context = `[${label} region - ${host}, HTTP ${res.status}${code ? `, Twilio ${code}` : ''}]`
  const hint =
    code === 20003
      ? ` The ${label} endpoint rejected these credentials. Check the Account SID and the ` +
        `${region.toUpperCase()} auth token, and that ${label} is the region your Twilio ` +
        `account is homed in (set on the Twilio settings tab).`
      : code === 20404
        ? ` Twilio could not find that resource - if this happened on the connection test, ` +
          `the Account SID is probably wrong (it must start with AC, not SK).`
        : ''
  return new TwilioApiError(region, host, res.status, code, `${base} ${context}${hint}`)
}

export function getTwilioConfig(): { accountSid: string; authToken: string } | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !authToken) return null
  return { accountSid, authToken }
}

export function isTwilioConfigured(): boolean {
  return getTwilioConfig() !== null
}

export function isRegionConfigured(region: TwilioRegion): boolean {
  return !!process.env.TWILIO_ACCOUNT_SID && !!process.env[regionTokenEnvVar(region)]
}

// Regions this site currently holds a token for. The home Region is always
// first when set.
export function getConfiguredRegions(): TwilioRegion[] {
  const home = getHomeRegion()
  return TWILIO_REGIONS
    .filter(isRegionConfigured)
    .sort((a, b) => (a === home ? -1 : b === home ? 1 : 0))
}

// The one Account SID: AC + 32 hex. The classic paste-mistake is an API key
// SID (SK + 32 hex) - Twilio then 404s /Accounts/SK….json with error 20404,
// which reads like gibberish. Catch it here and say what actually happened.
const ACCOUNT_SID_RE = /^AC[0-9a-fA-F]{32}$/

export function accountSidProblem(accountSid: string): string | null {
  if (ACCOUNT_SID_RE.test(accountSid)) return null
  if (/^SK/i.test(accountSid)) {
    return (
      'The Account SID is set to an API key SID (starts with SK). This module cannot use ' +
      'API keys - it needs the Account SID (starts with AC) plus the auth token for each ' +
      'region, because Twilio signs webhooks with the auth token. Both are on the ' +
      '"API keys & tokens" page of the Twilio console: the Account SID at the top, and the ' +
      'Primary auth token per region under Auth tokens.'
    )
  }
  return 'The Account SID does not look right - it should start with AC followed by 32 characters.'
}

function regionCredentials(region: TwilioRegion): { accountSid: string; authToken: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  if (!accountSid) throw new Error('Twilio is not configured')
  const sidProblem = accountSidProblem(accountSid)
  if (sidProblem) throw new Error(sidProblem)
  const authToken = process.env[regionTokenEnvVar(region)]
  if (!authToken) throw new MissingRegionTokenError(region)
  return { accountSid, authToken }
}

function authHeader(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`
}

// The classic 2010-04-01 account API, in one Region.
async function twilioFetch(
  path: string,
  init?: { method?: string; form?: Record<string, string>; region?: TwilioRegion }
): Promise<unknown> {
  const region = init?.region ?? getHomeRegion()
  const { accountSid, authToken } = regionCredentials(region)
  const host = regionHost('api', region)

  const headers: Record<string, string> = { Authorization: authHeader(accountSid, authToken) }
  let body: string | undefined
  if (init?.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(init.form).toString()
  }

  const res = await fetch(
    `https://${host}/2010-04-01/Accounts/${accountSid}${path}`,
    { method: init?.method ?? 'GET', headers, body, signal: AbortSignal.timeout(15_000) }
  )

  if (!res.ok) throw await twilioError(res, region, host)
  return res.json()
}

// Connection test - fetches the account's friendly name from one Region. Also
// doubles as the per-Region credential check, since a token only authenticates
// against the Region it was made in.
export async function fetchAccountName(region: TwilioRegion = getHomeRegion()): Promise<string> {
  const data = await twilioFetch('.json', { region }) as { friendly_name?: string }
  return data.friendly_name ?? 'Twilio account'
}

// ---------------------------------------------------------------------------
// Inbound Processing Region (Routes API) - the per-number Region control.
//
// v3 is reached with the home Region's credentials and host, and covers both
// voice and messaging no matter which Region a number is routed to.
// https://www.twilio.com/docs/global-infrastructure/inbound-processing-api
// ---------------------------------------------------------------------------

type RoutesResponse = {
  phone_number?: string
  voice_region?: string
  messaging_region?: string
}

async function routesFetch(
  phoneNumber: string,
  init?: { method?: string; form?: Record<string, string> }
): Promise<RoutesResponse> {
  const home = getHomeRegion()
  const { accountSid, authToken } = regionCredentials(home)
  const host = regionHost('routes', home)

  const headers: Record<string, string> = { Authorization: authHeader(accountSid, authToken) }
  let body: string | undefined
  if (init?.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(init.form).toString()
  }

  const res = await fetch(
    `https://${host}/v3/PhoneNumbers/${encodeURIComponent(phoneNumber)}`,
    { method: init?.method ?? 'GET', headers, body, signal: AbortSignal.timeout(15_000) }
  )

  if (!res.ok) throw await twilioError(res, home, host)
  return res.json() as Promise<RoutesResponse>
}

// A number's inbound processing Region. Twilio reports voice and messaging
// separately; this module keeps them together (one Region per number), so the
// voice Region is the answer and an unset/unknown value means the home default.
export async function getNumberRegion(phoneNumber: string): Promise<TwilioRegion> {
  const data = await routesFetch(phoneNumber)
  const region = data.voice_region ?? ''
  return isTwilioRegion(region) ? region : getHomeRegion()
}

// Routes both voice and messaging for a number to one Region. Twilio takes up
// to five minutes to apply a routing change.
export async function setNumberRegion(phoneNumber: string, region: TwilioRegion): Promise<void> {
  await routesFetch(phoneNumber, {
    method: 'POST',
    form: { voiceRegion: region, messagingRegion: region },
  })
}

// ---------------------------------------------------------------------------
// Account resources
// ---------------------------------------------------------------------------

// `from` must be an SMS-capable Twilio number on the account - callers go
// through lib/numbers.ts sendSiteSms, which resolves the site's default and its
// Region. The Region decides where the message is processed and stored.
export async function sendSms(
  to: string,
  body: string,
  from: string,
  region: TwilioRegion = getHomeRegion()
): Promise<void> {
  await twilioFetch('/Messages.json', {
    method: 'POST',
    form: { To: to, From: from, Body: body },
    region,
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

// The account's numbers are a single global pool administered from the home
// Region, so this listing runs there and is not per-number Region-dependent.
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

export type CallLogEntry = {
  sid: string
  from: string
  to: string
  direction: 'inbound' | 'outbound'
  status: string
  startTime: string
  durationSeconds: number
  recordingSids: string[]
}

// Calls to and from a number, newest first. Two filtered listings merged - the
// Calls resource only filters on one of To/From per request. Recordings are
// attached from a single Region-wide listing keyed by call SID.
//
// `region` must be the number's own routing Region: its calls were processed
// there and exist nowhere else.
export async function listCallsForNumber(
  phoneNumber: string,
  region: TwilioRegion = getHomeRegion(),
  limit = 50
): Promise<CallLogEntry[]> {
  type RawCall = {
    sid: string
    from: string
    to: string
    direction: string
    status: string
    start_time: string | null
    date_created: string | null
    duration: string | null
  }
  const [toData, fromData, recData] = await Promise.all([
    twilioFetch(`/Calls.json?PageSize=${limit}&To=${encodeURIComponent(phoneNumber)}`, { region }),
    twilioFetch(`/Calls.json?PageSize=${limit}&From=${encodeURIComponent(phoneNumber)}`, { region }),
    twilioFetch('/Recordings.json?PageSize=200', { region }),
  ]) as [{ calls?: RawCall[] }, { calls?: RawCall[] }, { recordings?: Array<{ sid: string; call_sid: string; status: string }> }]

  const recordingsByCall = new Map<string, string[]>()
  for (const r of recData.recordings ?? []) {
    if (r.status !== 'completed') continue
    const list = recordingsByCall.get(r.call_sid) ?? []
    list.push(r.sid)
    recordingsByCall.set(r.call_sid, list)
  }

  const bySid = new Map<string, RawCall>()
  for (const c of [...(toData.calls ?? []), ...(fromData.calls ?? [])]) bySid.set(c.sid, c)

  return [...bySid.values()]
    .map((c) => ({
      sid: c.sid,
      from: c.from,
      to: c.to,
      direction: c.direction.startsWith('outbound') ? 'outbound' as const : 'inbound' as const,
      status: c.status,
      startTime: c.start_time ?? c.date_created ?? '',
      durationSeconds: c.duration ? parseInt(c.duration, 10) || 0 : 0,
      recordingSids: recordingsByCall.get(c.sid) ?? [],
    }))
    .sort((a, b) => Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'))
    .slice(0, limit)
}

export type MessageLogEntry = {
  sid: string
  from: string
  to: string
  direction: 'inbound' | 'outbound'
  status: string
  dateSent: string
  body: string
}

// Texts to and from a number, newest first. Same merge-two-listings shape as
// listCallsForNumber, and the same Region rule.
export async function listMessagesForNumber(
  phoneNumber: string,
  region: TwilioRegion = getHomeRegion(),
  limit = 50
): Promise<MessageLogEntry[]> {
  type RawMessage = {
    sid: string
    from: string
    to: string
    direction: string
    status: string
    date_sent: string | null
    date_created: string | null
    body: string
  }
  const [toData, fromData] = await Promise.all([
    twilioFetch(`/Messages.json?PageSize=${limit}&To=${encodeURIComponent(phoneNumber)}`, { region }),
    twilioFetch(`/Messages.json?PageSize=${limit}&From=${encodeURIComponent(phoneNumber)}`, { region }),
  ]) as [{ messages?: RawMessage[] }, { messages?: RawMessage[] }]

  const bySid = new Map<string, RawMessage>()
  for (const m of [...(toData.messages ?? []), ...(fromData.messages ?? [])]) bySid.set(m.sid, m)

  return [...bySid.values()]
    .map((m) => ({
      sid: m.sid,
      from: m.from,
      to: m.to,
      direction: m.direction === 'inbound' ? 'inbound' as const : 'outbound' as const,
      status: m.status,
      dateSent: m.date_sent ?? m.date_created ?? '',
      body: m.body,
    }))
    .sort((a, b) => Date.parse(b.dateSent || '0') - Date.parse(a.dateSent || '0'))
    .slice(0, limit)
}

// Streams a recording's MP3 with the Region's basic-auth credentials so the
// browser never sees them. A recording lives in the Region its call was
// processed in, so `region` must be that number's Region.
export async function fetchRecordingAudio(
  recordingSid: string,
  region: TwilioRegion = getHomeRegion()
): Promise<Response> {
  const { accountSid, authToken } = regionCredentials(region)
  return fetch(
    `https://${regionHost('api', region)}/2010-04-01/Accounts/${accountSid}/Recordings/${encodeURIComponent(recordingSid)}.mp3`,
    {
      headers: { Authorization: authHeader(accountSid, authToken) },
      signal: AbortSignal.timeout(30_000),
    }
  )
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

// Places an outbound call that plays the given TwiML - used for click-to-dial
// and to preview the forwarding greeting. `from` must be a Twilio number on the
// account, and `region` its Region, so the call is processed and logged there.
export async function placeCall(
  to: string,
  from: string,
  twiml: string,
  region: TwilioRegion = getHomeRegion()
): Promise<void> {
  await twilioFetch('/Calls.json', {
    method: 'POST',
    form: { To: to, From: from, Twiml: twiml },
    region,
  })
}

// Points the number's voice webhook at `url`, or clears it when url is empty.
// IncomingPhoneNumbers is account-level, so this runs in the home Region
// whatever the number's routing.
export async function setNumberVoiceUrl(sid: string, url: string): Promise<void> {
  await twilioFetch(`/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
    method: 'POST',
    form: { VoiceUrl: url, VoiceMethod: 'POST' },
  })
}

// Validates Twilio's X-Twilio-Signature header: HMAC-SHA1 over the full webhook
// URL plus the POST params concatenated in key-sorted order, base64-encoded.
// https://www.twilio.com/docs/usage/security#validating-requests
//
// A webhook is signed with the auth token of the Region that processed the
// call, so a number routed to ie1 arrives signed with the ie1 token. Every
// configured Region's token is tried: each one is ours, so a match against any
// of them proves the request came from our Twilio account, which is the whole
// point of the check.
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  const regions = getConfiguredRegions()
  if (regions.length === 0) return false

  let data = url
  for (const key of Object.keys(params).sort()) {
    data += key + params[key]
  }

  const provided = Buffer.from(signature)
  let matched = false
  for (const region of regions) {
    const token = process.env[regionTokenEnvVar(region)]
    if (!token) continue
    const expected = Buffer.from(createHmac('sha1', token).update(data, 'utf8').digest('base64'))
    // No early exit: every candidate is compared so the work does not vary
    // with which Region happened to sign the request.
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      matched = true
    }
  }
  return matched
}
