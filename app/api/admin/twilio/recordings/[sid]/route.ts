// GET /api/m/twilio/admin/recordings/[sid]?number=+44... - streams a call
// recording's MP3 through the site so the browser can play it without ever
// seeing the Twilio credentials. Session + permission gated; the SID shape is
// validated before it goes anywhere near a URL.
//
// A recording lives in the Region that processed its call, and the SID alone
// does not say which that was - so the call's own number comes along in the
// query and the Region is resolved from it. A wrong Region reads as
// "Recording not found", which is why this is not left to a default.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, fetchRecordingAudio, HOME_REGION } from '@/modules/twilio/lib/twilio'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { normalisePhone } from '@/modules/twilio/lib/verification'

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ sid: string }> }
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) return errorResponse('Twilio is not configured', 503)

  const { sid } = await ctx.params
  if (!/^RE[a-f0-9]{32}$/i.test(sid)) return errorResponse('Invalid recording id')

  try {
    const number = normalisePhone(request.nextUrl.searchParams.get('number') ?? '')
    const region = number ? await resolveNumberRegion(number) : HOME_REGION

    const upstream = await fetchRecordingAudio(sid, region)
    if (!upstream.ok || !upstream.body) {
      return errorResponse(upstream.status === 404 ? 'Recording not found' : 'Failed to fetch recording', upstream.status === 404 ? 404 : 502)
    }
    return new NextResponse(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'audio/mpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to fetch recording', 502)
  }
}
