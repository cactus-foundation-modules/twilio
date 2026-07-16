// Site phone numbers - the subset of the Twilio account's incoming numbers
// the admin has added to this site. Texts are only ever sent from the single
// default SMS number, which must be SMS-capable. Rows mirror Twilio metadata
// (friendly name, capability, routing region) and are refreshed whenever
// numbers are listed.
import { prisma } from '@/lib/db/prisma'
import {
  getTwilioConfig,
  getNumberRegion,
  isTwilioRegion,
  sendSms,
  setNumberRegion,
  HOME_REGION,
  type TwilioRegion,
} from './twilio'

export type SiteNumber = {
  phoneSid: string
  phoneNumber: string
  friendlyName: string
  smsCapable: boolean
  isDefaultSms: boolean
  region: TwilioRegion
}

function mapRow(r: Record<string, unknown>): SiteNumber {
  const region = r.region as string
  return {
    phoneSid: r.phone_sid as string,
    phoneNumber: r.phone_number as string,
    friendlyName: r.friendly_name as string,
    smsCapable: r.sms_capable as boolean,
    isDefaultSms: r.is_default_sms as boolean,
    // A region Twilio no longer recognises reads as the us1 default rather
    // than poisoning every downstream call with an unroutable value.
    region: isTwilioRegion(region) ? region : HOME_REGION,
  }
}

export async function getSiteNumbers(): Promise<SiteNumber[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT phone_sid, phone_number, friendly_name, sms_capable, is_default_sms, region
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
  region: TwilioRegion
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "tw_site_numbers" (phone_sid, phone_number, friendly_name, sms_capable, region, updated_at)
    VALUES (${input.phoneSid}, ${input.phoneNumber}, ${input.friendlyName}, ${input.smsCapable}, ${input.region}, CURRENT_TIMESTAMP)
    ON CONFLICT (phone_sid) DO UPDATE SET
      phone_number  = EXCLUDED.phone_number,
      friendly_name = EXCLUDED.friendly_name,
      sms_capable   = EXCLUDED.sms_capable,
      region        = EXCLUDED.region,
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

// Routes a site number to a Region, at Twilio first so a rejected change never
// leaves the stored value claiming something untrue. Twilio takes up to five
// minutes to apply it.
export async function setSiteNumberRegion(phoneSid: string, region: TwilioRegion): Promise<void> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT phone_number FROM "tw_site_numbers" WHERE phone_sid = ${phoneSid} LIMIT 1
  `
  if (!rows[0]) throw new Error('That number has not been added to the site')
  const phoneNumber = rows[0].phone_number as string

  await setNumberRegion(phoneNumber, region)
  await prisma.$executeRaw`
    UPDATE "tw_site_numbers" SET region = ${region}, updated_at = CURRENT_TIMESTAMP
    WHERE phone_sid = ${phoneSid}
  `
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
// Routing regions are re-read from the Routes API (one call per on-site
// number, in parallel) so a change made directly in the Twilio console is
// picked up rather than silently disagreeing with the stored copy.
export async function syncSiteNumbers(
  accountNumbers: Array<{ sid: string; phoneNumber: string; friendlyName: string; smsCapable: boolean }>
): Promise<void> {
  const bySid = new Map(accountNumbers.map((n) => [n.sid, n]))
  const site = await getSiteNumbers()

  const live = site.filter((row) => bySid.has(row.phoneSid))
  const regions = new Map<string, TwilioRegion>(
    await Promise.all(
      live.map(async (row): Promise<[string, TwilioRegion]> => {
        try {
          return [row.phoneSid, await getNumberRegion(row.phoneNumber)]
        } catch {
          // A Routes lookup failure must not wipe the stored region or block
          // the listing - keep what we have and try again next time.
          return [row.phoneSid, row.region]
        }
      })
    )
  )

  for (const row of site) {
    const account = bySid.get(row.phoneSid)
    if (!account) {
      await removeSiteNumber(row.phoneSid)
      continue
    }
    const region = regions.get(row.phoneSid) ?? row.region
    if (
      account.phoneNumber !== row.phoneNumber ||
      account.friendlyName !== row.friendlyName ||
      account.smsCapable !== row.smsCapable ||
      region !== row.region
    ) {
      await prisma.$executeRaw`
        UPDATE "tw_site_numbers"
        SET phone_number = ${account.phoneNumber}, friendly_name = ${account.friendlyName},
            sms_capable = ${account.smsCapable}, region = ${region}, updated_at = CURRENT_TIMESTAMP
        WHERE phone_sid = ${row.phoneSid}
      `
    }
  }
  await ensureDefaultSms()
}

// The Region a number's calls and texts are processed in - the stored value for
// an on-site number, otherwise straight from Twilio. The admin call/message
// logs cover every number on the account, not just the ones added to the site,
// so the live fallback is load-bearing rather than defensive.
export async function resolveNumberRegion(phoneNumber: string): Promise<TwilioRegion> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT region FROM "tw_site_numbers" WHERE phone_number = ${phoneNumber} LIMIT 1
  `
  const stored = rows[0]?.region as string | undefined
  if (stored && isTwilioRegion(stored)) return stored
  return getNumberRegion(phoneNumber)
}

// The site's default SMS sender, with the Region its texts go through.
export async function getDefaultSmsNumber(): Promise<{ phoneNumber: string; region: TwilioRegion } | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT phone_number, region FROM "tw_site_numbers" WHERE is_default_sms AND sms_capable LIMIT 1
  `
  if (!rows[0]) return null
  const region = rows[0].region as string
  return {
    phoneNumber: rows[0].phone_number as string,
    region: isTwilioRegion(region) ? region : HOME_REGION,
  }
}

// True when credentials are set AND an SMS-capable site number is selected -
// the gate for offering SMS login codes anywhere.
export async function isSmsReady(): Promise<boolean> {
  if (!getTwilioConfig()) return false
  return (await getDefaultSmsNumber()) !== null
}

// Sends a text from the site's default SMS number, through that number's own
// Region.
export async function sendSiteSms(to: string, body: string): Promise<void> {
  const from = await getDefaultSmsNumber()
  if (!from) {
    throw new Error('No text-enabled Twilio number has been added to the site')
  }
  await sendSms(to, body, from.phoneNumber, from.region)
}
