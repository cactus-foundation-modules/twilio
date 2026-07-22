// Module-wide settings - one singleton row in tw_settings. Email alerts for
// voicemails and missed calls, and how long recordings are kept. Per-number
// behaviour lives on tw_forwarding_rules instead; this table is only for
// things that are true of the whole site.
import { prisma } from '@/lib/db/prisma'

export type TwilioSettings = {
  /** Email an alert when a caller leaves a voicemail. */
  notifyVoicemailEmail: boolean
  /** Email an alert when a forwarded call goes unanswered. */
  notifyMissedCallEmail: boolean
  /** Where the alerts go. Empty = alerts stay off whatever the toggles say. */
  notifyEmail: string
  /** Delete recordings and voicemails older than this many days. 0 = keep forever. */
  retentionDays: number
}

export const DEFAULT_SETTINGS: TwilioSettings = {
  notifyVoicemailEmail: false,
  notifyMissedCallEmail: false,
  notifyEmail: '',
  retentionDays: 0,
}

// Retention ceiling: Twilio's own default is to keep recordings indefinitely,
// so anything above ten years is "forever" spelt oddly.
export const MAX_RETENTION_DAYS = 3650

export async function getTwilioSettings(): Promise<TwilioSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT notify_voicemail_email, notify_missed_call_email, notify_email, retention_days
    FROM "tw_settings" WHERE id = 'singleton' LIMIT 1
  `
  const row = rows[0]
  if (!row) return { ...DEFAULT_SETTINGS }
  return {
    notifyVoicemailEmail: row.notify_voicemail_email as boolean,
    notifyMissedCallEmail: row.notify_missed_call_email as boolean,
    notifyEmail: row.notify_email as string,
    retentionDays: Number(row.retention_days),
  }
}

export async function updateTwilioSettings(settings: TwilioSettings): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "tw_settings"
      (id, notify_voicemail_email, notify_missed_call_email, notify_email, retention_days, updated_at)
    VALUES ('singleton', ${settings.notifyVoicemailEmail}, ${settings.notifyMissedCallEmail},
            ${settings.notifyEmail}, ${settings.retentionDays}, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      notify_voicemail_email   = EXCLUDED.notify_voicemail_email,
      notify_missed_call_email = EXCLUDED.notify_missed_call_email,
      notify_email             = EXCLUDED.notify_email,
      retention_days           = EXCLUDED.retention_days,
      updated_at               = CURRENT_TIMESTAMP
  `
}
