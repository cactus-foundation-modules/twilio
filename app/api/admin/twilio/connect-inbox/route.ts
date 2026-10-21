// POST /api/m/twilio/admin/connect-inbox - points every number on the account at
// this site's activity address, so texts and finished calls reach the unified
// inbox at once. Numbers already pointing somewhere else are left alone and
// reported back.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { connectAllNumbersToInbox } from '@/modules/twilio/lib/inbox-hookup'

export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)
  if (!isTwilioConfigured()) return errorResponse('Twilio is not configured. Add your credentials first.', 503)

  try {
    return NextResponse.json({ results: await connectAllNumbersToInbox() })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to connect numbers', 502)
  }
}
