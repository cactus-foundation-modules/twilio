// POST /api/m/twilio/admin/test-connection - checks credentials against Twilio
// live, BEFORE they are saved or deployed. Values the admin has typed win;
// blank fields fall back to what is already saved, so "did I paste the right
// token" is answerable while the old one is still live. Nothing is stored.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  isTwilioRegion,
  regionTokenEnvVar,
  testCredentials,
  TWILIO_REGIONS,
  type TwilioRegion,
} from '@/modules/twilio/lib/twilio'

const Body = z.object({
  homeRegion: z.string(),
  accountSid: z.string().trim().default(''),
  // Typed-but-unsaved token per region env var name, e.g.
  // { TWILIO_AUTH_TOKEN: '...', TWILIO_AUTH_TOKEN_IE1: '...' }.
  tokens: z.record(z.string(), z.string()).default({}),
})

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')
  const homeRegion = parsed.data.homeRegion
  if (!isTwilioRegion(homeRegion)) return errorResponse('Unknown country')

  const accountSid = parsed.data.accountSid || process.env.TWILIO_ACCOUNT_SID || ''
  if (!accountSid) {
    return errorResponse('Add the Account SID first - there is nothing saved to fall back on')
  }

  // The typed home-region token, then the saved main token. Note the saved
  // fallback deliberately reads TWILIO_AUTH_TOKEN whatever the typed home
  // region is: if the admin is switching country, the old token is the only
  // one saved, and a wrong-region test failing loudly is the point.
  const tokenFor = (region: TwilioRegion): string => {
    const envVar = region === homeRegion ? 'TWILIO_AUTH_TOKEN' : `TWILIO_AUTH_TOKEN_${region.toUpperCase()}`
    return parsed.data.tokens[envVar]?.trim() || process.env[envVar] || ''
  }

  // Every region with a token in play gets its own live check - a working main
  // token says nothing about the Ireland one.
  const regions = await Promise.all(
    TWILIO_REGIONS.filter((r) => tokenFor(r) !== '').map(async (region) => {
      try {
        const accountName = await testCredentials(region, accountSid, tokenFor(region))
        return { region, ok: true as const, accountName }
      } catch (err) {
        return {
          region,
          ok: false as const,
          error: err instanceof Error ? err.message : 'Connection failed',
        }
      }
    })
  )

  if (regions.length === 0) {
    return errorResponse(
      `Add an auth token first - type one in, or save one as ${regionTokenEnvVar(homeRegion)}`
    )
  }

  return NextResponse.json({ regions })
}
