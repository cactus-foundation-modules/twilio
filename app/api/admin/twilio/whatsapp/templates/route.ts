// GET/POST/DELETE /api/m/twilio/admin/whatsapp/templates - the approved
// message templates this site means to use.
//
// WhatsApp will only carry free text for 24 hours after the customer's last
// message. Outside that, Meta takes nothing but a template it has approved,
// addressed by its Twilio Content SID. Twilio knows which templates exist; only
// the site knows which of them it actually uses and what to call them in front
// of staff, so they are registered here rather than listed from Twilio.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import {
  MAX_TEMPLATE_VARIABLES,
  deleteWhatsAppTemplate,
  listWhatsAppTemplates,
  saveWhatsAppTemplate,
} from '@/modules/twilio/lib/whatsapp-config'

const Body = z.object({
  contentSid: z.string().trim().max(40),
  label: z.string().trim().min(1).max(80),
  variableCount: z.number().int().min(0).max(MAX_TEMPLATE_VARIABLES),
})

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  return NextResponse.json({ templates: await listWhatsAppTemplates() })
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) return errorResponse('Give the template a name and its id from Twilio')

  try {
    await saveWhatsAppTemplate(parsed.data)
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'That template could not be saved')
  }
  return NextResponse.json({ templates: await listWhatsAppTemplates() })
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const id = request.nextUrl.searchParams.get('id') ?? ''
  if (!id) return errorResponse('Which template?')

  await deleteWhatsAppTemplate(id)
  return NextResponse.json({ templates: await listWhatsAppTemplates() })
}
