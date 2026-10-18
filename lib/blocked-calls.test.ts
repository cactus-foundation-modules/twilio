import { beforeEach, describe, expect, it, vi } from 'vitest'

// The drop is one line in the voice webhook and its POSITION is the whole
// point, so that is what these test: not merely that a blocked call is
// refused, but that nothing downstream of the check ever runs. A block that
// rejected the call after taking a voicemail, texting the caller back and
// emailing the office would be a block in name only.

const isNumberBlocked = vi.hoisted(() => vi.fn())
const getRuleForNumber = vi.hoisted(() => vi.fn())
const isRuleOpenNow = vi.hoisted(() => vi.fn())
const resolveNumberRegion = vi.hoisted(() => vi.fn())
const validateTwilioSignature = vi.hoisted(() => vi.fn())
const isTwilioConfigured = vi.hoisted(() => vi.fn())
const getTwilioSettings = vi.hoisted(() => vi.fn())
const offerCallToHandlers = vi.hoisted(() => vi.fn())

vi.mock('@/lib/config/env', () => ({ getSiteUrl: () => 'https://example.test' }))
vi.mock('@/modules/twilio/lib/twilio', () => ({
  validateTwilioSignature,
  isTwilioConfigured,
  escapeXml: (v: string) => v,
}))
vi.mock('@/modules/twilio/lib/forwarding', () => ({ getRuleForNumber, isRuleOpenNow }))
vi.mock('@/modules/twilio/lib/numbers', () => ({ resolveNumberRegion }))
vi.mock('@/modules/twilio/lib/greeting-audio', () => ({ greetingAudioUrl: () => '' }))
vi.mock('@/modules/twilio/lib/voices', () => ({ voiceForRegion: (v: string) => v }))
vi.mock('@/modules/twilio/lib/voicemail', () => ({
  voicemailTwiml: () => '<Say>Leave a message</Say>',
  voicemailUrl: () => 'https://example.test/vm',
  dialActionUrl: (leg: number, attempt: number) =>
    `https://example.test/vm${leg === 2 ? '?leg=2' : attempt > 1 ? `?attempt=${attempt}` : ''}`,
  transcriptionDialAttrs: () => '',
}))
vi.mock('@/modules/twilio/lib/settings', () => ({ getTwilioSettings }))
vi.mock('@/modules/twilio/lib/blocked-numbers', () => ({ isNumberBlocked }))
vi.mock('@/modules/twilio/lib/inbound-call-handlers', () => ({ offerCallToHandlers }))

const { POST } = await import('../app/api/webhooks/twilio/voice/route')

const BLOCKED = '+447700900123'
const ALLOWED = '+447700900999'
const SITE_NUMBER = '+441234567890'

function request(from: string): Request {
  const form = new FormData()
  form.set('From', from)
  form.set('To', SITE_NUMBER)
  return new Request('https://example.test/api/m/twilio/webhooks/voice', {
    method: 'POST',
    headers: { 'x-twilio-signature': 'a-signature' },
    body: form,
  })
}

function openForwardingRule() {
  return {
    enabled: true,
    forwardTo: '+441111111111',
    forwardToSecond: '',
    anonymousCallers: 'allow',
    voicemailEnabled: true,
    recordCalls: false,
    showCalledNumber: false,
    ringTimeout: 20,
    forwardAttempts: 1,
    greetingMessage: '',
    greetingAudioMediaId: null,
    greetingVoice: '',
    voicemailVoice: '',
    missedCallSmsEnabled: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  isTwilioConfigured.mockReturnValue(true)
  validateTwilioSignature.mockReturnValue(true)
  getRuleForNumber.mockResolvedValue(openForwardingRule())
  isRuleOpenNow.mockResolvedValue(true)
  resolveNumberRegion.mockResolvedValue('ie1')
  getTwilioSettings.mockResolvedValue({ notifyMissedCallEmail: false, notifyEmail: '' })
  isNumberBlocked.mockResolvedValue(false)
  offerCallToHandlers.mockResolvedValue(null)
})

describe('a blocked caller', () => {
  it('is rejected outright, so nothing rings', async () => {
    isNumberBlocked.mockResolvedValue(true)

    const response = await POST(request(BLOCKED) as never)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<Reject/>')
  })

  // The one that matters. Every one of these is a thing that happens to
  // somebody: a phone ringing, a message recorded, a region looked up, the
  // office told. A blocked call reaches none of them.
  it('never reaches the forwarding rule, the region or the opening hours', async () => {
    isNumberBlocked.mockResolvedValue(true)

    const response = await POST(request(BLOCKED) as never)

    expect(await response.text()).not.toContain('<Dial')
    expect(getRuleForNumber).not.toHaveBeenCalled()
    expect(resolveNumberRegion).not.toHaveBeenCalled()
    expect(isRuleOpenNow).not.toHaveBeenCalled()
  })

  it('is only asked about after the signature has been checked', async () => {
    validateTwilioSignature.mockReturnValue(false)

    const response = await POST(request(BLOCKED) as never)

    // An unsigned request must not be able to use this route to find out who is
    // on the list, so the check is never even reached.
    expect(response.status).toBe(403)
    expect(isNumberBlocked).not.toHaveBeenCalled()
  })
})

describe('everybody else', () => {
  it('rings through exactly as before', async () => {
    const response = await POST(request(ALLOWED) as never)

    expect(await response.text()).toContain('<Dial')
    expect(isNumberBlocked).toHaveBeenCalledWith(ALLOWED)
    expect(getRuleForNumber).toHaveBeenCalledWith(SITE_NUMBER)
  })
})

// A module may answer a call itself (lib/inbound-call-handlers.ts). Where it
// sits matters as much as the block does: after the block, so a blocked caller
// never reaches an assistant that costs money by the minute.
describe('another module answering the call', () => {
  it('is never offered a blocked call', async () => {
    isNumberBlocked.mockResolvedValue(true)
    await POST(request(BLOCKED) as never)
    expect(offerCallToHandlers).not.toHaveBeenCalled()
  })

  it('answers instead of forwarding when it returns TwiML', async () => {
    offerCallToHandlers.mockResolvedValue('<Connect><Stream url="wss://example.test"/></Connect>')
    const response = await POST(request(ALLOWED) as never)
    const body = await response.text()
    expect(body).toContain('<Connect>')
    expect(body).not.toContain('<Dial')
  })

  it('is told what the number itself would have done', async () => {
    await POST(request(ALLOWED) as never)
    expect(offerCallToHandlers).toHaveBeenCalledWith(expect.objectContaining({
      to: SITE_NUMBER, from: ALLOWED, open: true, wouldForward: true, anonymous: false,
    }))
  })

  it('leaves forwarding alone when it declines', async () => {
    const response = await POST(request(ALLOWED) as never)
    expect(await response.text()).toContain('<Dial')
  })
})
