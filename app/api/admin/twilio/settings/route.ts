// GET/PUT /api/m/twilio/admin/settings - the module-wide settings row: email
// alerts for voicemails and missed calls, and recording retention.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  getTwilioSettings,
  updateTwilioSettings,
  MAX_RETENTION_DAYS,
} from '@/modules/twilio/lib/settings'

const Body = z.object({
  notifyVoicemailEmail: z.boolean(),
  notifyMissedCallEmail: z.boolean(),
  notifyEmail: z.string().trim().max(320),
  retentionDays: z.number().int().min(0).max(MAX_RETENTION_DAYS),
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  return NextResponse.json(await getTwilioSettings())
}

export async function PUT(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')
  const settings = parsed.data

  // An alert toggle without an address would silently do nothing forever -
  // better to say so at save time than let the admin believe alerts are on.
  if ((settings.notifyVoicemailEmail || settings.notifyMissedCallEmail) && !settings.notifyEmail) {
    return errorResponse('Add an email address for the alerts to go to')
  }
  if (settings.notifyEmail && !EMAIL_RE.test(settings.notifyEmail)) {
    return errorResponse('That email address does not look right')
  }

  await updateTwilioSettings(settings)
  return NextResponse.json(await getTwilioSettings())
}
