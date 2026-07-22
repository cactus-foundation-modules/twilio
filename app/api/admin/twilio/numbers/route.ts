// GET /api/m/twilio/admin/numbers - Twilio incoming numbers merged with this
// module's forwarding rules.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, listIncomingNumbers } from '@/modules/twilio/lib/twilio'
import { getForwardingRules } from '@/modules/twilio/lib/forwarding'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { prisma } from '@/lib/db/prisma'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured. Add your credentials on the settings page first.', 503)
  }

  try {
    const [numbers, rules] = await Promise.all([listIncomingNumbers(), getForwardingRules()])
    const rulesBySid = new Map(rules.map((r) => [r.phoneSid, r]))
    // The Region each number's calls are processed in decides which greeting
    // voices its calls can actually say, so the voice pickers need it. A failed
    // lookup reads as null - unknown - rather than a guess.
    const regions = new Map(
      await Promise.all(
        numbers.map(async (n): Promise<[string, string | null]> => {
          try {
            return [n.sid, await resolveNumberRegion(n.phoneNumber)]
          } catch {
            return [n.sid, null]
          }
        })
      )
    )
    // Display names for any uploaded greeting audio, so the form can say which
    // file is in play rather than showing a bare id. A missing row (file
    // deleted from the library) reads as null and the UI says so.
    const audioIds = [
      ...new Set(
        rules.flatMap((r) =>
          [r.greetingAudioMediaId, r.voicemailAudioMediaId, r.closedVoicemailAudioMediaId].filter(Boolean)
        )
      ),
    ]
    const audioNames = new Map(
      audioIds.length
        ? (
            await prisma.media.findMany({
              where: { id: { in: audioIds } },
              select: { id: true, originalName: true },
            })
          ).map((m) => [m.id, m.originalName ?? 'audio file'])
        : []
    )
    const audioField = (id: string) =>
      id ? { id, name: audioNames.get(id) ?? null } : null
    return NextResponse.json({
      numbers: numbers.map((n) => {
        const rule = rulesBySid.get(n.sid)
        return {
          sid: n.sid,
          phoneNumber: n.phoneNumber,
          friendlyName: n.friendlyName,
          voiceUrl: n.voiceUrl,
          region: regions.get(n.sid) ?? null,
          forwardTo: rule?.forwardTo ?? '',
          forwardingEnabled: rule?.enabled ?? false,
          greetingMessage: rule?.greetingMessage ?? '',
          greetingVoice: rule?.greetingVoice ?? '',
          recordCalls: rule?.recordCalls ?? false,
          showCalledNumber: rule?.showCalledNumber ?? false,
          voicemailEnabled: rule?.voicemailEnabled ?? false,
          ringTimeout: rule?.ringTimeout ?? 20,
          voicemailGreeting: rule?.voicemailGreeting ?? '',
          closedVoicemailGreeting: rule?.closedVoicemailGreeting ?? '',
          voicemailVoice: rule?.voicemailVoice ?? '',
          businessHours: rule?.businessHours ?? [],
          greetingAudio: audioField(rule?.greetingAudioMediaId ?? ''),
          voicemailAudio: audioField(rule?.voicemailAudioMediaId ?? ''),
          closedVoicemailAudio: audioField(rule?.closedVoicemailAudioMediaId ?? ''),
        }
      }),
    })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to list numbers', 502)
  }
}
