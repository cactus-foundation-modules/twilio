// What the site has set up for WhatsApp: which number sends, and which of
// Meta's approved templates it means to use.
//
// The sender lives on the same singleton settings row as the alert and
// retention settings, because it is the same kind of thing - one fact about the
// whole site - but it is read and written HERE and only here, and lib/settings.ts
// likewise touches only its own columns. Two files writing overlapping columns
// of one row is how a save on one tab quietly reverts the other tab; each
// upsert below names its own columns and nothing else's.
import { prisma } from '@/lib/db/prisma'
import { getHomeRegion, isTwilioRegion, type TwilioRegion } from './twilio'
import { isContentSid } from './whatsapp'
import { normalisePhone } from './verification'

export type WhatsAppConfig = {
  /** Whether the site offers WhatsApp at all. Off means the channel does not
   *  appear anywhere, whatever else is filled in. */
  enabled: boolean
  /** The sending number, E.164, no "whatsapp:" prefix. Empty = none chosen,
   *  which keeps WhatsApp off however the toggle reads - the same rule the
   *  email alerts use, and for the same reason: a switch that says On over
   *  nothing at all is worse than a switch that says Off. */
  sender: string
  /** Which Twilio region the sender's messages are processed in. Stored rather
   *  than derived: a sandbox sender is Twilio's number, not the site's, so
   *  there is no tw_site_numbers row to read it off. */
  region: TwilioRegion
}

export const DEFAULT_WHATSAPP_CONFIG: WhatsAppConfig = {
  enabled: false,
  sender: '',
  region: 'us1',
}

/** Twilio's shared WhatsApp sandbox sender. Every account starts here, because
 *  a real WhatsApp sender needs Meta's approval and that takes days. Named so
 *  the settings screen can offer it rather than making somebody find it in
 *  Twilio's documentation. */
export const WHATSAPP_SANDBOX_SENDER = '+14155238886'

export async function getWhatsAppConfig(): Promise<WhatsAppConfig> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT whatsapp_enabled, whatsapp_sender, whatsapp_region
    FROM "tw_settings" WHERE id = 'singleton' LIMIT 1
  `
  const row = rows[0]
  if (!row) return { ...DEFAULT_WHATSAPP_CONFIG, region: getHomeRegion() }
  const stored = row.whatsapp_region as string
  return {
    enabled: row.whatsapp_enabled as boolean,
    sender: row.whatsapp_sender as string,
    // An empty or unrecognised stored region reads as the account's home
    // region rather than poisoning every send with an unroutable value.
    region: isTwilioRegion(stored) ? stored : getHomeRegion(),
  }
}

export async function updateWhatsAppConfig(config: WhatsAppConfig): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "tw_settings" (id, whatsapp_enabled, whatsapp_sender, whatsapp_region, updated_at)
    VALUES ('singleton', ${config.enabled}, ${config.sender}, ${config.region}, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      whatsapp_enabled = EXCLUDED.whatsapp_enabled,
      whatsapp_sender  = EXCLUDED.whatsapp_sender,
      whatsapp_region  = EXCLUDED.whatsapp_region,
      updated_at       = CURRENT_TIMESTAMP
  `
}

/** Why a saved configuration will not work, in the words somebody can act on.
 *  Null when it will. Pure, so the route and the tests reach the same answer. */
export function configProblem(config: WhatsAppConfig): string | null {
  if (!config.enabled) return null
  if (!config.sender) {
    return 'Choose the number your WhatsApp messages go out from, or turn WhatsApp off.'
  }
  if (!normalisePhone(config.sender)) {
    return 'The WhatsApp number must be in international format, e.g. +447700900123'
  }
  return null
}

/** The sender to actually send from, or null when WhatsApp is not ready. The
 *  single gate for offering WhatsApp anywhere - same shape and same job as
 *  getDefaultSmsNumber. */
export async function getWhatsAppSender(): Promise<{ phoneNumber: string; region: TwilioRegion } | null> {
  const config = await getWhatsAppConfig()
  if (!config.enabled || !config.sender) return null
  return { phoneNumber: config.sender, region: config.region }
}

// ---------------------------------------------------------------------------
// Approved templates
// ---------------------------------------------------------------------------

export type WhatsAppTemplate = {
  id: string
  /** Twilio's Content SID: HX + 32 hex. */
  contentSid: string
  /** What staff call it. Twilio's own name for a template is not always one. */
  label: string
  /** How many blanks it has. Twilio numbers them from 1. */
  variableCount: number
}

/** Templates are picked from a menu by hand, so the ceiling is a sanity bound
 *  rather than a page size. */
export const MAX_TEMPLATES = 100

/** Twilio's own ceiling on a template's variables is well above anything a site
 *  would write by hand; this one keeps the send form to a sensible size. */
export const MAX_TEMPLATE_VARIABLES = 10

function mapTemplate(r: Record<string, unknown>): WhatsAppTemplate {
  return {
    id: r.id as string,
    contentSid: r.content_sid as string,
    label: r.label as string,
    variableCount: Number(r.variable_count),
  }
}

export async function listWhatsAppTemplates(): Promise<WhatsAppTemplate[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, content_sid, label, variable_count
    FROM "tw_whatsapp_templates"
    ORDER BY label, created_at
  `
  return rows.map(mapTemplate)
}

export async function getWhatsAppTemplate(contentSid: string): Promise<WhatsAppTemplate | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, content_sid, label, variable_count
    FROM "tw_whatsapp_templates" WHERE content_sid = ${contentSid} LIMIT 1
  `
  return rows[0] ? mapTemplate(rows[0]) : null
}

/** Registers a template, or updates the one already registered under that
 *  Content SID. Adding the same template twice is a correction rather than a
 *  second template - the SID is Meta's identity for it, not ours. */
export async function saveWhatsAppTemplate(input: {
  contentSid: string
  label: string
  variableCount: number
}): Promise<void> {
  if (!isContentSid(input.contentSid)) {
    throw new Error('That is not a Twilio template id - it should start with HX followed by 32 characters.')
  }
  const existing = await getWhatsAppTemplate(input.contentSid)
  if (!existing) {
    const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT COUNT(*)::int AS n FROM "tw_whatsapp_templates"
    `
    if (Number(rows[0]?.n ?? 0) >= MAX_TEMPLATES) {
      throw new Error(`That is already ${MAX_TEMPLATES} templates - remove one before adding another.`)
    }
  }
  await prisma.$executeRaw`
    INSERT INTO "tw_whatsapp_templates" (content_sid, label, variable_count, updated_at)
    VALUES (${input.contentSid}, ${input.label}, ${input.variableCount}, CURRENT_TIMESTAMP)
    ON CONFLICT (content_sid) DO UPDATE SET
      label          = EXCLUDED.label,
      variable_count = EXCLUDED.variable_count,
      updated_at     = CURRENT_TIMESTAMP
  `
}

export async function deleteWhatsAppTemplate(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "tw_whatsapp_templates" WHERE id = ${id}`
}
