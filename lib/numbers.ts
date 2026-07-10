// Site phone numbers - the subset of the Twilio account's incoming numbers
// the admin has added to this site. Texts are only ever sent from the single
// default SMS number, which must be SMS-capable. Rows mirror Twilio metadata
// (friendly name, capability) and are refreshed whenever numbers are listed.
import { prisma } from '@/lib/db/prisma'
import { getTwilioConfig, sendSms } from './twilio'

export type SiteNumber = {
  phoneSid: string
  phoneNumber: string
  friendlyName: string
  smsCapable: boolean
  isDefaultSms: boolean
}

function mapRow(r: Record<string, unknown>): SiteNumber {
  return {
    phoneSid: r.phone_sid as string,
    phoneNumber: r.phone_number as string,
    friendlyName: r.friendly_name as string,
    smsCapable: r.sms_capable as boolean,
    isDefaultSms: r.is_default_sms as boolean,
  }
}

export async function getSiteNumbers(): Promise<SiteNumber[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT phone_sid, phone_number, friendly_name, sms_capable, is_default_sms
    FROM "tw_site_numbers"
    ORDER BY created_at
  `
  return rows.map(mapRow)
}

// Adds (or refreshes) a number on the site. The first SMS-capable number
// added becomes the default SMS sender automatically.
export async function addSiteNumber(input: {
  phoneSid: string
  phoneNumber: string
  friendlyName: string
  smsCapable: boolean
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "tw_site_numbers" (phone_sid, phone_number, friendly_name, sms_capable, updated_at)
    VALUES (${input.phoneSid}, ${input.phoneNumber}, ${input.friendlyName}, ${input.smsCapable}, CURRENT_TIMESTAMP)
    ON CONFLICT (phone_sid) DO UPDATE SET
      phone_number  = EXCLUDED.phone_number,
      friendly_name = EXCLUDED.friendly_name,
      sms_capable   = EXCLUDED.sms_capable,
      updated_at    = CURRENT_TIMESTAMP
  `
  if (input.smsCapable) await ensureDefaultSms()
}

// Removes a number from the site. If it was the default SMS sender, the
// oldest remaining SMS-capable number takes over.
export async function removeSiteNumber(phoneSid: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "tw_site_numbers" WHERE phone_sid = ${phoneSid}`
  await ensureDefaultSms()
}

export async function setDefaultSmsNumber(phoneSid: string): Promise<void> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT sms_capable FROM "tw_site_numbers" WHERE phone_sid = ${phoneSid} LIMIT 1
  `
  if (!rows[0]) throw new Error('That number has not been added to the site')
  if (!(rows[0].sms_capable as boolean)) {
    throw new Error('That number cannot send text messages')
  }
  await prisma.$transaction([
    prisma.$executeRaw`UPDATE "tw_site_numbers" SET is_default_sms = false, updated_at = CURRENT_TIMESTAMP WHERE is_default_sms`,
    prisma.$executeRaw`UPDATE "tw_site_numbers" SET is_default_sms = true, updated_at = CURRENT_TIMESTAMP WHERE phone_sid = ${phoneSid}`,
  ])
}

// Guarantees exactly one default while any SMS-capable number is on the site:
// clears a default that lost SMS capability, promotes the oldest capable
// number when none is set.
async function ensureDefaultSms(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "tw_site_numbers" SET is_default_sms = false, updated_at = CURRENT_TIMESTAMP
    WHERE is_default_sms AND NOT sms_capable
  `
  await prisma.$executeRaw`
    UPDATE "tw_site_numbers" SET is_default_sms = true, updated_at = CURRENT_TIMESTAMP
    WHERE phone_sid = (
      SELECT phone_sid FROM "tw_site_numbers" WHERE sms_capable ORDER BY created_at LIMIT 1
    )
    AND NOT EXISTS (SELECT 1 FROM "tw_site_numbers" WHERE is_default_sms)
  `
}

// Refreshes stored Twilio metadata for on-site numbers and drops rows whose
// number has left the Twilio account. Called with a fresh account listing.
export async function syncSiteNumbers(
  accountNumbers: Array<{ sid: string; phoneNumber: string; friendlyName: string; smsCapable: boolean }>
): Promise<void> {
  const bySid = new Map(accountNumbers.map((n) => [n.sid, n]))
  const site = await getSiteNumbers()
  for (const row of site) {
    const live = bySid.get(row.phoneSid)
    if (!live) {
      await removeSiteNumber(row.phoneSid)
      continue
    }
    if (
      live.phoneNumber !== row.phoneNumber ||
      live.friendlyName !== row.friendlyName ||
      live.smsCapable !== row.smsCapable
    ) {
      await prisma.$executeRaw`
        UPDATE "tw_site_numbers"
        SET phone_number = ${live.phoneNumber}, friendly_name = ${live.friendlyName},
            sms_capable = ${live.smsCapable}, updated_at = CURRENT_TIMESTAMP
        WHERE phone_sid = ${row.phoneSid}
      `
    }
  }
  await ensureDefaultSms()
}

export async function getDefaultSmsNumber(): Promise<string | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT phone_number FROM "tw_site_numbers" WHERE is_default_sms AND sms_capable LIMIT 1
  `
  return rows[0] ? (rows[0].phone_number as string) : null
}

// True when credentials are set AND an SMS-capable site number is selected -
// the gate for offering SMS login codes anywhere.
export async function isSmsReady(): Promise<boolean> {
  if (!getTwilioConfig()) return false
  return (await getDefaultSmsNumber()) !== null
}

// Sends a text from the site's default SMS number.
export async function sendSiteSms(to: string, body: string): Promise<void> {
  const from = await getDefaultSmsNumber()
  if (!from) {
    throw new Error('No text-enabled Twilio number has been added to the site')
  }
  await sendSms(to, body, from)
}
