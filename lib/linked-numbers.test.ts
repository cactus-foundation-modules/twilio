// Linking one number to another is the sort of feature that looks right in the
// admin form and goes wrong on a real call: the wrong side's number ends up on
// the caller ID, or a follower quietly starts a second hop. linkedRule is the
// single place that decides which side each field comes from, so it is worth
// pinning down field by field.
import { describe, it, expect, vi } from 'vitest'

// forwarding.ts reaches for Prisma at import time. Nothing under test here
// touches the database - linkedRule is pure - so the client is stubbed rather
// than the test needing one.
vi.mock('@/lib/db/prisma', () => ({ prisma: {} }))

const { linkedRule } = await import('./forwarding')
type Rule = Parameters<typeof linkedRule>[0]

function rule(overrides: Partial<Rule>): Rule {
  return {
    id: 'id',
    phoneSid: 'PN0',
    phoneNumber: '+441111111111',
    forwardTo: '',
    forwardToSecond: '',
    enabled: false,
    greetingMessage: '',
    greetingVoice: '',
    recordCalls: false,
    showCalledNumber: false,
    voicemailEnabled: false,
    ringTimeout: 20,
    forwardAttempts: 1,
    voicemailGreeting: '',
    closedVoicemailGreeting: '',
    voicemailVoice: '',
    businessHours: [],
    holidayDates: [],
    missedCallSmsEnabled: false,
    missedCallSmsMessage: '',
    transcribeVoicemail: false,
    transcribeCalls: false,
    anonymousCallers: 'allow',
    greetingAudioMediaId: '',
    voicemailAudioMediaId: '',
    closedVoicemailAudioMediaId: '',
    followsPhoneSid: '',
    ...overrides,
  }
}

const follower = rule({
  id: 'follower-id',
  phoneSid: 'PNtext',
  phoneNumber: '+447700900999',
  followsPhoneSid: 'PNmain',
  // Dormant settings of its own, kept so unlinking gives them back.
  forwardTo: '+447700900111',
  enabled: true,
  greetingMessage: 'The old text-line greeting',
})

const leader = rule({
  id: 'leader-id',
  phoneSid: 'PNmain',
  phoneNumber: '+441234567890',
  forwardTo: '+447700900222',
  forwardToSecond: '+447700900333',
  enabled: true,
  greetingMessage: 'Thank you for calling.',
  greetingVoice: 'Polly.Amy',
  recordCalls: true,
  showCalledNumber: true,
  voicemailEnabled: true,
  ringTimeout: 35,
  forwardAttempts: 3,
  voicemailGreeting: 'Leave a message.',
  closedVoicemailGreeting: 'We are closed.',
  voicemailVoice: 'Polly.Brian',
  businessHours: [{ day: 1, closed: false, open: '09:00', close: '17:00' }],
  holidayDates: ['2026-12-25'],
  missedCallSmsEnabled: true,
  missedCallSmsMessage: 'Sorry we missed you.',
  transcribeVoicemail: true,
  transcribeCalls: true,
  anonymousCallers: 'voicemail',
  greetingAudioMediaId: 'media-greeting',
  voicemailAudioMediaId: 'media-voicemail',
  closedVoicemailAudioMediaId: 'media-closed',
})

describe('linkedRule', () => {
  it('takes every behaviour field from the number being copied', () => {
    const linked = linkedRule(follower, leader)
    expect(linked.forwardTo).toBe('+447700900222')
    expect(linked.forwardToSecond).toBe('+447700900333')
    expect(linked.enabled).toBe(true)
    expect(linked.greetingMessage).toBe('Thank you for calling.')
    expect(linked.greetingVoice).toBe('Polly.Amy')
    expect(linked.recordCalls).toBe(true)
    expect(linked.showCalledNumber).toBe(true)
    expect(linked.voicemailEnabled).toBe(true)
    expect(linked.ringTimeout).toBe(35)
    expect(linked.forwardAttempts).toBe(3)
    expect(linked.voicemailGreeting).toBe('Leave a message.')
    expect(linked.closedVoicemailGreeting).toBe('We are closed.')
    expect(linked.voicemailVoice).toBe('Polly.Brian')
    expect(linked.businessHours).toEqual(leader.businessHours)
    expect(linked.holidayDates).toEqual(['2026-12-25'])
    expect(linked.missedCallSmsEnabled).toBe(true)
    expect(linked.missedCallSmsMessage).toBe('Sorry we missed you.')
    expect(linked.transcribeVoicemail).toBe(true)
    expect(linked.transcribeCalls).toBe(true)
    expect(linked.anonymousCallers).toBe('voicemail')
    expect(linked.greetingAudioMediaId).toBe('media-greeting')
    expect(linked.voicemailAudioMediaId).toBe('media-voicemail')
    expect(linked.closedVoicemailAudioMediaId).toBe('media-closed')
  })

  it('keeps the follower’s own identity', () => {
    const linked = linkedRule(follower, leader)
    // A missed call on the text line texts back from the text line and names
    // it in the alert email - both read phoneNumber off the rule.
    expect(linked.phoneNumber).toBe('+447700900999')
    expect(linked.phoneSid).toBe('PNtext')
    expect(linked.id).toBe('follower-id')
  })

  it('clears the link so a resolved rule can never hop twice', () => {
    expect(linkedRule(follower, leader).followsPhoneSid).toBe('')
  })

  it('leaves the follower’s stored settings untouched', () => {
    linkedRule(follower, leader)
    expect(follower.forwardTo).toBe('+447700900111')
    expect(follower.greetingMessage).toBe('The old text-line greeting')
    expect(follower.followsPhoneSid).toBe('PNmain')
  })
})
