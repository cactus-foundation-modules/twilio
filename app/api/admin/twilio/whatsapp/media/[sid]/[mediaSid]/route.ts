// GET /api/m/twilio/admin/whatsapp/media/[sid]/[mediaSid] - streams one file
// somebody sent over WhatsApp through the site, so the browser can show it
// without ever seeing the Twilio credentials.
//
// Twilio's media URLs sit behind the account's basic auth, which is why this is
// a proxy rather than a link. Both SID shapes are checked before either goes
// near a URL, and the region comes from the WhatsApp sender's own setting -
// media lives where its message was processed, and asking the wrong region
// reads as "not found".
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { fetchMessageMedia, isMediaSid, isMessageSid } from '@/modules/twilio/lib/whatsapp'
import { getWhatsAppConfig } from '@/modules/twilio/lib/whatsapp-config'

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ sid: string; mediaSid: string }> },
) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) return errorResponse('Twilio is not configured', 503)

  const { sid, mediaSid } = await ctx.params
  if (!isMessageSid(sid)) return errorResponse('Invalid message id')
  if (!isMediaSid(mediaSid)) return errorResponse('Invalid media id')

  try {
    const { region } = await getWhatsAppConfig()
    const upstream = await fetchMessageMedia(sid, mediaSid, region)
    if (!upstream.ok || !upstream.body) {
      return errorResponse(
        upstream.status === 404 ? 'That file is no longer on Twilio' : 'That file could not be fetched',
        upstream.status === 404 ? 404 : 502,
      )
    }
    return new NextResponse(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        // Private: this is somebody's message, and it is only ever fetched by a
        // signed-in admin. A shared cache must not keep a copy.
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'That file could not be fetched', 502)
  }
}
