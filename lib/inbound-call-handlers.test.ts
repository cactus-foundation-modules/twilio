import { beforeEach, describe, expect, it, vi } from 'vitest'

const registry: Record<string, Record<string, unknown>> = {}
const installed: Array<{ name: string; manifest: unknown }> = []

vi.mock('@/lib/db/prisma', () => ({ prisma: { module: { findMany: async () => installed } } }))
vi.mock('@/lib/modules/live-status', () => ({ INSTALLED_MODULE_WHERE: {} }))
vi.mock('@/lib/modules/extension-points.server', () => ({ moduleServerExtensionPointComponents: registry }))

import { INBOUND_CALL_HANDLER_POINT, offerCallToHandlers, type InboundCallContext } from './inbound-call-handlers'

const call: InboundCallContext = {
  callSid: 'CA1', from: '+447700900123', to: '+441234567890', anonymous: false, open: true, wouldForward: true,
}

function install(entries: Array<{ module: string; id: string; handler: unknown }>) {
  for (const key of Object.keys(registry)) delete registry[key]
  installed.length = 0
  registry[INBOUND_CALL_HANDLER_POINT] = {}
  for (const entry of entries) {
    registry[INBOUND_CALL_HANDLER_POINT]![entry.id] = entry.handler
    installed.push({
      name: entry.module,
      manifest: { extensionPoints: [{ point: INBOUND_CALL_HANDLER_POINT, id: entry.id }] },
    })
  }
}

describe('offerCallToHandlers', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('declines when nothing is installed', async () => {
    install([])
    expect(await offerCallToHandlers(call)).toBeNull()
  })

  it('returns the TwiML of a handler that takes the call', async () => {
    install([{ module: 'a', id: 'a', handler: async () => '<Connect/>' }])
    expect(await offerCallToHandlers(call)).toBe('<Connect/>')
  })

  it('hands the call details to the handler', async () => {
    const handler = vi.fn(async () => null)
    install([{ module: 'a', id: 'a', handler }])
    await offerCallToHandlers(call)
    expect(handler).toHaveBeenCalledWith(call)
  })

  it('treats a handler that declines as a no, and asks the next', async () => {
    install([
      { module: 'a', id: 'a', handler: async () => null },
      { module: 'b', id: 'b', handler: async () => '<Say>Hi</Say>' },
    ])
    expect(await offerCallToHandlers(call)).toBe('<Say>Hi</Say>')
  })

  it('falls through when a handler throws, never failing the call', async () => {
    install([{ module: 'a', id: 'a', handler: async () => { throw new Error('boom') } }])
    expect(await offerCallToHandlers(call)).toBeNull()
  })

  it('ignores blank answers and entries that are not functions', async () => {
    install([
      { module: 'a', id: 'a', handler: async () => '   ' },
      { module: 'b', id: 'b', handler: 'not a function' },
    ])
    expect(await offerCallToHandlers(call)).toBeNull()
  })
})

describe('unanswered offer', () => {
  it('passes the unanswered flag through to the handler', async () => {
    let seen: InboundCallContext | null = null
    install([{ module: 'a', id: 'a', handler: async (c: InboundCallContext) => { seen = c; return '<Connect/>' } }])
    expect(await offerCallToHandlers({ ...call, unanswered: true })).toBe('<Connect/>')
    expect((seen as InboundCallContext | null)?.unanswered).toBe(true)
  })
})
