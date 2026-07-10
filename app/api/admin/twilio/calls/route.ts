// GET /api/m/twilio/admin/calls?number=+44... - recent calls to and from one
// of the account's numbers, with any completed recording SIDs attached.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, listCallsForNumber } from '@/modules/twilio/lib/twilio'
import { normalisePhone } from '@/modules/twilio/lib/verification'

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured. Add your credentials on the settings page first.', 503)
  }

  const number = normalisePhone(request.nextUrl.searchParams.get('number') ?? '')
  if (!number) return errorResponse('Invalid phone number')

  try {
    return NextResponse.json({ calls: await listCallsForNumber(number) })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to list calls', 502)
  }
}
