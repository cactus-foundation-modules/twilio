// GET /api/m/twilio/admin/status - configuration state + connection test.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, fetchAccountName, getTwilioConfig } from '@/modules/twilio/lib/twilio'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return NextResponse.json({ configured: false })
  }

  try {
    const accountName = await fetchAccountName()
    return NextResponse.json({
      configured: true,
      connected: true,
      accountName,
      fromNumber: getTwilioConfig()?.fromNumber ?? '',
    })
  } catch (err) {
    return NextResponse.json({
      configured: true,
      connected: false,
      error: err instanceof Error ? err.message : 'Connection failed',
    })
  }
}
