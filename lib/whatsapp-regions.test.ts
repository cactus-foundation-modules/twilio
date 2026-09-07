import { beforeEach, describe, expect, it, vi } from 'vitest'

// A WhatsApp sender lives in whichever region Twilio registered IT in, which is
// not moved by where the same phone number's calls and texts are routed. Asking
// the wrong region is not an error - Twilio answers with an empty list - so the
// only defence is to sweep every region the site can reach. These cover the
// sweep itself: the merge, the ordering, and what happens when a region is
// unwell.

const twilioFetch = vi.fn()

vi.mock('./twilio', () => ({
  twilioFetch: (...args: unknown[]) => twilioFetch(...args),
  getHomeRegion: () => 'us1' as const,
  authHeader: () => 'Basic x',
  regionCredentials: () => ({ accountSid: 'AC' + '0'.repeat(32), authToken: 'tok' }),
  regionHost: () => 'api.twilio.com',
}))

const { listWhatsAppMessagesAcross } = await import('./whatsapp')

/** One Twilio Messages row, in Twilio's own shape. */
function raw(sid: string, from: string, to: string, dateSent: string) {
  return {
    sid,
    from,
    to,
    direction: 'inbound',
    status: 'received',
    date_sent: dateSent,
    date_created: dateSent,
    body: 'Hi',
    num_media: '0',
  }
}

const OURS = 'whatsapp:+442081380512'
const THEM = 'whatsapp:+447700900123'

beforeEach(() => {
  twilioFetch.mockReset()
})

describe('sweeping every region', () => {
  it('finds the messages in the region the site did NOT have written down', async () => {
    twilioFetch.mockImplementation((path: string, init?: { region?: string }) => {
      // Only the United States has anything, though the site's setting says
      // Ireland - exactly the arrangement that made the inbox look empty.
      if (init?.region === 'us1' && path.includes('To=')) {
        return Promise.resolve({ messages: [raw('MM' + '1'.repeat(32), THEM, OURS, '2026-09-06T12:00:00Z')] })
      }
      return Promise.resolve({ messages: [] })
    })

    const messages = await listWhatsAppMessagesAcross('+442081380512', ['ie1', 'us1'], 50)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.from).toBe('+447700900123')
    expect(messages[0]!.region).toBe('us1')
  })

  it('merges both regions newest first', async () => {
    twilioFetch.mockImplementation((path: string, init?: { region?: string }) => {
      if (!path.includes('To=')) return Promise.resolve({ messages: [] })
      if (init?.region === 'us1') {
        return Promise.resolve({ messages: [raw('MM' + '1'.repeat(32), THEM, OURS, '2026-09-05T12:00:00Z')] })
      }
      return Promise.resolve({ messages: [raw('MM' + '2'.repeat(32), THEM, OURS, '2026-09-06T12:00:00Z')] })
    })

    const messages = await listWhatsAppMessagesAcross('+442081380512', ['us1', 'ie1'], 50)
    expect(messages.map((m) => m.region)).toEqual(['ie1', 'us1'])
  })

  // One region being unwell must not hide the conversations held in the other,
  // because an empty inbox reads as "nobody has written" and blocks every reply.
  it('carries on when one region fails', async () => {
    twilioFetch.mockImplementation((path: string, init?: { region?: string }) => {
      if (init?.region === 'ie1') return Promise.reject(new Error('Authenticate'))
      if (path.includes('To=')) {
        return Promise.resolve({ messages: [raw('MM' + '1'.repeat(32), THEM, OURS, '2026-09-06T12:00:00Z')] })
      }
      return Promise.resolve({ messages: [] })
    })

    const messages = await listWhatsAppMessagesAcross('+442081380512', ['ie1', 'us1'], 50)
    expect(messages).toHaveLength(1)
  })

  it('throws rather than reporting silence when every region fails', async () => {
    twilioFetch.mockRejectedValue(new Error('Authenticate'))
    await expect(listWhatsAppMessagesAcross('+442081380512', ['ie1', 'us1'], 50)).rejects.toThrow('Authenticate')
  })
})
