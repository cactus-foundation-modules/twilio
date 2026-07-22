// POST /api/m/twilio/admin/test-sms - sends one test text to the admin's own
// phone from the site's default SMS number, proving the whole sending path
// (credentials, region, number capability) without touching sign-in codes.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { getDefaultSmsNumber, sendSiteSms } from '@/modules/twilio/lib/numbers'
import { normalisePhone } from '@/modules/twilio/lib/verification'

const Body = z.object({ to: z.string() })

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
    return errorResponse('The number must be in international format, e.g. +447700900123')
  }

  const from = await getDefaultSmsNumber()
  if (!from) {
    return errorResponse('No text-enabled number is set to send texts yet - pick one on the Phone numbers tab')
  }

  try {
    await sendSiteSms(to, 'Test message from your website - texting is working.')
    return NextResponse.json({ ok: true, from: from.phoneNumber })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to send the test text', 502)
  }
}
