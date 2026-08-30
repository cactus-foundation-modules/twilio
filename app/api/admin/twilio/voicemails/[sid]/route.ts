// DELETE /api/m/twilio/admin/voicemails/[sid] - removes a voicemail from both
// the local database and Twilio's cloud. The recording SID is the natural key;
// the site number comes along in the query so the deletion hits the right
// Twilio region. Session + permission gated.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, deleteRecording } from '@/modules/twilio/lib/twilio'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { normalisePhone } from '@/modules/twilio/lib/verification'
import { deleteVoicemail } from '@/modules/twilio/lib/voicemail-log'
import { getHomeRegion } from '@/modules/twilio/lib/twilio'

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ sid: string }> }
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) return errorResponse('Twilio is not configured', 503)

  const { sid } = await ctx.params
  if (!/^RE[a-f0-9]{32}$/i.test(sid)) return errorResponse('Invalid recording id', 400)

  try {
    // Resolve the region from the site number so the deletion hits the right
    // Twilio data centre. Falls back to the home region if no number is given.
    const number = normalisePhone(request.nextUrl.searchParams.get('number') ?? '')
    const region = number ? await resolveNumberRegion(number) : getHomeRegion()

    // Delete from Twilio first - if that fails, the local row stays and the
    // admin can try again. Deleting locally first would orphan the recording.
    await deleteRecording(sid, region)
    await deleteVoicemail(sid)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[twilio] failed to delete voicemail', sid, err)
    return errorResponse(
      err instanceof Error ? err.message : 'Failed to delete voicemail',
      502
    )
  }
}
