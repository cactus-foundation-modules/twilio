// GET /api/m/twilio/admin/holidays?region=england-and-wales - the public
// holidays falling in the next twelve months, for the opening-hours holiday
// importer. Read-only: the admin picks which of these to add, nothing is
// stored here.
//
// Twelve months from today rather than a calendar year, because a calendar
// year is the wrong window for most of the year - importing in October would
// otherwise offer ten months of dates that have already been and none of the
// spring ones.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getSiteTimezone } from '@/modules/twilio/lib/forwarding'
import {
  fetchHolidayWindow,
  findHolidayRegion,
  todayIn,
  HOLIDAY_REGIONS,
} from '@/modules/twilio/lib/holidays'

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  // No region asked for: the picker's own options, so the list of countries
  // lives in one place rather than being repeated in the component.
  const regionId = request.nextUrl.searchParams.get('region')
  if (!regionId) {
    return NextResponse.json({
      regions: HOLIDAY_REGIONS.map((r) => ({ id: r.id, label: r.label })),
    })
  }

  const region = findHolidayRegion(regionId)
  if (!region) return errorResponse('Unknown country')

  try {
    // "Today" in the site's own timezone, the same clock the opening hours are
    // judged against - so a site in Sydney does not import a window starting
    // yesterday.
    const from = todayIn(await getSiteTimezone())
    return NextResponse.json(await fetchHolidayWindow(region, from))
  } catch (err) {
    // 502, not 500: the failure is someone else's server, and the message says
    // so rather than implying the site is broken.
    return errorResponse(err instanceof Error ? err.message : 'Failed to fetch the holiday list', 502)
  }
}
