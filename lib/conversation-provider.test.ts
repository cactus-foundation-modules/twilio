import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

// The phone, in the shape core asks for when it puts several channels in one
// list.
//
// This module is shaped differently from the others: only voicemail is written
// down here, and calls and texts are read live from Twilio. So the two things
// worth guarding are that everything from one number is one conversation with
// one human, and that reading it is bounded and cached - it is meant for an
// hourly tick, not for every time somebody draws a screen.

const getSiteNumbers = vi.hoisted(() => vi.fn())
const sendSiteSms = vi.hoisted(() => vi.fn())
const isTwilioConfigured = vi.hoisted(() => vi.fn())
const listCallsForNumber = vi.hoisted(() => vi.fn())
const listMessagesForNumber = vi.hoisted(() => vi.fn())
const recentVoicemails = vi.hoisted(() => vi.fn())

vi.mock('./numbers', () => ({ getSiteNumbers, sendSiteSms }))
vi.mock('./twilio', () => ({ isTwilioConfigured, listCallsForNumber, listMessagesForNumber }))
vi.mock('./voicemail-log', () => ({ recentVoicemails }))

const { twilioConversationProvider: provider, forgetCachedConversations } = await import(
  './conversation-provider'
)

const siteNumber = {
  phoneSid: 'PN1',
  phoneNumber: '+441134960000',
  friendlyName: 'Office',
  smsCapable: true,
  isDefaultSms: true,
  region: 'ie1' as const,
}

const call = {
  sid: 'CA1',
  from: '+447700900123',
  to: '+441134960000',
  direction: 'inbound' as const,
  status: 'completed',
  startTime: '2026-08-27T09:00:00Z',
  durationSeconds: 95,
  recordingSids: [],
}

const text = {
  sid: 'SM1',
  from: '+447700900123',
  to: '+441134960000',
  direction: 'inbound' as const,
  status: 'received',
  dateSent: '2026-08-27T10:00:00Z',
  body: 'Are you open on Saturday?',
}

beforeEach(() => {
  getSiteNumbers.mockReset().mockResolvedValue([siteNumber])
  sendSiteSms.mockReset().mockResolvedValue(undefined)
  isTwilioConfigured.mockReset().mockReturnValue(true)
  listCallsForNumber.mockReset().mockResolvedValue([call])
  listMessagesForNumber.mockReset().mockResolvedValue([text])
  recentVoicemails.mockReset().mockResolvedValue([])
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers({ now: new Date('2026-08-27T12:00:00Z') })
  // Each test starts with nothing collected: the listing is deliberately held
  // for a few minutes, which would otherwise make every test after the first
  // one an assertion about the first one's answer.
  forgetCachedConversations()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listing', () => {
  it('makes one conversation out of everything from one number', async () => {
    const page = await provider.list({ limit: 25 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      id: '+447700900123',
      channel: 'phone',
      participant: { name: null, email: null, phone: '+447700900123' },
      preview: 'Are you open on Saturday?',
      href: 'm/twilio',
    })
  })

  it('calls it a text conversation when that is all it is', async () => {
    listCallsForNumber.mockResolvedValue([])
    const page = await provider.list({ limit: 25 })
    expect(page.items[0]!.channel).toBe('sms')
  })

  it('does not make a conversation out of one of our own numbers ringing another', async () => {
    listCallsForNumber.mockResolvedValue([{ ...call, from: '+441134960000', to: '+441134960000' }])
    listMessagesForNumber.mockResolvedValue([])
    expect((await provider.list({ limit: 25 })).items).toEqual([])
  })

  it('reads the account once and reuses it, because this is not for every page view', async () => {
    await provider.list({ limit: 25 })
    await provider.list({ limit: 25 })
    await provider.thread('+447700900123')
    expect(listCallsForNumber).toHaveBeenCalledTimes(1)
  })

  it('asks Twilio nothing at all when there are no credentials', async () => {
    isTwilioConfigured.mockReturnValue(false)
    expect((await provider.list({ limit: 25 })).items).toEqual([])
    expect(getSiteNumbers).not.toHaveBeenCalled()
  })

  it('still lists the texts when the calls could not be read', async () => {
    listCallsForNumber.mockRejectedValue(new Error('region has nothing'))
    const page = await provider.list({ limit: 25 })
    expect(page.items[0]).toMatchObject({ id: '+447700900123', channel: 'sms' })
  })
})

describe('one conversation', () => {
  it('is every call, voicemail and text with that person, oldest first', async () => {
    recentVoicemails.mockResolvedValue([
      {
        recordingSid: 'RE1',
        callSid: 'CA0',
        fromNumber: '+447700900123',
        toNumber: '+441134960000',
        durationSeconds: 22,
        createdAt: new Date('2026-08-26T08:00:00Z'),
        transcriptionStatus: 'completed',
        transcriptionText: 'Hello, it is Ada, could you ring me back',
      },
    ])
    const thread = await provider.thread('+447700900123')
    expect(thread!.messages.map((m) => m.id)).toEqual(['voicemail:RE1', 'call:CA1', 'sms:SM1'])
    expect(thread!.messages[0]!.text).toContain('ring me back')
    expect(thread!.messages[0]!.attachments).toHaveLength(1)
    expect(thread!.messages[0]!.attachments[0]).toMatchObject({
      filename: 'voicemail-RE1.mp3',
      contentType: 'audio/mpeg',
    })
    expect(thread!.messages[0]!.attachments[0]!.url).toContain('/api/m/twilio/admin/recordings/RE1')
    expect(thread!.messages[0]!.attachments[0]!.url).toContain('number=%2B441134960000')
    expect(thread!.messages[1]!.text).toBe('Incoming call, 1 min 35 sec')
  })

  it('says a missed call was missed rather than pretending it was a chat', async () => {
    listCallsForNumber.mockResolvedValue([{ ...call, status: 'no-answer', durationSeconds: 0 }])
    listMessagesForNumber.mockResolvedValue([])
    const thread = await provider.thread('+447700900123')
    expect(thread!.messages[0]!.text).toBe('Missed call')
  })

  it('finds a number however it was punctuated', async () => {
    expect(await provider.thread('+44 7700 900123')).not.toBeNull()
  })

  it('is null for a number nobody has rung', async () => {
    expect(await provider.thread('+447700900999')).toBeNull()
  })
})

describe('texting back', () => {
  it('sends from the site’s own number', async () => {
    await provider.send!('+447700900123', { text: 'We are, until one.', authorUserId: 'u1' })
    expect(sendSiteSms).toHaveBeenCalledWith('+447700900123', 'We are, until one.')
  })

  it('refuses a withheld caller in words rather than failing at Twilio', async () => {
    await expect(
      provider.send!('anonymous', { text: 'hello', authorUserId: 'u1' }),
    ).rejects.toThrow(/withheld/)
    expect(sendSiteSms).not.toHaveBeenCalled()
  })
})

describe('one person’s history', () => {
  it('matches them by their number', async () => {
    const found = await provider.byIdentity!({ emails: [], phones: ['+44 7700 900123'] })
    expect(found.map((f) => f.id)).toEqual(['+447700900123'])
  })

  it('costs nothing when there is no number to go on', async () => {
    expect(await provider.byIdentity!({ emails: ['ada@example.com'], phones: [] })).toEqual([])
    expect(getSiteNumbers).not.toHaveBeenCalled()
  })
})
