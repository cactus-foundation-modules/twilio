import { prisma } from '@/lib/db/prisma'
import { isOpenAt, parseBusinessHours, type BusinessHours } from './business-hours'

export type ForwardingRule = {
  id: string
  phoneSid: string
  phoneNumber: string
  forwardTo: string
  enabled: boolean
  greetingMessage: string
  greetingVoice: string
  recordCalls: boolean
  showCalledNumber: boolean
  voicemailEnabled: boolean
  /** Seconds the forward-to number rings before voicemail takes the call. */
  ringTimeout: number
  voicemailGreeting: string
  /** Said instead of voicemailGreeting outside opening hours. Empty = say the usual one. */
  closedVoicemailGreeting: string
  voicemailVoice: string
  /** Empty array means no schedule: the number is available at any hour. */
  businessHours: BusinessHours
  /**
   * Core media library ids of uploaded audio, played with <Play> instead of
   * the corresponding <Say> text/voice when set. Empty = no file.
   */
  greetingAudioMediaId: string
  voicemailAudioMediaId: string
  closedVoicemailAudioMediaId: string
}

function mapRow(r: Record<string, unknown>): ForwardingRule {
  return {
    id: r.id as string,
    phoneSid: r.phone_sid as string,
    phoneNumber: r.phone_number as string,
    forwardTo: r.forward_to as string,
    enabled: r.enabled as boolean,
    greetingMessage: r.greeting_message as string,
    greetingVoice: r.greeting_voice as string,
    recordCalls: r.record_calls as boolean,
    showCalledNumber: r.show_called_number as boolean,
    voicemailEnabled: r.voicemail_enabled as boolean,
    ringTimeout: Number(r.ring_timeout),
    voicemailGreeting: r.voicemail_greeting as string,
    closedVoicemailGreeting: r.closed_voicemail_greeting as string,
    voicemailVoice: r.voicemail_voice as string,
    // jsonb comes back already parsed. A row somehow holding a malformed
    // schedule reads as "no schedule" rather than throwing on an inbound call -
    // the number staying reachable is the safer way to be wrong.
    businessHours: parseBusinessHours(r.business_hours) ?? [],
    greetingAudioMediaId: r.greeting_audio_media_id as string,
    voicemailAudioMediaId: r.voicemail_audio_media_id as string,
    closedVoicemailAudioMediaId: r.closed_voicemail_audio_media_id as string,
  }
}

export async function getForwardingRules(): Promise<ForwardingRule[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, phone_sid, phone_number, forward_to, enabled,
           greeting_message, greeting_voice, record_calls, show_called_number,
           voicemail_enabled, ring_timeout, voicemail_greeting,
           closed_voicemail_greeting, voicemail_voice, business_hours,
           greeting_audio_media_id, voicemail_audio_media_id,
           closed_voicemail_audio_media_id
    FROM "tw_forwarding_rules"
  `
  return rows.map(mapRow)
}

// The rule for a number regardless of whether forwarding is switched on. A
// number can have forwarding off and voicemail on, and the voice webhook still
// needs the row in order to answer the call.
export async function getRuleForNumber(phoneNumber: string): Promise<ForwardingRule | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, phone_sid, phone_number, forward_to, enabled,
           greeting_message, greeting_voice, record_calls, show_called_number,
           voicemail_enabled, ring_timeout, voicemail_greeting,
           closed_voicemail_greeting, voicemail_voice, business_hours,
           greeting_audio_media_id, voicemail_audio_media_id,
           closed_voicemail_audio_media_id
    FROM "tw_forwarding_rules"
    WHERE phone_number = ${phoneNumber}
    LIMIT 1
  `
  const row = rows[0]
  return row ? mapRow(row) : null
}

// The site timezone, defaulting to UTC when there is no config row yet.
async function getSiteTimezone(): Promise<string> {
  const config = await prisma.siteConfig.findUnique({
    where: { id: 'singleton' },
    select: { timezone: true },
  })
  return config?.timezone || 'UTC'
}

// Is the number inside its opening hours right now? No schedule means always
// open, and that case skips the timezone lookup entirely.
export async function isRuleOpenNow(rule: ForwardingRule, at: Date = new Date()): Promise<boolean> {
  if (rule.businessHours.length === 0) return true
  return isOpenAt(rule.businessHours, await getSiteTimezone(), at)
}

export async function upsertForwardingRule(input: {
  phoneSid: string
  phoneNumber: string
  forwardTo: string
  enabled: boolean
  greetingMessage: string
  greetingVoice: string
  recordCalls: boolean
  showCalledNumber: boolean
  voicemailEnabled: boolean
  ringTimeout: number
  voicemailGreeting: string
  closedVoicemailGreeting: string
  voicemailVoice: string
  businessHours: BusinessHours
  greetingAudioMediaId: string
  voicemailAudioMediaId: string
  closedVoicemailAudioMediaId: string
}): Promise<void> {
  // Sent as a JSON string and cast, so the jsonb column gets a JSON document
  // rather than Postgres trying to read the array as a text[].
  const businessHours = JSON.stringify(input.businessHours)
  await prisma.$executeRaw`
    INSERT INTO "tw_forwarding_rules"
      (phone_sid, phone_number, forward_to, enabled, greeting_message, greeting_voice,
       record_calls, show_called_number, voicemail_enabled, ring_timeout,
       voicemail_greeting, closed_voicemail_greeting, voicemail_voice,
       business_hours, greeting_audio_media_id, voicemail_audio_media_id,
       closed_voicemail_audio_media_id, updated_at)
    VALUES (${input.phoneSid}, ${input.phoneNumber}, ${input.forwardTo}, ${input.enabled},
            ${input.greetingMessage}, ${input.greetingVoice}, ${input.recordCalls},
            ${input.showCalledNumber}, ${input.voicemailEnabled}, ${input.ringTimeout},
            ${input.voicemailGreeting}, ${input.closedVoicemailGreeting},
            ${input.voicemailVoice}, ${businessHours}::jsonb,
            ${input.greetingAudioMediaId}, ${input.voicemailAudioMediaId},
            ${input.closedVoicemailAudioMediaId}, CURRENT_TIMESTAMP)
    ON CONFLICT (phone_sid) DO UPDATE SET
      phone_number       = EXCLUDED.phone_number,
      forward_to         = EXCLUDED.forward_to,
      enabled            = EXCLUDED.enabled,
      greeting_message   = EXCLUDED.greeting_message,
      greeting_voice     = EXCLUDED.greeting_voice,
      record_calls       = EXCLUDED.record_calls,
      show_called_number = EXCLUDED.show_called_number,
      voicemail_enabled  = EXCLUDED.voicemail_enabled,
      ring_timeout       = EXCLUDED.ring_timeout,
      voicemail_greeting = EXCLUDED.voicemail_greeting,
      closed_voicemail_greeting = EXCLUDED.closed_voicemail_greeting,
      voicemail_voice    = EXCLUDED.voicemail_voice,
      business_hours     = EXCLUDED.business_hours,
      greeting_audio_media_id         = EXCLUDED.greeting_audio_media_id,
      voicemail_audio_media_id        = EXCLUDED.voicemail_audio_media_id,
      closed_voicemail_audio_media_id = EXCLUDED.closed_voicemail_audio_media_id,
      updated_at         = CURRENT_TIMESTAMP
  `
}
