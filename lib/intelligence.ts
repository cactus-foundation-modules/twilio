// Twilio Voice Intelligence: putting words to a recorded conversation.
//
// A voicemail is transcribed by Twilio as part of the <Record> that captured
// it. A two-party call cannot be - <Dial> has no transcribe attribute - and the
// only supported way to read one back is Voice Intelligence, which works from
// the finished recording, charges by the minute, and answers minutes later
// through a callback of its own.
//
// Three things about it that are not obvious from the outside:
//
//   It lives on its own host, intelligence.twilio.com, NOT the 2010-04-01
//   account API - so twilioFetch cannot be reused, and the Region rule still
//   applies. A recording made on a number routed through Dublin has to be
//   transcribed on the Dublin edge; asking the US endpoint about it gets a
//   flat "not found" and no hint as to why.
//
//   It needs a SERVICE before it will take a job. Rather than sending an owner
//   into the Twilio console, the module makes one for the site the first time
//   it needs it and remembers the SID, with the callback URL set at creation.
//
//   The callback carries no words at all - only the id of the finished job. The
//   sentences are then read back over this API, which is what makes the callback
//   safe to receive: it is a nudge, and everything acted on is fetched from
//   Twilio with the site's own credentials.
import { getSiteUrl } from '@/lib/config/env'
import {
  authHeader,
  getHomeRegion,
  intelligenceHost,
  regionCredentials,
  type TwilioRegion,
} from './twilio'
import { getTwilioSettings, setIntelligenceServiceSid } from './settings'

/** Voice Intelligence's own ids. Checked before either goes into a URL. */
export const SERVICE_SID = /^GA[0-9a-f]{32}$/i
export const TRANSCRIPT_SID = /^GT[0-9a-f]{32}$/i

/** The name the site's Service is created under. Twilio requires it to be
 *  unique within the account, and it is what an owner will see if they ever go
 *  looking in the console. */
const SERVICE_UNIQUE_NAME = 'cactus-call-transcripts'

/** Sentences come back paged. A call long enough to run past this is long
 *  enough that the first few hundred sentences are the gist of it. */
const SENTENCE_PAGE_SIZE = 1000

export function intelligenceWebhookUrl(): string {
  return `${getSiteUrl()}/api/m/twilio/webhooks/intelligence`
}

async function intelligenceFetch(
  path: string,
  init: { method?: string; form?: Record<string, string>; region: TwilioRegion }
): Promise<unknown> {
  const { accountSid, authToken } = regionCredentials(init.region)
  const headers: Record<string, string> = { Authorization: authHeader(accountSid, authToken) }
  let body: string | undefined
  if (init.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(init.form).toString()
  }
  const res = await fetch(`https://${intelligenceHost(init.region)}/v2${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
    // Longer than the 15s the account API gets: creating a transcript is a job
    // being accepted, not a row being read.
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Voice Intelligence answered ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  if (res.status === 204) return null
  return res.json()
}

// The Service this site transcribes through, made if it is not there yet.
//
// Remembered in settings rather than looked up each time: this is one row read
// on a webhook that is already racing a Twilio timeout, and a Service is not
// something that changes. A stored SID that Twilio no longer recognises shows
// up as a failure on the transcript request, which is the honest place for it -
// silently making a second Service would leave the site paying for two.
export async function ensureIntelligenceService(region: TwilioRegion): Promise<string> {
  const settings = await getTwilioSettings()
  if (SERVICE_SID.test(settings.intelligenceServiceSid)) return settings.intelligenceServiceSid

  const data = (await intelligenceFetch('/Services', {
    method: 'POST',
    region,
    form: {
      UniqueName: SERVICE_UNIQUE_NAME,
      // Set at creation so there is never a window in which transcripts finish
      // with nowhere to report to.
      WebhookUrl: intelligenceWebhookUrl(),
      // Deliberately false. Twilio would otherwise transcribe EVERY recording
      // on the account the moment this Service exists, including the ones on
      // numbers whose owner never asked for it - and bill for all of them.
      AutoTranscribe: 'false',
    },
  })) as { sid?: string }

  const sid = data.sid ?? ''
  if (!SERVICE_SID.test(sid)) throw new Error('Twilio did not return a Voice Intelligence service')
  await setIntelligenceServiceSid(sid)
  return sid
}

/** Asks for a recording to be typed up. Returns Voice Intelligence's id for the
 *  job; the words themselves arrive later, through the webhook. */
export async function requestTranscript(
  recordingSid: string,
  region: TwilioRegion
): Promise<string> {
  const serviceSid = await ensureIntelligenceService(region)
  const data = (await intelligenceFetch('/Transcripts', {
    method: 'POST',
    region,
    form: {
      ServiceSid: serviceSid,
      // Sent as a JSON string in a form field - the shape the API asks for, odd
      // as it looks beside the other parameters.
      Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }),
    },
  })) as { sid?: string }
  const sid = data.sid ?? ''
  if (!TRANSCRIPT_SID.test(sid)) throw new Error('Twilio did not return a transcript id')
  return sid
}

type Transcript = { sid?: string; status?: string; service_sid?: string }
type Sentence = { transcript?: string; sentence_index?: number }

/** One finished transcript as plain text, and whether Twilio actually finished
 *  it. The Service is checked against the site's own: the webhook that prompts
 *  this read is unauthenticated, so the only thing that makes it safe is that
 *  everything acted on came back from Twilio under our credentials AND belongs
 *  to the Service we created. */
export async function fetchTranscriptText(
  transcriptSid: string,
  region: TwilioRegion
): Promise<{ status: 'completed' | 'failed'; text: string }> {
  const settings = await getTwilioSettings()
  const transcript = (await intelligenceFetch(`/Transcripts/${transcriptSid}`, {
    region,
  })) as Transcript

  if (transcript.service_sid !== settings.intelligenceServiceSid) {
    throw new Error('That transcript belongs to another Voice Intelligence service')
  }
  if (transcript.status !== 'completed') return { status: 'failed', text: '' }

  const data = (await intelligenceFetch(
    `/Transcripts/${transcriptSid}/Sentences?PageSize=${SENTENCE_PAGE_SIZE}`,
    { region }
  )) as { sentences?: Sentence[] }

  // Sorted rather than trusted to arrive in order, and joined with spaces: this
  // is read as a paragraph beside a text message, not as a call centre report.
  const text = (data.sentences ?? [])
    .slice()
    .sort((a, b) => (a.sentence_index ?? 0) - (b.sentence_index ?? 0))
    .map((s) => (s.transcript ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()

  return { status: 'completed', text }
}

/** The Region a Voice Intelligence request for a given site number belongs in -
 *  the same Region its recording was made in. Falls back to the account's home
 *  Region when the number is not one we can place, which is the same fallback
 *  the recording proxy makes. */
export function intelligenceRegionFallback(): TwilioRegion {
  return getHomeRegion()
}
