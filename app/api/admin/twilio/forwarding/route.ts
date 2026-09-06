// PUT /api/m/twilio/admin/forwarding - set a number's forwarding rule and
// point (or clear) its Twilio voice webhook accordingly.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteUrl } from '@/lib/config/env'
import { isTwilioConfigured, setNumberVoiceUrl } from '@/modules/twilio/lib/twilio'
import {
  getFollowers,
  getRuleBySid,
  isAnonymousCallerMode,
  upsertForwardingRule,
} from '@/modules/twilio/lib/forwarding'
import { MAX_MISSED_CALL_SMS_LENGTH } from '@/modules/twilio/lib/notify'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { normalisePhone } from '@/modules/twilio/lib/verification'
import { isValidVoice } from '@/modules/twilio/lib/voices'
import { parseBusinessHours, parseHolidayDates, MIN_RING_TIMEOUT, MAX_RING_TIMEOUT } from '@/modules/twilio/lib/business-hours'
import { prisma } from '@/lib/db/prisma'

const Body = z.object({
  phoneSid: z.string().min(1),
  phoneNumber: z.string().min(1),
  forwardTo: z.string(),
  forwardToSecond: z.string().default(''),
  enabled: z.boolean(),
  greetingMessage: z.string().max(500).default(''),
  greetingVoice: z.string().default(''),
  recordCalls: z.boolean().default(false),
  showCalledNumber: z.boolean().default(false),
  voicemailEnabled: z.boolean().default(false),
  ringTimeout: z.number().int().min(MIN_RING_TIMEOUT).max(MAX_RING_TIMEOUT).default(20),
  voicemailGreeting: z.string().max(500).default(''),
  closedVoicemailGreeting: z.string().max(500).default(''),
  voicemailVoice: z.string().default(''),
  businessHours: z.array(z.unknown()).default([]),
  holidayDates: z.array(z.unknown()).default([]),
  missedCallSmsEnabled: z.boolean().default(false),
  missedCallSmsMessage: z.string().max(MAX_MISSED_CALL_SMS_LENGTH).default(''),
  transcribeVoicemail: z.boolean().default(false),
  anonymousCallers: z.string().default('allow'),
  greetingAudioMediaId: z.string().default(''),
  voicemailAudioMediaId: z.string().default(''),
  closedVoicemailAudioMediaId: z.string().default(''),
  // Another number's phone SID to copy call handling from. Empty = this number
  // uses its own settings, which is every number until somebody says otherwise.
  followsPhoneSid: z.string().default(''),
})

// A rule may only reference media that is genuinely an uploaded audio file -
// these ids are what the public audio route agrees to serve, so an arbitrary
// media id here would quietly publish that file to anyone with the URL.
async function audioIdsProblem(ids: string[]): Promise<string | null> {
  const wanted = [...new Set(ids.filter(Boolean))]
  if (wanted.length === 0) return null
  const rows = await prisma.media.findMany({
    where: { id: { in: wanted } },
    select: { id: true, mimeType: true },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of wanted) {
    const media = byId.get(id)
    if (!media) return 'That greeting audio file no longer exists - upload it again.'
    if (!media.mimeType.startsWith('audio/')) {
      return 'Greeting audio must be an audio file uploaded through this page.'
    }
  }
  return null
}

// Numbers copying this one answer calls on its terms, so a save that switches
// this number's forwarding and voicemail both off (or back on) has to move
// their Twilio webhooks with it - otherwise a follower keeps answering calls it
// has no answer for, or stops answering ones it should. A follower's webhook
// failing is logged rather than thrown: the number that was actually being
// edited has saved correctly, and losing that to a second number's Twilio
// hiccup helps nobody.
async function repointFollowers(
  leaderPhoneSid: string,
  answering: boolean,
  webhookUrl: string
): Promise<void> {
  const followers = await getFollowers(leaderPhoneSid)
  await Promise.all(
    followers.map(async (follower) => {
      try {
        const region = await resolveNumberRegion(follower.phoneNumber)
        await setNumberVoiceUrl(follower.phoneSid, answering ? webhookUrl : '', region)
      } catch (err) {
        console.error('[twilio] failed to re-point linked number', follower.phoneNumber, err)
      }
    })
  )
}

export async function PUT(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured. Add your credentials on the settings page first.', 503)
  }

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')
  const { phoneSid, phoneNumber, enabled, recordCalls, showCalledNumber, voicemailEnabled, ringTimeout } = parsed.data

  const greetingMessage = parsed.data.greetingMessage.trim()
  const greetingVoice = parsed.data.greetingVoice
  if (!isValidVoice(greetingVoice)) {
    return errorResponse('Unknown greeting voice')
  }

  const voicemailGreeting = parsed.data.voicemailGreeting.trim()
  const closedVoicemailGreeting = parsed.data.closedVoicemailGreeting.trim()
  const voicemailVoice = parsed.data.voicemailVoice
  if (!isValidVoice(voicemailVoice)) {
    return errorResponse('Unknown voicemail voice')
  }

  const businessHours = parseBusinessHours(parsed.data.businessHours)
  if (!businessHours) {
    return errorResponse('Opening hours must be a time like 09:00 for each day')
  }

  const holidayDates = parseHolidayDates(parsed.data.holidayDates)
  if (!holidayDates) {
    return errorResponse('Holiday dates must be real calendar dates')
  }

  const anonymousCallers = parsed.data.anonymousCallers
  if (!isAnonymousCallerMode(anonymousCallers)) {
    return errorResponse('Unknown withheld-number option')
  }

  const missedCallSmsMessage = parsed.data.missedCallSmsMessage.trim()
  const { missedCallSmsEnabled, transcribeVoicemail } = parsed.data

  // Same rule as forwardTo: a second number must be dialable to be worth
  // saving, but an invalid leftover with the field effectively off is dropped
  // rather than blocking the save.
  let forwardToSecond = ''
  if (parsed.data.forwardToSecond.trim()) {
    const normalised = normalisePhone(parsed.data.forwardToSecond)
    if (!normalised) {
      return errorResponse('The second forward-to number must be in international format, e.g. +447700900123')
    }
    forwardToSecond = normalised
  }

  const { greetingAudioMediaId, voicemailAudioMediaId, closedVoicemailAudioMediaId } = parsed.data
  const audioProblem = await audioIdsProblem([
    greetingAudioMediaId,
    voicemailAudioMediaId,
    closedVoicemailAudioMediaId,
  ])
  if (audioProblem) return errorResponse(audioProblem)

  // Linking this number to another one. Refused unless it can only ever mean
  // one thing: not itself, a number that has settings to copy, a number that
  // is not itself copying someone else, and not while other numbers are
  // copying THIS one. Those last two together keep it to a single hop, so
  // "what does this number do" is always answered by exactly one other row.
  const { followsPhoneSid } = parsed.data
  let leaderRule: Awaited<ReturnType<typeof getRuleBySid>> = null
  if (followsPhoneSid) {
    if (followsPhoneSid === phoneSid) {
      return errorResponse('A number cannot copy its own settings')
    }
    leaderRule = await getRuleBySid(followsPhoneSid)
    if (!leaderRule) {
      return errorResponse('Set that number\u2019s call handling up first, then link this one to it')
    }
    if (leaderRule.followsPhoneSid) {
      return errorResponse('That number already copies another number. Link to the original instead.')
    }
    const ownFollowers = await getFollowers(phoneSid)
    if (ownFollowers.length > 0) {
      return errorResponse(
        'Other numbers copy this one, so it cannot copy another. Unlink those first.'
      )
    }
  }

  let forwardTo = ''
  if (enabled && !followsPhoneSid) {
    const normalised = normalisePhone(parsed.data.forwardTo)
    if (!normalised) {
      return errorResponse('Forward-to number must be in international format, e.g. +447700900123')
    }
    forwardTo = normalised
  } else if (parsed.data.forwardTo) {
    // Keep the stored target (if valid) so re-enabling - or unlinking - doesn't
    // lose it. A linked number's own settings sit dormant, not deleted.
    forwardTo = normalisePhone(parsed.data.forwardTo) ?? ''
  }

  try {
    // Point the number at this module's voice webhook when there is anything for
    // it to do; clear the webhook only when both forwarding and voicemail are
    // off, so the number reverts to Twilio's default handling. Voicemail on its
    // own is a perfectly good reason to keep answering calls.
    //
    // Written to the number's actual processing Region, not the account's home
    // Region - webhook config is per-Region at Twilio, so a number routed to
    // ie1 needs its VoiceUrl set on the ie1 resource or it never rings this
    // site (the outage this comment is fixing).
    //
    // A linked number answers according to the number it copies, not its own
    // dormant settings, so the leader's rule decides its webhook too.
    const webhookUrl = `${getSiteUrl()}/api/m/twilio/webhooks/voice`
    const answering = leaderRule
      ? leaderRule.enabled || leaderRule.voicemailEnabled
      : enabled || voicemailEnabled
    const region = await resolveNumberRegion(phoneNumber)
    await setNumberVoiceUrl(phoneSid, answering ? webhookUrl : '', region)
    await upsertForwardingRule({
      phoneSid,
      phoneNumber,
      forwardTo,
      forwardToSecond,
      enabled,
      greetingMessage,
      greetingVoice,
      recordCalls,
      showCalledNumber,
      voicemailEnabled,
      ringTimeout,
      voicemailGreeting,
      closedVoicemailGreeting,
      voicemailVoice,
      businessHours,
      holidayDates,
      missedCallSmsEnabled,
      missedCallSmsMessage,
      transcribeVoicemail,
      anonymousCallers,
      greetingAudioMediaId,
      voicemailAudioMediaId,
      closedVoicemailAudioMediaId,
      followsPhoneSid,
    })
    await repointFollowers(phoneSid, enabled || voicemailEnabled, webhookUrl)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to update forwarding', 502)
  }
}
