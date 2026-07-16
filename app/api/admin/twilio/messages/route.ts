// GET /api/m/twilio/admin/messages?number=+44... - recent text messages to
// and from one of the account's numbers.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, listMessagesForNumber } from '@/modules/twilio/lib/twilio'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
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
    // Same Region rule as the call log: a number's texts exist only where it
    // is routed.
    const region = await resolveNumberRegion(number)
    return NextResponse.json({ messages: await listMessagesForNumber(number, region), region })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to list messages', 502)
  }
}
