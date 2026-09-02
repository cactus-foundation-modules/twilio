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
const deleteVoicemail = vi.hoisted(() => vi.fn())
const deleteRecording = vi.hoisted(() => vi.fn())
const getHomeRegion = vi.hoisted(() => vi.fn())
const resolveNumberRegion = vi.hoisted(() => vi.fn())
const blockNumber = vi.hoisted(() => vi.fn())
const unblockNumber = vi.hoisted(() => vi.fn())
const isNumberBlocked = vi.hoisted(() => vi.fn())

class NotBlockableError extends Error {}

vi.mock('./numbers', () => ({ getSiteNumbers, sendSiteSms, resolveNumberRegion }))
vi.mock('./twilio', () => ({
  isTwilioConfigured, listCallsForNumber, listMessagesForNumber, deleteRecording, getHomeRegion,
}))
vi.mock('./voicemail-log', () => ({ recentVoicemails, deleteVoicemail }))
vi.mock('./blocked-numbers', () => ({
  NotBlockableError, blockNumber, unblockNumber, isNumberBlocked,
}))

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
  deleteVoicemail.mockReset().mockResolvedValue(undefined)
  deleteRecording.mockReset().mockResolvedValue(undefined)
  getHomeRegion.mockReset().mockReturnValue('ie1')
  resolveNumberRegion.mockReset().mockResolvedValue('ie1')
  blockNumber.mockReset().mockResolvedValue('+447700900123')
  unblockNumber.mockReset().mockResolvedValue('+447700900123')
  isNumberBlocked.mockReset().mockResolvedValue(false)
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

  it('reads a forwarded call by what the caller got, not by what Twilio logged', async () => {
    // The call reached Twilio, played a greeting and rang for twenty seconds,
    // so the call itself is 'completed'. Nobody answered it.
    listCallsForNumber.mockResolvedValue([
      {
        ...call,
        status: 'completed',
        durationSeconds: 27,
        connected: { kind: 'forwarded', number: '+447700900456', status: 'no-answer', durationSeconds: 0 },
      },
    ])
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

// The three answers deleteMessage can give are deliberately different, and
// collapsing any two of them has already cost somebody something: a voicemail
// reported undeletable when Twilio merely had a bad minute, or an inbox left
// holding a row it could never clear.
describe('deleting a message', () => {
  const SID = 'RE00000000000000000000000000000001'

  it('will not touch a call or a text, and says so with false rather than throwing', async () => {
    await expect(provider.deleteMessage!('call:CA1')).resolves.toBe(false)
    await expect(provider.deleteMessage!('sms:SM1')).resolves.toBe(false)
    expect(deleteRecording).not.toHaveBeenCalled()
  })

  it('deletes the recording at Twilio before forgetting it here', async () => {
    recentVoicemails.mockResolvedValue([
      { recordingSid: SID, toNumber: '+441134960000' },
    ])

    await expect(provider.deleteMessage!(`voicemail:${SID}`)).resolves.toBe(true)

    // Twilio first: if that fails the local row stays and it can be tried
    // again, rather than the site forgetting a recording it still pays for.
    expect(deleteRecording).toHaveBeenCalledWith(SID, 'ie1')
    expect(deleteVoicemail).toHaveBeenCalledWith(SID)
  })

  it('counts a recording we no longer hold as already gone, not as a refusal', async () => {
    recentVoicemails.mockResolvedValue([])

    // False here would leave the inbox with a row it can never clear, because
    // the far end got there first.
    await expect(provider.deleteMessage!(`voicemail:${SID}`)).resolves.toBe(true)
    expect(deleteVoicemail).toHaveBeenCalledWith(SID)
  })

  it('throws when Twilio refuses, because that is worth trying again', async () => {
    recentVoicemails.mockResolvedValue([
      { recordingSid: SID, toNumber: '+441134960000' },
    ])
    deleteRecording.mockRejectedValue(new Error('Twilio said no'))

    await expect(provider.deleteMessage!(`voicemail:${SID}`)).rejects.toThrow('Twilio said no')
    // And the local row stays, so nothing is forgotten that still exists.
    expect(deleteVoicemail).not.toHaveBeenCalled()
  })
})

describe('refusing a caller', () => {
  it('blocks the number the conversation is with', async () => {
    await provider.blockParticipant!('+447700900123')
    expect(blockNumber).toHaveBeenCalledWith({ phoneNumber: '+447700900123' })
  })

  it('lets them through again', async () => {
    await provider.unblockParticipant!('+447700900123')
    expect(unblockNumber).toHaveBeenCalledWith('+447700900123')
  })

  it('refuses a withheld caller in words rather than pretending to block them', async () => {
    // There is no number to keep, so a row would block every withheld caller at
    // once while claiming to block one. The number's own anonymous-callers rule
    // is the honest way to turn those away.
    await expect(provider.blockParticipant!('anonymous')).rejects.toBeInstanceOf(NotBlockableError)
    expect(blockNumber).not.toHaveBeenCalled()
  })

  it('says whether they are blocked, so a screen can offer the right button', async () => {
    isNumberBlocked.mockResolvedValue(true)
    await expect(provider.isParticipantBlocked!('+447700900123')).resolves.toBe(true)
  })
})
