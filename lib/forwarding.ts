import { prisma } from '@/lib/db/prisma'

export type ForwardingRule = {
  id: string
  phoneSid: string
  phoneNumber: string
  forwardTo: string
  enabled: boolean
  greetingMessage: string
  greetingVoice: string
  recordCalls: boolean
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
  }
}

export async function getForwardingRules(): Promise<ForwardingRule[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, phone_sid, phone_number, forward_to, enabled,
           greeting_message, greeting_voice, record_calls
    FROM "tw_forwarding_rules"
  `
  return rows.map(mapRow)
}

export async function getEnabledRuleForNumber(phoneNumber: string): Promise<ForwardingRule | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, phone_sid, phone_number, forward_to, enabled,
           greeting_message, greeting_voice, record_calls
    FROM "tw_forwarding_rules"
    WHERE phone_number = ${phoneNumber} AND enabled = true
    LIMIT 1
  `
  const row = rows[0]
  return row ? mapRow(row) : null
}

export async function upsertForwardingRule(input: {
  phoneSid: string
  phoneNumber: string
  forwardTo: string
  enabled: boolean
  greetingMessage: string
  greetingVoice: string
  recordCalls: boolean
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "tw_forwarding_rules"
      (phone_sid, phone_number, forward_to, enabled, greeting_message, greeting_voice, record_calls, updated_at)
    VALUES (${input.phoneSid}, ${input.phoneNumber}, ${input.forwardTo}, ${input.enabled},
            ${input.greetingMessage}, ${input.greetingVoice}, ${input.recordCalls}, CURRENT_TIMESTAMP)
    ON CONFLICT (phone_sid) DO UPDATE SET
      phone_number     = EXCLUDED.phone_number,
      forward_to       = EXCLUDED.forward_to,
      enabled          = EXCLUDED.enabled,
      greeting_message = EXCLUDED.greeting_message,
      greeting_voice   = EXCLUDED.greeting_voice,
      record_calls     = EXCLUDED.record_calls,
      updated_at       = CURRENT_TIMESTAMP
  `
}
