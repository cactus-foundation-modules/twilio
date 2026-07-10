// /api/m/twilio/admin/site-numbers - which of the account's Twilio numbers
// are on this site, and which one texts are sent from.
// GET  - account numbers merged with site state (also refreshes stored
//        Twilio metadata and prunes numbers gone from the account)
// POST - { action: 'add' | 'remove' | 'set-default-sms', sid }
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured, listIncomingNumbers } from '@/modules/twilio/lib/twilio'
import {
  addSiteNumber,
  getSiteNumbers,
  removeSiteNumber,
  setDefaultSmsNumber,
  syncSiteNumbers,
} from '@/modules/twilio/lib/numbers'

async function mergedListing() {
  const account = await listIncomingNumbers()
  await syncSiteNumbers(account.map((n) => ({
    sid: n.sid,
    phoneNumber: n.phoneNumber,
    friendlyName: n.friendlyName,
    smsCapable: n.smsCapable,
  })))
  const site = await getSiteNumbers()
  const siteBySid = new Map(site.map((s) => [s.phoneSid, s]))
  return account.map((n) => {
    const onSite = siteBySid.get(n.sid)
    return {
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      smsCapable: n.smsCapable,
      onSite: !!onSite,
      isDefaultSms: onSite?.isDefaultSms ?? false,
    }
  })
}

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured. Add your credentials first.', 503)
  }

  try {
    return NextResponse.json({ numbers: await mergedListing() })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to list numbers', 502)
  }
}

const Body = z.object({
  action: z.enum(['add', 'remove', 'set-default-sms']),
  sid: z.string().min(1),
})

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured. Add your credentials first.', 503)
  }

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')
  const { action, sid } = parsed.data

  try {
    if (action === 'add') {
      // Only numbers actually on the Twilio account can be added, and the
      // capability flag comes from Twilio - never from the client.
      const account = await listIncomingNumbers()
      const match = account.find((n) => n.sid === sid)
      if (!match) return errorResponse('That number is not on your Twilio account', 404)
      await addSiteNumber({
        phoneSid: match.sid,
        phoneNumber: match.phoneNumber,
        friendlyName: match.friendlyName,
        smsCapable: match.smsCapable,
      })
    } else if (action === 'remove') {
      await removeSiteNumber(sid)
    } else {
      await setDefaultSmsNumber(sid)
    }
    return NextResponse.json({ numbers: await mergedListing() })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to update numbers', 502)
  }
}
