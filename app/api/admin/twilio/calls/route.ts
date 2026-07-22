// GET /api/m/twilio/admin/calls?number=+44... - recent calls to and from one
// of the account's numbers, with any completed recording SIDs attached and the
// voicemail messages among them marked as such.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, listCallsForNumber } from '@/modules/twilio/lib/twilio'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { normalisePhone } from '@/modules/twilio/lib/verification'
import { filterVoicemailSids, transcriptionsForSids } from '@/modules/twilio/lib/voicemail-log'

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
    // Calls live in the Region the number is routed to and nowhere else, so
    // the Region is resolved before the listing rather than defaulted.
    const region = await resolveNumberRegion(number)
    const calls = await listCallsForNumber(number, region)

    // Which of this page's recordings are voicemail messages. Twilio's own
    // listing cannot say, so the answer comes from the rows the voicemail
    // webhook wrote. Recordings made before this module started keeping the log
    // have no row and read as ordinary call recordings.
    const allSids = calls.flatMap((c) => c.recordingSids)
    const [voicemailSids, transcriptions] = await Promise.all([
      filterVoicemailSids(allSids),
      transcriptionsForSids(allSids),
    ])

    return NextResponse.json({
      calls: calls.map((c) => ({
        ...c,
        voicemailSids: c.recordingSids.filter((sid) => voicemailSids.has(sid)),
        // Transcription per recording SID, where one was asked for: the call
        // log shows the words under the voicemail's play button.
        transcriptions: Object.fromEntries(
          c.recordingSids.flatMap((sid) => {
            const t = transcriptions.get(sid)
            return t ? [[sid, t]] : []
          })
        ),
      })),
      region,
    })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to list calls', 502)
  }
}
