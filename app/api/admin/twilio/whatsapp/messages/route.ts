// GET/POST /api/m/twilio/admin/whatsapp/messages - the WhatsApp log, and
// sending one.
//
// GET returns the messages the sending number has exchanged, newest first, with
// whether each person can still be written to in plain words. POST sends
// either a free-text message or an approved template; which of the two is
// allowed at any moment is Meta's rule, not ours, so the answer is worked out
// here rather than guessed at on the screen.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { normalisePhone } from '@/modules/twilio/lib/verification'
import {
  getWhatsAppSender,
  getWhatsAppTemplate,
  MAX_TEMPLATE_VARIABLES,
} from '@/modules/twilio/lib/whatsapp-config'
import {
  isWindowOpen,
  listWhatsAppMessages,
  sendWhatsAppTemplate,
  sendWhatsAppText,
  windowProblem,
} from '@/modules/twilio/lib/whatsapp'
import { forgetCachedWhatsApp } from '@/modules/twilio/lib/whatsapp-conversation-provider'

/** How much of the log one request returns. */
const PAGE = 100

/** A WhatsApp message body. Meta's own ceiling is 4096 characters. */
const MAX_BODY = 4096

const Body = z
  .object({
    to: z.string().trim().max(20),
    text: z.string().trim().max(MAX_BODY).optional(),
    contentSid: z.string().trim().max(40).optional(),
    variables: z.array(z.string().max(500)).max(MAX_TEMPLATE_VARIABLES).optional(),
  })
  // One or the other, never both: a request carrying a body AND a template is
  // two different messages and there is no sensible way to pick.
  .refine((v) => (!!v.text?.trim()) !== (!!v.contentSid), {
    message: 'Send either a message or a template, not both',
  })

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) return errorResponse('Twilio is not configured', 503)

  const sender = await getWhatsAppSender()
  if (!sender) return NextResponse.json({ ready: false, sender: null, messages: [] })

  try {
    const messages = await listWhatsAppMessages(sender.phoneNumber, sender.region, PAGE)

    // When each person last wrote, so the screen can say who may be written
    // back to in plain text and who needs a template. Worked out from the same
    // listing rather than from a second read.
    const lastInbound = new Map<string, string>()
    for (const message of messages) {
      if (message.direction !== 'inbound') continue
      const at = lastInbound.get(message.from)
      if (!at || Date.parse(message.dateSent || '0') > Date.parse(at)) {
        lastInbound.set(message.from, message.dateSent)
      }
    }
    const windows = [...lastInbound.entries()].map(([phoneNumber, at]) => ({
      phoneNumber,
      lastInboundAt: at,
      open: isWindowOpen(new Date(at)),
    }))

    return NextResponse.json({ ready: true, sender: sender.phoneNumber, messages, windows })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'The WhatsApp messages could not be read', 502)
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  if (!isTwilioConfigured()) {
    return errorResponse('Twilio is not configured. Add your credentials on the settings page first.', 503)
  }

  const parsed = Body.safeParse(await request.json())
  if (!parsed.success) {
    return errorResponse(parsed.error.issues[0]?.message ?? 'Invalid input')
  }
  const { text, contentSid, variables = [] } = parsed.data

  const to = normalisePhone(parsed.data.to)
  if (!to) return errorResponse('The number must be in international format, e.g. +447700900123')

  const sender = await getWhatsAppSender()
  if (!sender) {
    return errorResponse('WhatsApp is not switched on yet - turn it on and choose a sending number first')
  }

  try {
    if (contentSid) {
      // Only templates this site has registered may be sent. A Content SID
      // arriving from the browser is a value somebody typed, and sending an
      // arbitrary one would put whatever Meta approved for somebody else's
      // account in front of a customer.
      const template = await getWhatsAppTemplate(contentSid)
      if (!template) return errorResponse('That template is not one of yours - add it on the WhatsApp tab first')
      if (variables.length !== template.variableCount) {
        return errorResponse(
          template.variableCount === 1
            ? 'That template needs exactly one value filling in'
            : `That template needs exactly ${template.variableCount} values filling in`,
        )
      }
      const sid = await sendWhatsAppTemplate(to, contentSid, variables, sender.phoneNumber, sender.region)
      forgetCachedWhatsApp()
      return NextResponse.json({ ok: true, sid, from: sender.phoneNumber })
    }

    // Free text only inside the 24-hour window. Checked here rather than left
    // to Twilio, which accepts an out-of-window message and lets Meta drop it -
    // so without this the screen would say sent and the customer would never
    // see it.
    const recent = await listWhatsAppMessages(sender.phoneNumber, sender.region, 100)
    const lastInbound = recent
      .filter((m) => m.direction === 'inbound' && m.from === to)
      .map((m) => new Date(m.dateSent || 0))
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    const problem = windowProblem(lastInbound)
    if (problem) return errorResponse(problem)

    const sid = await sendWhatsAppText(to, text!, sender.phoneNumber, sender.region)
    forgetCachedWhatsApp()
    return NextResponse.json({ ok: true, sid, from: sender.phoneNumber })
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'That WhatsApp message could not be sent', 502)
  }
}
