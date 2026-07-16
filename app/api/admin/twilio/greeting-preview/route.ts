// POST /api/m/twilio/admin/greeting-preview - place a short outbound call that
// reads the (possibly unsaved) greeting in the chosen voice, so admins can
// hear it before saving. Mirrors the test-email-with-unsaved-credentials
// pattern on the core settings page.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, placeCall, escapeXml } from '@/modules/twilio/lib/twilio'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { normalisePhone } from '@/modules/twilio/lib/verification'
import { isValidVoice } from '@/modules/twilio/lib/voices'

const Body = z.object({
  // The Twilio number the preview call comes from (the row being configured).
  phoneNumber: z.string().min(1),
  // Where to ring the admin.
  to: z.string().min(1),
  greetingMessage: z.string().min(1).max(500),
  greetingVoice: z.string().default(''),
})

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured. Add your credentials on the settings page first.', 503)
  }

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')

  const to = normalisePhone(parsed.data.to)
  if (!to) {
    return errorResponse('Preview number must be in international format, e.g. +447700900123')
  }

  const greetingMessage = parsed.data.greetingMessage.trim()
  if (!greetingMessage) return errorResponse('Write a greeting first')

  const greetingVoice = parsed.data.greetingVoice
  if (!isValidVoice(greetingVoice)) return errorResponse('Unknown greeting voice')

  const voiceAttr = greetingVoice ? ` voice="${greetingVoice}"` : ''
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say${voiceAttr}>${escapeXml(greetingMessage)}</Say></Response>`

  try {
    // The preview goes out through the row's own Region, so what the admin
    // hears is routed exactly like a real call to that number.
    const region = await resolveNumberRegion(parsed.data.phoneNumber)
    await placeCall(to, parsed.data.phoneNumber, twiml, region)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to place preview call', 502)
  }
}
