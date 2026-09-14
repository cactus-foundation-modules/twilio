import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const retryUnacceptedCallTranscripts = vi.hoisted(() => vi.fn())

vi.mock('@/modules/twilio/lib/call-transcripts', () => ({ retryUnacceptedCallTranscripts }))

const { GET } = await import('./route')

function request(secret = 'secret'): NextRequest {
  return new NextRequest('https://example.test/api/m/twilio/cron/transcripts', {
    headers: { authorization: `Bearer ${secret}` },
  })
}

beforeEach(() => {
  process.env.CRON_SECRET = 'secret'
  retryUnacceptedCallTranscripts.mockResolvedValue({
    checked: 1,
    requested: 1,
    failed: 0,
    errors: [],
  })
})

afterEach(() => {
  delete process.env.CRON_SECRET
  vi.clearAllMocks()
})

describe('Twilio transcript retry cron', () => {
  it('retries booked recordings that never received a transcript id', async () => {
    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      checked: 1,
      requested: 1,
      failed: 0,
      errors: [],
    })
    expect(retryUnacceptedCallTranscripts).toHaveBeenCalledWith()
  })

  it('requires the cron secret', async () => {
    const response = await GET(request('wrong'))

    expect(response.status).toBe(401)
    expect(retryUnacceptedCallTranscripts).not.toHaveBeenCalled()
  })
})
