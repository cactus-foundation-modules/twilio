// Shared voicemail TwiML, and the pure decision logic behind the voicemail
// webhook. Used both when a call goes to voicemail without ringing (forwarding
// off, or outside opening hours) and when the forwarded number failed to pick up.
import { getSiteUrl } from '@/lib/config/env'
import { escapeXml } from './twilio'
import { greetingAudioUrl } from './greeting-audio'
import { MAX_FORWARD_ATTEMPTS, MIN_FORWARD_ATTEMPTS } from './business-hours'
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

/** Which forwarding number a dial was for: the main one, or the "also try" one. */
export type DialLeg = 1 | 2

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

// Marks the second forwarding leg's <Dial> action. Same trick as the recording
// stage: the dial action payloads for leg one and leg two are indistinguishable,
// so the leg is stated on the URL rather than guessed from the params.
export const SECOND_LEG = '2'

// Which forwarding number is being rung, and how many times it has now been
// tried. Both live on the action URL for the same reason the stage does: every
// dial action request looks identical in its payload, so a number rung three
// times in a row would otherwise restart the count on each reply and never
// reach voicemail. Twilio signs the URL it is given, so these markers come back
// exactly as they went out.
//
// Attempt 1 of leg 1 carries no parameters at all, which keeps the URL a call
// already in flight across a deploy would have been given.
export function dialActionUrl(leg: DialLeg, attempt: number): string {
  const params = new URLSearchParams()
  if (leg === 2) params.set('leg', SECOND_LEG)
  if (attempt > 1) params.set('attempt', String(attempt))
  const query = params.toString()
  return query ? `${voicemailUrl()}?${query}` : voicemailUrl()
}

// Where Twilio posts a voicemail's transcription once it is ready - minutes
// after the recording, in a request of its own.
export function transcriptionUrl(): string {
  return `${getSiteUrl()}/api/m/twilio/webhooks/transcription`
}

// Where Twilio reports that a forwarded call's recording is ready, so it can be
// sent off to be typed up. The site number rides on the URL because the payload
// names the two ends of the DIALLED leg, and on a forwarded call neither of
// them is necessarily ours - without it the callback cannot tell which number's
// settings it is acting under, or which Twilio Region to look in.
export function recordingStatusUrl(siteNumber: string): string {
  const url = new URL(`${getSiteUrl()}/api/m/twilio/webhooks/recording`)
  url.searchParams.set('number', siteNumber)
  return url.toString()
}

/** The <Dial> attributes that get a recorded call typed up, and nothing at all
 *  for a number that has not asked for it - Voice Intelligence bills by the
 *  minute, so this is the one place that must stay closed by default.
 *
 *  `recordingStatusCallbackEvent="completed"` matters: left to itself Twilio
 *  also reports the recording starting, and a callback with nothing to
 *  transcribe is a request the site pays to answer. */
export function transcriptionDialAttrs(
  rule: Pick<ForwardingRule, 'recordCalls' | 'transcribeCalls'>,
  siteNumber: string
): string {
  if (!rule.recordCalls || !rule.transcribeCalls || !siteNumber) return ''
  return (
    ` recordingStatusCallback="${escapeXml(recordingStatusUrl(siteNumber))}"` +
    ' recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"'
  )
}

// The recording SID out of a RecordingUrl, which ends in it.
export function recordingSidFromUrl(url: string): string {
  const last = url.split('?')[0]!.split('/').pop() ?? ''
  return /^RE[0-9a-f]{32}$/i.test(last) ? last : ''
}

export type VoicemailRequest = {
  /** The `stage` query parameter of the request URL, if any. */
  stage: string | null
  /** The `leg` query parameter: SECOND_LEG on the second dial's action request. */
  leg?: string | null
  /** The `attempt` query parameter: which try of that leg this was. Absent = the first. */
  attempt?: string | null
  dialCallStatus?: string
  recordingSid?: string
  recordingUrl?: string
  recordingDuration?: string
}

export type VoicemailPlan =
  /** A message worth keeping: log it against the call, then hang up. */
  | { action: 'log-message'; recordingSid: string; durationSeconds: number }
  /** Unanswered, and there is another ring left to try: this number, again or
   *  for the first time. `leg` says which forwarding number, `attempt` which try. */
  | { action: 'dial'; leg: DialLeg; attempt: number }
  /**
   * Nobody got through on any leg - the call is definitively missed. The
   * route takes a message if voicemail is on, and this is also the one point
   * where missed-call notifications fire.
   */
  | { action: 'take-message' }
  /** Nothing to do. Hanging up is never wrong here, only sometimes wasteful. */
  | { action: 'hangup' }

// Attempts are only ever read back off a URL this module signed, so anything
// unreadable is a call from before the marker existed: the first try.
function parseAttempt(value: string | null | undefined): number {
  const n = parseInt(value ?? '', 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

// A stored count is an integer between MIN_FORWARD_ATTEMPTS and
// MAX_FORWARD_ATTEMPTS, but a rule row predating the column - or one edited by
// hand - must not be able to turn a phone call into an endless redial.
function clampAttempts(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_FORWARD_ATTEMPTS
  return Math.min(MAX_FORWARD_ATTEMPTS, Math.max(MIN_FORWARD_ATTEMPTS, Math.floor(value)))
}

// What the voicemail webhook should do with a request. Pure, so the awkward
// parts - which stage is this, is this recording actually a message, and is
// there another leg still to try - are decided somewhere they can be tested
// without a phone call. `hasSecondLeg` says whether the rule holds a usable
// second forward-to number, and `attemptsPerNumber` how many times each of them
// may be rung before the call moves on.
export function planVoicemailRequest(
  req: VoicemailRequest,
  ctx: { hasSecondLeg: boolean; attemptsPerNumber?: number } = { hasSecondLeg: false }
): VoicemailPlan {
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
  if (NO_ANSWER_STATUSES.has(req.dialCallStatus ?? '')) {
    const leg: DialLeg = req.leg === SECOND_LEG ? 2 : 1
    const attempt = parseAttempt(req.attempt)
    const attemptsPerNumber = clampAttempts(ctx.attemptsPerNumber)

    // Ring the same number again where the admin asked for more than one try.
    // This is what makes a short ring timeout usable: the timeout is there to
    // cut the call off before the handset's own voicemail answers it, and on
    // its own that leaves one brief chance to pick up.
    if (attempt < attemptsPerNumber) return { action: 'dial', leg, attempt: attempt + 1 }

    // Out of tries on this number. A second forward-to number gets its turn
    // before voicemail does - unless this request IS the second leg reporting
    // back, in which case there is nothing left to ring.
    if (leg === 1 && ctx.hasSecondLeg) return { action: 'dial', leg: 2, attempt: 1 }
    return { action: 'take-message' }
  }

  return { action: 'hangup' }
}

// The greeting element ahead of the <Record>: an uploaded audio file plays
// (<Play>), otherwise the text is said (<Say>). A `closed` call prefers the
// closed-hours pair, falling back to the usual one exactly as the words always
// have: closed audio, then closed words, then the everyday audio, then the
// everyday words (or the stock line).
export function voicemailGreetingTwiml(
  rule: Pick<
    ForwardingRule,
    'voicemailGreeting' | 'closedVoicemailGreeting' | 'voicemailVoice' |
    'voicemailAudioMediaId' | 'closedVoicemailAudioMediaId'
  >,
  closed = false
): string {
  const audioId =
    closed && rule.closedVoicemailAudioMediaId
      ? rule.closedVoicemailAudioMediaId
      : // A closed call with closed WORDS set keeps saying them - the admin
        // wrote something specifically for out-of-hours callers, and the
        // everyday audio file is not that.
        closed && rule.closedVoicemailGreeting.trim()
        ? ''
        : rule.voicemailAudioMediaId
  if (audioId) return `<Play>${escapeXml(greetingAudioUrl(audioId))}</Play>`
  const voiceAttr = rule.voicemailVoice ? ` voice="${rule.voicemailVoice}"` : ''
  return `<Say${voiceAttr}>${escapeXml(voicemailGreetingFor(rule, closed))}</Say>`
}

// The greeting + <Record> pair. Voice ids are validated against the curated
// list on save and only ever contain [A-Za-z.-], so they need no escaping; the
// greeting is caller-visible free text and does. `closed` says whether the call
// arrived outside the number's opening hours, which only changes the words: the
// voice and the recording behaviour are the same either way.
export function voicemailTwiml(
  rule: Pick<
    ForwardingRule,
    'voicemailGreeting' | 'closedVoicemailGreeting' | 'voicemailVoice' |
    'voicemailAudioMediaId' | 'closedVoicemailAudioMediaId' | 'transcribeVoicemail'
  >,
  closed = false
): string {
  const say = voicemailGreetingTwiml(rule, closed)
  // Transcription is per number: Twilio types the message up minutes later and
  // posts it to the transcription webhook, which files it on the voicemail row.
  // (Twilio only transcribes recordings between 2 and 120 seconds, which is
  // exactly the window MIN/MAX_VOICEMAIL_SECONDS already enforce.)
  const transcribeAttrs = rule.transcribeVoicemail
    ? ` transcribe="true" transcribeCallback="${escapeXml(transcriptionUrl())}"`
    : ''
  // An explicit action is important: left to itself <Record> re-requests the
  // current document's URL when the recording ends, which would read as a fresh
  // call and loop. The action lands back on the voicemail route, which sees the
  // recording stage and hangs up.
  const record =
    `<Record maxLength="${MAX_VOICEMAIL_SECONDS}" playBeep="true" trim="trim-silence"` +
    `${transcribeAttrs} ` +
    `action="${escapeXml(voicemailRecordingUrl())}" method="POST"/>`
  return `${say}${record}<Hangup/>`
}
