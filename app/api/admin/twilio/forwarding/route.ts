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
import { normalisePhone } from '@/modules/twilio/lib/verification'

const Body = z.object({
  phoneSid: z.string().min(1),
  phoneNumber: z.string().min(1),
  forwardTo: z.string(),
  enabled: z.boolean(),
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
  const { phoneSid, phoneNumber, enabled } = parsed.data

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
    // Point the number at this module's voice webhook when enabled; clear the
    // webhook when disabled so the number reverts to Twilio's default handling.
    const webhookUrl = `${getSiteUrl()}/api/m/twilio/webhooks/voice`
    await setNumberVoiceUrl(phoneSid, enabled ? webhookUrl : '')
    await upsertForwardingRule({ phoneSid, phoneNumber, forwardTo, enabled })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to update forwarding', 502)
  }
}
