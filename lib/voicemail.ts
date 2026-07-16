// Shared voicemail TwiML, and the pure decision logic behind the voicemail
// webhook. Used both when a call goes to voicemail without ringing (forwarding
// off, or outside opening hours) and when the forwarded number failed to pick up.
import { getSiteUrl } from '@/lib/config/env'
import { escapeXml } from './twilio'
import type { ForwardingRule } from './forwarding'

// How long a caller may talk before Twilio stops the recording. Not
// configurable: two minutes is a message, anything longer is a monologue.
export const MAX_VOICEMAIL_SECONDS = 120

// Shortest recording treated as a message. Twilio saves silent recordings by
// default, so a caller who hears the greeting and rings off at the beep still
// produces one; trim-silence takes it down to a second or less rather than to
// nothing. Below this it is a hang-up, and neither the call log's Voicemail
// badge nor the admin's notification should claim otherwise. Being wrong here
// is cheap in one direction only: an unlogged recording still sits in the call
// log with its Listen button, it simply is not announced as a message.
export const MIN_VOICEMAIL_SECONDS = 2

// Said when the admin switched voicemail on but left the greeting empty.
const FALLBACK_GREETING = 'Sorry, nobody is available to take your call. Please leave a message after the beep.'

// Which greeting a call gets. A call arriving outside opening hours is a
// different situation to one that rang out - the caller wants to know when the
// place opens, not that everyone is busy - so it can be answered with its own
// words. An empty closed greeting means the admin had nothing extra to say, and
// the usual voicemail greeting covers it.
export function voicemailGreetingFor(
  rule: Pick<ForwardingRule, 'voicemailGreeting' | 'closedVoicemailGreeting'>,
  closed: boolean
): string {
  const closedGreeting = rule.closedVoicemailGreeting.trim()
  if (closed && closedGreeting) return closedGreeting
  return rule.voicemailGreeting.trim() || FALLBACK_GREETING
}

// Marks the <Record> action request. Twilio requests the voicemail webhook at
// two different points in a call and the recording parameters CANNOT tell them
// apart: a <Dial> carrying record="..." also sends RecordingUrl to its own
// action URL, and that recording is a forwarded conversation somebody answered,
// not a message anybody left. So the stage is stated on the URL rather than
// inferred from the payload.
export const RECORDING_STAGE = 'recording'

// Dial outcomes that mean the caller never got through to a person. 'completed'
// and 'answered' are a real conversation; 'canceled' is the caller ringing off
// before anyone could pick up, so there is nobody left to leave a message.
const NO_ANSWER_STATUSES = new Set(['no-answer', 'busy', 'failed'])

export function voicemailUrl(): string {
  return `${getSiteUrl()}/api/m/twilio/webhooks/voicemail`
}

// The <Record> action URL: the voicemail webhook, told which stage it is.
export function voicemailRecordingUrl(): string {
  return `${voicemailUrl()}?stage=${RECORDING_STAGE}`
}

// The recording SID out of a RecordingUrl, which ends in it.
export function recordingSidFromUrl(url: string): string {
  const last = url.split('?')[0]!.split('/').pop() ?? ''
  return /^RE[0-9a-f]{32}$/i.test(last) ? last : ''
}

export type VoicemailRequest = {
  /** The `stage` query parameter of the request URL, if any. */
  stage: string | null
  dialCallStatus?: string
  recordingSid?: string
  recordingUrl?: string
  recordingDuration?: string
}

export type VoicemailPlan =
  /** A message worth keeping: log it against the call, then hang up. */
  | { action: 'log-message'; recordingSid: string; durationSeconds: number }
  /** Nobody got through: play the greeting and record a message. */
  | { action: 'take-message' }
  /** Nothing to do. Hanging up is never wrong here, only sometimes wasteful. */
  | { action: 'hangup' }

// What the voicemail webhook should do with a request. Pure, so the awkward
// parts - which stage is this, and is this recording actually a message - are
// decided somewhere they can be tested without a phone call.
export function planVoicemailRequest(req: VoicemailRequest): VoicemailPlan {
  // The <Record> finished. Identified by the marker this module puts on the
  // URL, never by the recording parameters: see RECORDING_STAGE.
  if (req.stage === RECORDING_STAGE) {
    const recordingSid = req.recordingSid || recordingSidFromUrl(req.recordingUrl ?? '')
    const durationSeconds = parseInt(req.recordingDuration ?? '', 10) || 0
    if (!recordingSid || durationSeconds < MIN_VOICEMAIL_SECONDS) return { action: 'hangup' }
    return { action: 'log-message', recordingSid, durationSeconds }
  }

  // The <Dial> finished. Every dial action request carries DialCallStatus, so
  // this branch cannot be reached by a recording request that arrived without
  // the stage marker - one in flight across a deploy, say. Those hang up, which
  // is the safe way to be wrong: the <Record> action exists to stop the
  // recording re-requesting its own URL and looping.
  if (NO_ANSWER_STATUSES.has(req.dialCallStatus ?? '')) return { action: 'take-message' }

  return { action: 'hangup' }
}

// The <Say> + <Record> pair. Voice ids are validated against the curated list
// on save and only ever contain [A-Za-z.-], so they need no escaping; the
// greeting is caller-visible free text and does. `closed` says whether the call
// arrived outside the number's opening hours, which only changes the words: the
// voice and the recording behaviour are the same either way.
export function voicemailTwiml(
  rule: Pick<ForwardingRule, 'voicemailGreeting' | 'closedVoicemailGreeting' | 'voicemailVoice'>,
  closed = false
): string {
  const voiceAttr = rule.voicemailVoice ? ` voice="${rule.voicemailVoice}"` : ''
  const say = `<Say${voiceAttr}>${escapeXml(voicemailGreetingFor(rule, closed))}</Say>`
  // An explicit action is important: left to itself <Record> re-requests the
  // current document's URL when the recording ends, which would read as a fresh
  // call and loop. The action lands back on the voicemail route, which sees the
  // recording stage and hangs up.
  const record =
    `<Record maxLength="${MAX_VOICEMAIL_SECONDS}" playBeep="true" trim="trim-silence" ` +
    `action="${escapeXml(voicemailRecordingUrl())}" method="POST"/>`
  return `${say}${record}<Hangup/>`
}
