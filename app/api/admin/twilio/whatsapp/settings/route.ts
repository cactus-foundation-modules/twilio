// GET/PUT /api/m/twilio/admin/whatsapp/settings - whether the site offers
// WhatsApp, which number it goes out from, and which Twilio region that number
// is processed in.
//
// Separate from the module settings route next door even though both write the
// same singleton row: each touches only its own columns, so saving the alert
// settings cannot quietly revert the WhatsApp sender or the other way about.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { TWILIO_REGIONS, isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import {
  WHATSAPP_SANDBOX_SENDER,
  configProblem,
  getWhatsAppConfig,
  updateWhatsAppConfig,
} from '@/modules/twilio/lib/whatsapp-config'
import { normalisePhone } from '@/modules/twilio/lib/verification'
import { getSiteNumbers } from '@/modules/twilio/lib/numbers'

const Body = z.object({
  enabled: z.boolean(),
  sender: z.string().trim().max(20),
  region: z.enum(TWILIO_REGIONS),
})

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const config = await getWhatsAppConfig()
  // The site's own numbers are offered alongside the sandbox one, because a
  // real WhatsApp sender is almost always a number the site already has - and
  // typing a number out again is how a digit goes missing.
  const numbers = isTwilioConfigured()
    ? (await getSiteNumbers().catch(() => [])).map((n) => ({
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
        region: n.region,
      }))
    : []

  return NextResponse.json({ ...config, siteNumbers: numbers, sandboxSender: WHATSAPP_SANDBOX_SENDER })
}

export async function PUT(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Invalid input')

  // Stored in one shape whatever was typed, so the number a message goes out
  // from is the number the settings screen shows.
  const sender = parsed.data.sender ? (normalisePhone(parsed.data.sender) ?? parsed.data.sender) : ''
  const config = { ...parsed.data, sender }

  const problem = configProblem(config)
  if (problem) return errorResponse(problem)

  await updateWhatsAppConfig(config)
  return NextResponse.json(await getWhatsAppConfig())
}
