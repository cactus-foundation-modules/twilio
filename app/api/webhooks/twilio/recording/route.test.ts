import { describe, expect, it, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const getSiteUrl = vi.hoisted(() => vi.fn(() => 'https://example.test'))
const validateTwilioSignature = vi.hoisted(() => vi.fn(() => true))
const isTwilioConfigured = vi.hoisted(() => vi.fn(() => true))
const getRuleForNumber = vi.hoisted(() => vi.fn())
const resolveNumberRegion = vi.hoisted(() => vi.fn())
const requestTranscript = vi.hoisted(() => vi.fn())
const beginCallTranscript = vi.hoisted(() => vi.fn())
const setCallTranscriptSid = vi.hoisted(() => vi.fn())
const failCallTranscriptRequest = vi.hoisted(() => vi.fn())

vi.mock('@/lib/config/env', () => ({ getSiteUrl }))
vi.mock('@/modules/twilio/lib/twilio', () => ({ validateTwilioSignature, isTwilioConfigured }))
vi.mock('@/modules/twilio/lib/forwarding', () => ({ getRuleForNumber }))
vi.mock('@/modules/twilio/lib/numbers', () => ({ resolveNumberRegion }))
vi.mock('@/modules/twilio/lib/intelligence', () => ({ requestTranscript }))
vi.mock('@/modules/twilio/lib/call-transcripts', () => ({
  beginCallTranscript,
  failCallTranscriptRequest,
  setCallTranscriptSid,
}))

const { POST } = await import('./route')

const recordingSid = 'REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function requestFor(body: Record<string, string>): NextRequest {
  return new NextRequest('https://example.test/api/m/twilio/webhooks/recording?number=%2B441134960000', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': 'valid',
    },
    body: new URLSearchParams(body).toString(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getSiteUrl.mockReturnValue('https://example.test')
  validateTwilioSignature.mockReturnValue(true)
  isTwilioConfigured.mockReturnValue(true)
  getRuleForNumber.mockResolvedValue({ transcribeCalls: true })
  resolveNumberRegion.mockResolvedValue('ie1')
  requestTranscript.mockResolvedValue('GTbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  beginCallTranscript.mockResolvedValue(true)
  setCallTranscriptSid.mockResolvedValue(undefined)
  failCallTranscriptRequest.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('Twilio recording webhook', () => {
  it('marks the transcript as failed when Voice Intelligence refuses the recording', async () => {
    requestTranscript.mockRejectedValue(new Error('Voice Intelligence said no'))

    const response = await POST(requestFor({
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      CallSid: 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }))

    expect(response.status).toBe(204)
    expect(beginCallTranscript).toHaveBeenCalledWith({
      recordingSid,
      callSid: 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      siteNumber: '+441134960000',
    })
    expect(failCallTranscriptRequest).toHaveBeenCalledWith(recordingSid)
    expect(setCallTranscriptSid).not.toHaveBeenCalled()
  })

  it('keeps the transcript pending only after Voice Intelligence accepts the job', async () => {
    const response = await POST(requestFor({
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      CallSid: 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }))

    expect(response.status).toBe(204)
    expect(requestTranscript).toHaveBeenCalledWith(recordingSid, 'ie1')
    expect(setCallTranscriptSid).toHaveBeenCalledWith(recordingSid, 'GTbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(failCallTranscriptRequest).not.toHaveBeenCalled()
  })
})
