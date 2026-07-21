// GET /api/m/twilio/admin/status - configuration state + connection test.
//
// Each Twilio Region needs its own auth token, so every configured Region is
// connection-tested separately: a working main token says nothing about
// whether the Ireland one is right.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  isTwilioConfigured,
  fetchAccountName,
  getConfiguredRegions,
  isRegionConfigured,
  getHomeRegion,
  TWILIO_REGIONS,
  type TwilioRegion,
} from '@/modules/twilio/lib/twilio'
import { getDefaultSmsNumber } from '@/modules/twilio/lib/numbers'

type RegionStatus = {
  region: TwilioRegion
  configured: boolean
  connected: boolean
  accountName?: string
  error?: string
}

async function testRegion(region: TwilioRegion): Promise<RegionStatus> {
  if (!isRegionConfigured(region)) {
    return { region, configured: false, connected: false }
  }
  try {
    return { region, configured: true, connected: true, accountName: await fetchAccountName(region) }
  } catch (err) {
    return {
      region,
      configured: true,
      connected: false,
      error: err instanceof Error ? err.message : 'Connection failed',
    }
  }
}

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const homeRegion = getHomeRegion()

  if (!isTwilioConfigured()) {
    return NextResponse.json({
      configured: false,
      homeRegion,
      regions: TWILIO_REGIONS.map((region) => ({ region, configured: false, connected: false })),
    })
  }

  const [regions, fromNumber] = await Promise.all([
    Promise.all(TWILIO_REGIONS.map(testRegion)),
    getDefaultSmsNumber().catch(() => null),
  ])

  const home = regions.find((r) => r.region === homeRegion)
  if (!home?.connected) {
    return NextResponse.json({
      configured: true,
      connected: false,
      homeRegion,
      error: home?.error ?? 'Connection failed',
      regions,
    })
  }

  return NextResponse.json({
    configured: true,
    connected: true,
    homeRegion,
    accountName: home.accountName ?? 'Twilio account',
    fromNumber: fromNumber?.phoneNumber ?? '',
    configuredRegions: getConfiguredRegions(),
    regions,
  })
}
