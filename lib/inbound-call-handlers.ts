import { prisma } from '@/lib/db/prisma'
import { INSTALLED_MODULE_WHERE } from '@/lib/modules/live-status'

// `twilio.inbound-call-handler` - another module may answer a call itself.
//
// Forwarding and voicemail are what this module does with a call nobody else
// wants. A module that has its own idea of how a call should be answered (a
// voice assistant, a call-queue, an out-of-hours service) publishes a handler
// here and is offered every call that reaches the voice webhook, after the
// blocked-caller and withheld-number checks and before forwarding is decided.
//
// The handler says YES by returning TwiML and NO by returning null, and a
// handler that throws is a NO. That last part is the whole safety story: a
// third party having a bad day must never turn into a dead line, so anything
// other than a clean answer falls straight through to the number's ordinary
// forwarding and voicemail, exactly as though no handler were installed.
//
// This file names no module. A site with no handler installed pays one
// registry lookup and nothing else.
//
// SERVER ONLY. The manifest entry that publishes a handler must set
// `serverOnly: true`, because a handler reaches whatever credentials it needs.

export const INBOUND_CALL_HANDLER_POINT = 'twilio.inbound-call-handler'

/** What a handler is told about the call. Plain strings and booleans: nothing
 *  here is a Twilio object, so a handler needs no knowledge of this module's
 *  internals to read it. */
export type InboundCallContext = {
  /** Twilio's id for the call. */
  callSid: string
  /** The caller's number as Twilio reported it, or '' when it was withheld. */
  from: string
  /** The site number that was dialled, E.164. */
  to: string
  /** True when the caller withheld their number. */
  anonymous: boolean
  /** Whether the number is inside its opening hours right now. */
  open: boolean
  /** Whether the number's own rules would ring a phone for this call. */
  wouldForward: boolean
  /** True when this is the SECOND time the call is offered: the number's
   *  forwarding rang every phone it was set to ring, as many times as it was set
   *  to, and nobody answered. A handler that answers only "when nobody else
   *  does" takes the call here. Absent on the first offer. */
  unanswered?: boolean
}

/** Returns the inner TwiML (what goes between `<Response>` tags) to answer the
 *  call, or null to leave it to forwarding and voicemail. */
export type InboundCallHandler = (context: InboundCallContext) => Promise<string | null>

type ExtensionPointEntry = { point: string; id: string }

function isHandler(value: unknown): value is InboundCallHandler {
  return typeof value === 'function'
}

/** Whether any module publishes a handler at all. The voice webhook asks so that
 *  a forwarded call with no other follow-up still reports back when it rings
 *  out - otherwise nothing would ever offer it to the handler. */
export async function hasInboundCallHandlers(): Promise<boolean> {
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  return Object.keys(moduleServerExtensionPointComponents[INBOUND_CALL_HANDLER_POINT] ?? {}).length > 0
}

/** Offers the call to every installed handler in manifest order. The first to
 *  return TwiML wins; null when nobody takes it. Never throws. */
export async function offerCallToHandlers(context: InboundCallContext): Promise<string | null> {
  // Dynamic on purpose, for the reason lib/dialler/registry.ts gives: the
  // generated registry imports module code, and a static edge back to it can
  // close an import cycle that only a production build notices. The server map
  // rather than the full one, as lib/conversations/arrived.ts does: a handler
  // is server-only by contract and has no business near a client bundle.
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  const components = moduleServerExtensionPointComponents[INBOUND_CALL_HANDLER_POINT] ?? {}
  if (Object.keys(components).length === 0) return null

  const modules = await prisma.module.findMany({
    where: { ...INSTALLED_MODULE_WHERE },
    select: { name: true, manifest: true },
    orderBy: { name: 'asc' },
  })

  for (const mod of modules) {
    const manifest = mod.manifest as { extensionPoints?: ExtensionPointEntry[] } | null
    for (const entry of manifest?.extensionPoints ?? []) {
      if (entry.point !== INBOUND_CALL_HANDLER_POINT) continue
      const handler = components[entry.id]
      if (!isHandler(handler)) continue
      try {
        const twiml = await handler(context)
        if (typeof twiml === 'string' && twiml.trim() !== '') return twiml
      } catch (err) {
        console.error(`[twilio] inbound call handler ${mod.name}/${entry.id} failed, falling back`, err)
      }
    }
  }
  return null
}
