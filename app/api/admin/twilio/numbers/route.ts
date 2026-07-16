// GET /api/m/twilio/admin/numbers - Twilio incoming numbers merged with this
// module's forwarding rules.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, listIncomingNumbers } from '@/modules/twilio/lib/twilio'
import { getForwardingRules } from '@/modules/twilio/lib/forwarding'

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
    return NextResponse.json({
      numbers: numbers.map((n) => {
        const rule = rulesBySid.get(n.sid)
        return {
          sid: n.sid,
          phoneNumber: n.phoneNumber,
          friendlyName: n.friendlyName,
          voiceUrl: n.voiceUrl,
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
        }
      }),
    })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to list numbers', 502)
  }
}
