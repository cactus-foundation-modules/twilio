import { describe, it, expect } from 'vitest'
import { TWILIO_VOICES, isValidVoice, voiceAvailableInRegion, voiceForRegion } from './voices'

describe('voiceAvailableInRegion', () => {
  it('allows every voice on us1-processed calls', () => {
    for (const v of TWILIO_VOICES) {
      expect(voiceAvailableInRegion(v.id, 'us1')).toBe(true)
    }
  })

  it('blocks us-only voices outside us1', () => {
    expect(voiceAvailableInRegion('Polly.Amy-Generative', 'ie1')).toBe(false)
    expect(voiceAvailableInRegion('Polly.Amy-Generative', 'au1')).toBe(false)
  })

  it('allows everything else outside us1, including the default', () => {
    expect(voiceAvailableInRegion('', 'ie1')).toBe(true)
    expect(voiceAvailableInRegion('alice', 'ie1')).toBe(true)
    expect(voiceAvailableInRegion('Polly.Amy', 'ie1')).toBe(true)
    expect(voiceAvailableInRegion('Polly.Amy-Neural', 'ie1')).toBe(true)
  })

  it('reads unknown ids as available - the render paths must not second-guess saved values', () => {
    expect(voiceAvailableInRegion('Polly.SomeFutureVoice', 'ie1')).toBe(true)
  })
})

describe('voiceForRegion', () => {
  it('keeps the chosen voice wherever it works', () => {
    expect(voiceForRegion('Polly.Amy-Generative', 'us1')).toBe('Polly.Amy-Generative')
    expect(voiceForRegion('Polly.Amy-Neural', 'ie1')).toBe('Polly.Amy-Neural')
    expect(voiceForRegion('', 'ie1')).toBe('')
  })

  it('swaps a us-only voice for its regional stand-in outside us1', () => {
    expect(voiceForRegion('Polly.Amy-Generative', 'ie1')).toBe('Polly.Amy-Neural')
    expect(voiceForRegion('Polly.Joanna-Generative', 'ie1')).toBe('Polly.Joanna-Neural')
    expect(voiceForRegion('Polly.Matthew-Generative', 'au1')).toBe('Polly.Matthew-Neural')
  })

  it('has a valid, region-safe fallback on every us-only voice', () => {
    for (const v of TWILIO_VOICES.filter((v) => v.usOnly)) {
      const fallback = voiceForRegion(v.id, 'ie1')
      expect(fallback).not.toBe(v.id)
      expect(isValidVoice(fallback)).toBe(true)
      expect(voiceAvailableInRegion(fallback, 'ie1')).toBe(true)
    }
  })
})
