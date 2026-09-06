// POST /api/m/twilio/admin/make-call - two-leg click-to-dial from the settings
// screen. The call itself is placed by lib/click-to-dial.ts, which core's
// `core.dialler` seam also uses, so the settings screen and a module ringing
// somebody from the inbox make the same call with the same caller-ID checks.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { placeClickToDial } from '@/modules/twilio/lib/click-to-dial'

const Body = z.object({
  // The Twilio number the call goes out from (must be on the account).
  fromNumber: z.string().min(1),
  // Who to dial once the admin has picked up and pressed a key.
  to: z.string().min(1),
  // Where to ring the admin.
  callMeAt: z.string().min(1),
})

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')

  try {
    const result = await placeClickToDial(parsed.data)
    if (!result.ok) {
      // Nothing to place the call with is a different answer from a number
      // typed wrong, and the settings screen has always said so.
      return errorResponse(result.reason, result.code === 'not-configured' ? 503 : 400)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to place call', 502)
  }
}
