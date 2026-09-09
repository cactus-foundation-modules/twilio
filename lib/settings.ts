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
  /**
   * The Voice Intelligence Service recorded calls are typed up through,
   * provisioned by the module on first use. Empty = never needed one yet.
   *
   * Not an owner-editable setting, which is why it is not on the settings form:
   * it is a Twilio id this module made and has to remember. It rides in this
   * row because there is nowhere better for one fact about the whole site.
   */
  intelligenceServiceSid: string
}

export const DEFAULT_SETTINGS: TwilioSettings = {
  notifyVoicemailEmail: false,
  notifyMissedCallEmail: false,
  notifyEmail: '',
  retentionDays: 0,
  intelligenceServiceSid: '',
}

// Retention ceiling: Twilio's own default is to keep recordings indefinitely,
// so anything above ten years is "forever" spelt oddly.
export const MAX_RETENTION_DAYS = 3650

export async function getTwilioSettings(): Promise<TwilioSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT notify_voicemail_email, notify_missed_call_email, notify_email, retention_days,
           intelligence_service_sid
    FROM "tw_settings" WHERE id = 'singleton' LIMIT 1
  `
  const row = rows[0]
  if (!row) return { ...DEFAULT_SETTINGS }
  return {
    notifyVoicemailEmail: row.notify_voicemail_email as boolean,
    notifyMissedCallEmail: row.notify_missed_call_email as boolean,
    notifyEmail: row.notify_email as string,
    retentionDays: Number(row.retention_days),
    intelligenceServiceSid: (row.intelligence_service_sid as string) ?? '',
  }
}

// Deliberately takes only what the settings form owns. intelligenceServiceSid
// is not on that form and must not be round-tripped through it: a save made
// from a page loaded before the service existed would write the empty string
// back over it, and the site would quietly provision - and start paying for - a
// second Voice Intelligence service on the next call.
export async function updateTwilioSettings(
  settings: Omit<TwilioSettings, 'intelligenceServiceSid'>
): Promise<void> {
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

/** Remembers the Voice Intelligence service this site transcribes through.
 *  Written once, by the module, the first time it makes one. */
export async function setIntelligenceServiceSid(sid: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "tw_settings" (id, intelligence_service_sid, updated_at)
    VALUES ('singleton', ${sid}, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      intelligence_service_sid = EXCLUDED.intelligence_service_sid,
      updated_at               = CURRENT_TIMESTAMP
  `
}
