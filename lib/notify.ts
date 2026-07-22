// Outbound nudges raised by call outcomes: the auto-text to a caller nobody
// managed to answer, and the email alerts for missed calls and voicemails.
// All of it is fire-and-forget from a webhook's point of view - a notification
// failure is logged, never thrown, because the call itself went fine and
// Twilio must not be told otherwise.
import { prisma } from '@/lib/db/prisma'
import { sendEmail } from '@/lib/email/index'
import { getSiteUrl } from '@/lib/config/env'
import { getHomeRegion, isTwilioRegion, sendSms, type TwilioRegion } from './twilio'
import { getDefaultSmsNumber } from './numbers'
import { getTwilioSettings } from './settings'
import type { ForwardingRule } from './forwarding'

const E164 = /^\+[1-9]\d{7,14}$/

// Sent when the admin switched the auto-text on but left the message empty.
const FALLBACK_MISSED_CALL_SMS =
  'Sorry we missed your call - we will ring you back as soon as we can.'

export const MAX_MISSED_CALL_SMS_LENGTH = 320

// The full URL of the admin Twilio page (call log, voicemail playback), for
// email alerts. The admin path is install-specific and secret-ish, which is
// fine: the alerts only ever go to the address the admin typed in.
async function adminTwilioUrl(): Promise<string> {
  const config = await prisma.siteConfig.findUnique({
    where: { id: 'singleton' },
    select: { adminPath: true },
  })
  const adminPath = config?.adminPath || 'cactus-admin'
  return `${getSiteUrl()}/${adminPath}/m/twilio`
}

function callerLabel(fromNumber: string): string {
  return E164.test(fromNumber) ? fromNumber : 'a withheld number'
}

// The Region the called site number sends texts through, plus whether it can
// send them at all.
async function smsSenderFor(calledNumber: string): Promise<{ from: string; region: TwilioRegion } | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT phone_number, sms_capable, region FROM "tw_site_numbers"
    WHERE phone_number = ${calledNumber} LIMIT 1
  `
  const home = getHomeRegion()
  if (rows[0] && (rows[0].sms_capable as boolean)) {
    const region = rows[0].region as string
    return {
      from: rows[0].phone_number as string,
      region: home !== 'us1' ? home : isTwilioRegion(region) ? region : 'us1',
    }
  }
  // The called number cannot text (or is not on the site) - fall back to the
  // site's default sender rather than staying silent.
  const fallback = await getDefaultSmsNumber().catch(() => null)
  return fallback ? { from: fallback.phoneNumber, region: fallback.region } : null
}

// Texts the caller back after a call nobody answered, from the number they
// rang where possible. Anonymous callers have nowhere to text.
export async function sendMissedCallText(rule: ForwardingRule, fromNumber: string): Promise<void> {
  if (!rule.missedCallSmsEnabled) return
  if (!E164.test(fromNumber)) return
  try {
    const sender = await smsSenderFor(rule.phoneNumber)
    if (!sender) {
      console.error('[twilio] missed-call text skipped: no text-capable number on the site')
      return
    }
    const body = rule.missedCallSmsMessage.trim() || FALLBACK_MISSED_CALL_SMS
    await sendSms(fromNumber, body, sender.from, sender.region)
  } catch (err) {
    console.error('[twilio] failed to send missed-call text', err)
  }
}

// Emails the admin about a call nobody answered, when the alert is switched on
// and an address is set.
export async function sendMissedCallEmail(calledNumber: string, fromNumber: string): Promise<void> {
  try {
    const settings = await getTwilioSettings()
    if (!settings.notifyMissedCallEmail || !settings.notifyEmail) return
    const caller = callerLabel(fromNumber)
    const url = await adminTwilioUrl()
    await sendEmail({
      to: settings.notifyEmail,
      subject: `Missed call on ${calledNumber}`,
      text:
        `${caller} rang ${calledNumber} and nobody was able to answer.\n\n` +
        `The full call log is at ${url}`,
      html:
        `<p><strong>${caller}</strong> rang <strong>${calledNumber}</strong> and nobody was able to answer.</p>` +
        `<p><a href="${url}">Open the call log</a></p>`,
    })
  } catch (err) {
    console.error('[twilio] failed to send missed-call email', err)
  }
}

// Emails the admin about a new voicemail, when the alert is switched on and an
// address is set. The recording plays from the call log - the audio itself
// never leaves the Twilio account, so the email carries a link, not a file.
export async function sendVoicemailEmail(row: {
  fromNumber: string
  toNumber: string
  durationSeconds: number
}): Promise<void> {
  try {
    const settings = await getTwilioSettings()
    if (!settings.notifyVoicemailEmail || !settings.notifyEmail) return
    const caller = callerLabel(row.fromNumber)
    const url = await adminTwilioUrl()
    const seconds = `${row.durationSeconds} second${row.durationSeconds === 1 ? '' : 's'}`
    await sendEmail({
      to: settings.notifyEmail,
      subject: `New voicemail from ${caller}`,
      text:
        `${caller} left a ${seconds} voicemail on ${row.toNumber}.\n\n` +
        `Listen from the call log at ${url}`,
      html:
        `<p><strong>${caller}</strong> left a ${seconds} voicemail on <strong>${row.toNumber}</strong>.</p>` +
        `<p><a href="${url}">Listen from the call log</a></p>`,
    })
  } catch (err) {
    console.error('[twilio] failed to send voicemail email', err)
  }
}
