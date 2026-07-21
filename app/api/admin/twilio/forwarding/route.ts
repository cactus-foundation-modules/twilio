// PUT /api/m/twilio/admin/forwarding - set a number's forwarding rule and
// point (or clear) its Twilio voice webhook accordingly.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteUrl } from '@/lib/config/env'
import { isTwilioConfigured, setNumberVoiceUrl } from '@/modules/twilio/lib/twilio'
import { upsertForwardingRule } from '@/modules/twilio/lib/forwarding'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { normalisePhone } from '@/modules/twilio/lib/verification'
import { isValidVoice } from '@/modules/twilio/lib/voices'
import { parseBusinessHours, MIN_RING_TIMEOUT, MAX_RING_TIMEOUT } from '@/modules/twilio/lib/business-hours'

const Body = z.object({
  phoneSid: z.string().min(1),
  phoneNumber: z.string().min(1),
  forwardTo: z.string(),
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
})

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

  let forwardTo = ''
  if (enabled) {
    const normalised = normalisePhone(parsed.data.forwardTo)
    if (!normalised) {
      return errorResponse('Forward-to number must be in international format, e.g. +447700900123')
    }
    forwardTo = normalised
  } else if (parsed.data.forwardTo) {
    // Keep the stored target (if valid) so re-enabling doesn't lose it.
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
    const webhookUrl = `${getSiteUrl()}/api/m/twilio/webhooks/voice`
    const region = await resolveNumberRegion(phoneNumber)
    await setNumberVoiceUrl(phoneSid, enabled || voicemailEnabled ? webhookUrl : '', region)
    await upsertForwardingRule({
      phoneSid,
      phoneNumber,
      forwardTo,
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
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to update forwarding', 502)
  }
}
