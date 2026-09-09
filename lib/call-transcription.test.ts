import { describe, expect, it, vi, beforeEach } from 'vitest'

// Typing up a recorded conversation.
//
// A voicemail is transcribed by Twilio as part of the <Record> that took it. A
// two-party call cannot be, and goes through Voice Intelligence instead - which
// bills by the minute. So the thing actually worth pinning down here is that
// nothing reaches that product unless a number's owner asked for it, and that
// the words come back attached to the right recording.

const getSiteUrl = vi.hoisted(() => vi.fn(() => 'https://example.test'))
const escapeXml = vi.hoisted(() => (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;'))

vi.mock('@/lib/config/env', () => ({ getSiteUrl }))
vi.mock('./twilio', () => ({ escapeXml }))
vi.mock('./greeting-audio', () => ({ greetingAudioUrl: (id: string) => `https://audio/${id}` }))
vi.mock('./business-hours', () => ({ MIN_FORWARD_ATTEMPTS: 1, MAX_FORWARD_ATTEMPTS: 5 }))

const { recordingStatusUrl, transcriptionDialAttrs } = await import('./voicemail')

const recorded = { recordCalls: true, transcribeCalls: true }

beforeEach(() => {
  getSiteUrl.mockReturnValue('https://example.test')
})

describe('transcriptionDialAttrs', () => {
  it('asks Twilio to report the finished recording when the number wants one', () => {
    const attrs = transcriptionDialAttrs(recorded, '+441134960000')
    expect(attrs).toContain('recordingStatusCallback=')
    expect(attrs).toContain('/api/m/twilio/webhooks/recording')
    // The number that was dialled rides on the URL: a forwarded call's
    // recording callback names the two ends of the DIALLED leg, and neither of
    // them need be ours.
    expect(attrs).toContain('number=%2B441134960000')
    expect(attrs).toContain('recordingStatusCallbackMethod="POST"')
  })

  // The one that costs money if it is wrong. Twilio reports a recording
  // starting as well as finishing, and a callback with nothing to transcribe is
  // a request the site pays to answer.
  it('asks only about the finished recording, not the one just starting', () => {
    expect(transcriptionDialAttrs(recorded, '+441134960000')).toContain(
      'recordingStatusCallbackEvent="completed"',
    )
  })

  it('says nothing at all for a number that did not ask for it', () => {
    expect(transcriptionDialAttrs({ recordCalls: true, transcribeCalls: false }, '+441134960000')).toBe('')
  })

  // There is nothing to type up on a call nobody recorded, so the callback
  // would only ever fire for a recording that does not exist.
  it('says nothing when the call is not being recorded', () => {
    expect(transcriptionDialAttrs({ recordCalls: false, transcribeCalls: true }, '+441134960000')).toBe('')
  })

  // Without the number the callback cannot find the rule it is acting under or
  // the Region the recording lives in, so it would be a request with nothing
  // usable in it.
  it('says nothing when there is no site number to name', () => {
    expect(transcriptionDialAttrs(recorded, '')).toBe('')
  })
})

describe('recordingStatusUrl', () => {
  it('carries the site number in the query, where the signature covers it', () => {
    expect(recordingStatusUrl('+441134960000')).toBe(
      'https://example.test/api/m/twilio/webhooks/recording?number=%2B441134960000',
    )
  })
})
