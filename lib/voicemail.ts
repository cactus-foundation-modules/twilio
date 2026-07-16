// Shared voicemail TwiML. Used both when a call goes to voicemail without
// ringing (forwarding off, or outside opening hours) and when the forwarded
// number failed to pick up.
import { getSiteUrl } from '@/lib/config/env'
import { escapeXml } from './twilio'
import type { ForwardingRule } from './forwarding'

// How long a caller may talk before Twilio stops the recording. Not
// configurable: two minutes is a message, anything longer is a monologue.
export const MAX_VOICEMAIL_SECONDS = 120

// Said when the admin switched voicemail on but left the greeting empty.
const FALLBACK_GREETING = 'Sorry, nobody is available to take your call. Please leave a message after the beep.'

export function voicemailUrl(): string {
  return `${getSiteUrl()}/api/m/twilio/webhooks/voicemail`
}

// The <Say> + <Record> pair. Voice ids are validated against the curated list
// on save and only ever contain [A-Za-z.-], so they need no escaping; the
// greeting is caller-visible free text and does.
export function voicemailTwiml(rule: Pick<ForwardingRule, 'voicemailGreeting' | 'voicemailVoice'>): string {
  const voiceAttr = rule.voicemailVoice ? ` voice="${rule.voicemailVoice}"` : ''
  const message = rule.voicemailGreeting.trim() || FALLBACK_GREETING
  const say = `<Say${voiceAttr}>${escapeXml(message)}</Say>`
  // An explicit action is important: left to itself <Record> re-requests the
  // current document's URL when the recording ends, which would read as a fresh
  // call and loop. The action lands back on the voicemail route, which sees the
  // recording params and hangs up.
  const record =
    `<Record maxLength="${MAX_VOICEMAIL_SECONDS}" playBeep="true" trim="trim-silence" ` +
    `action="${escapeXml(voicemailUrl())}" method="POST"/>`
  return `${say}${record}<Hangup/>`
}
