import { describe, expect, it } from 'vitest'
import {
  WHATSAPP_WINDOW_MS,
  fromWhatsAppAddress,
  isContentSid,
  isMediaSid,
  isMessageSid,
  isWhatsAppAddress,
  isWindowOpen,
  toWhatsAppAddress,
  windowProblem,
} from './whatsapp'

// The parts of WhatsApp that are decisions rather than requests. Everything
// here is what stops a message being handed to Twilio in a shape Meta will
// drop - which is the failure that costs a customer conversation and shows up
// nowhere, because Twilio accepted it.

describe('addressing', () => {
  it('prefixes a plain number', () => {
    expect(toWhatsAppAddress('+447700900123')).toBe('whatsapp:+447700900123')
  })

  it('does not prefix twice', () => {
    expect(toWhatsAppAddress('whatsapp:+447700900123')).toBe('whatsapp:+447700900123')
  })

  it('strips the prefix on the way back', () => {
    expect(fromWhatsAppAddress('whatsapp:+447700900123')).toBe('+447700900123')
  })

  it('leaves an unprefixed value alone rather than inventing a shape for it', () => {
    expect(fromWhatsAppAddress('+447700900123')).toBe('+447700900123')
    expect(fromWhatsAppAddress('')).toBe('')
  })

  it('round-trips', () => {
    expect(fromWhatsAppAddress(toWhatsAppAddress('+447700900123'))).toBe('+447700900123')
  })

  it('recognises its own addresses', () => {
    expect(isWhatsAppAddress('whatsapp:+447700900123')).toBe(true)
    expect(isWhatsAppAddress('+447700900123')).toBe(false)
  })
})

describe('the 24-hour window', () => {
  const now = new Date('2026-09-06T12:00:00Z')

  it('is open just inside 24 hours', () => {
    const at = new Date(now.getTime() - WHATSAPP_WINDOW_MS + 60_000)
    expect(isWindowOpen(at, now)).toBe(true)
    expect(windowProblem(at, now)).toBeNull()
  })

  it('is shut just outside 24 hours', () => {
    const at = new Date(now.getTime() - WHATSAPP_WINDOW_MS - 60_000)
    expect(isWindowOpen(at, now)).toBe(false)
    expect(windowProblem(at, now)).toContain('24 hours')
  })

  // Somebody who has never written is OUTSIDE the window, not inside it: a
  // conversation nobody started can only be opened with an approved template,
  // and treating "no last message" as "recent enough" would send a free-text
  // message Meta drops without telling anybody.
  it('is shut when they have never written, with its own wording', () => {
    expect(isWindowOpen(null, now)).toBe(false)
    expect(windowProblem(null, now)).toContain('never written')
  })

  it('is shut on an unreadable date rather than assumed open', () => {
    expect(isWindowOpen(new Date('not a date'), now)).toBe(false)
  })
})

describe('Twilio id shapes', () => {
  it('accepts a real content SID and refuses the near misses', () => {
    expect(isContentSid('HX' + 'a'.repeat(32))).toBe(true)
    expect(isContentSid('HX' + 'a'.repeat(31))).toBe(false)
    // The classic paste mistake: a message SID where a template id belongs.
    expect(isContentSid('MM' + 'a'.repeat(32))).toBe(false)
    expect(isContentSid('')).toBe(false)
  })

  it('accepts message and media SIDs', () => {
    expect(isMessageSid('MM' + '0'.repeat(32))).toBe(true)
    expect(isMessageSid('SM' + '0'.repeat(32))).toBe(true)
    expect(isMessageSid('MM' + '0'.repeat(31))).toBe(false)
    expect(isMediaSid('ME' + '0'.repeat(32))).toBe(true)
    expect(isMediaSid('MM' + '0'.repeat(32))).toBe(false)
  })

  // These guard a path built out of user input. A SID that gets through unchecked
  // becomes part of a URL, so the traversal shapes matter more than the tidy ones.
  it('refuses anything with a path in it', () => {
    expect(isMessageSid('../../secrets')).toBe(false)
    expect(isMediaSid('ME' + '0'.repeat(30) + '/..')).toBe(false)
  })
})
