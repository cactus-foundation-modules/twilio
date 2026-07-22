import { beforeAll, describe, it, expect } from 'vitest'
import {
  planVoicemailRequest,
  recordingSidFromUrl,
  voicemailGreetingFor,
  voicemailGreetingTwiml,
  MIN_VOICEMAIL_SECONDS,
} from './voicemail'

const SID = 'RE00000000000000000000000000000001'
const RECORDING_URL = `https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/${SID}`

describe('planVoicemailRequest', () => {
  describe('the <Dial> stage', () => {
    it('takes a message when nobody got through', () => {
      for (const dialCallStatus of ['no-answer', 'busy', 'failed']) {
        expect(planVoicemailRequest({ stage: null, dialCallStatus })).toEqual({ action: 'take-message' })
      }
    })

    it('hangs up on a call somebody actually had, or that the caller abandoned', () => {
      for (const dialCallStatus of ['completed', 'answered', 'canceled']) {
        expect(planVoicemailRequest({ stage: null, dialCallStatus })).toEqual({ action: 'hangup' })
      }
    })

    // The one that bit: <Dial record="record-from-answer-dual"> sends
    // RecordingUrl to its own action URL. That recording is the forwarded
    // conversation, so treating it as a message tagged answered calls as
    // voicemail in the log and rang the admin's bell for each one.
    it('never logs the <Dial>\'s own recording as a message', () => {
      expect(
        planVoicemailRequest({
          stage: null,
          dialCallStatus: 'completed',
          recordingUrl: RECORDING_URL,
          recordingDuration: '95',
        })
      ).toEqual({ action: 'hangup' })
    })

    // Same request shape, but nobody answered: the caller must still get to
    // leave a message rather than have the dial's recording params swallow it.
    it('still takes a message when a recorded dial went unanswered', () => {
      expect(
        planVoicemailRequest({
          stage: null,
          dialCallStatus: 'no-answer',
          recordingUrl: RECORDING_URL,
          recordingDuration: '0',
        })
      ).toEqual({ action: 'take-message' })
    })
  })

  describe('the <Record> stage', () => {
    it('logs a message somebody actually left', () => {
      expect(
        planVoicemailRequest({ stage: 'recording', recordingSid: SID, recordingDuration: '12' })
      ).toEqual({ action: 'log-message', recordingSid: SID, durationSeconds: 12 })
    })

    it('falls back to the SID in the recording URL', () => {
      expect(
        planVoicemailRequest({ stage: 'recording', recordingUrl: RECORDING_URL, recordingDuration: '12' })
      ).toEqual({ action: 'log-message', recordingSid: SID, durationSeconds: 12 })
    })

    // Twilio keeps silent recordings, so ringing off at the beep still makes
    // one. It is not a message and must not raise a notification.
    it('ignores a recording too short to be a message', () => {
      for (const recordingDuration of ['', '0', '1']) {
        expect(planVoicemailRequest({ stage: 'recording', recordingSid: SID, recordingDuration })).toEqual({
          action: 'hangup',
        })
      }
    })

    it('logs a message exactly on the threshold', () => {
      expect(
        planVoicemailRequest({
          stage: 'recording',
          recordingSid: SID,
          recordingDuration: String(MIN_VOICEMAIL_SECONDS),
        })
      ).toEqual({ action: 'log-message', recordingSid: SID, durationSeconds: MIN_VOICEMAIL_SECONDS })
    })

    it('hangs up rather than looping when there is no usable recording SID', () => {
      expect(planVoicemailRequest({ stage: 'recording', recordingUrl: 'https://example.com/nope', recordingDuration: '12' })).toEqual({
        action: 'hangup',
      })
    })
  })

  // A <Record> action from before the stage marker existed - a call in flight
  // across a deploy. It carries no DialCallStatus, so it must hang up rather
  // than read as a dial that never connected and offer voicemail all over again.
  it('hangs up on a recording request with no stage marker', () => {
    expect(planVoicemailRequest({ stage: null, recordingSid: SID, recordingDuration: '12' })).toEqual({
      action: 'hangup',
    })
  })

  it('hangs up on a request it cannot place at all', () => {
    expect(planVoicemailRequest({ stage: null })).toEqual({ action: 'hangup' })
  })
})

describe('voicemailGreetingFor', () => {
  const rule = { voicemailGreeting: 'Nobody is free right now.', closedVoicemailGreeting: 'We are shut.' }

  it('says the closed greeting outside opening hours', () => {
    expect(voicemailGreetingFor(rule, true)).toBe('We are shut.')
  })

  it('says the usual greeting inside opening hours', () => {
    expect(voicemailGreetingFor(rule, false)).toBe('Nobody is free right now.')
  })

  // The closed greeting is optional, and every rule written before it existed
  // has an empty one. Those callers must still hear something.
  it('falls back to the usual greeting when no closed greeting is set', () => {
    expect(voicemailGreetingFor({ ...rule, closedVoicemailGreeting: '' }, true)).toBe('Nobody is free right now.')
    expect(voicemailGreetingFor({ ...rule, closedVoicemailGreeting: '   ' }, true)).toBe('Nobody is free right now.')
  })

  it('falls back to the built-in greeting when both are empty', () => {
    const said = voicemailGreetingFor({ voicemailGreeting: '', closedVoicemailGreeting: '' }, true)
    expect(said).toContain('leave a message')
  })

  it('trims what it says', () => {
    expect(voicemailGreetingFor({ voicemailGreeting: '', closedVoicemailGreeting: '  We are shut.  ' }, true)).toBe(
      'We are shut.'
    )
  })
})

describe('voicemailGreetingTwiml', () => {
  // greetingAudioUrl builds on getSiteUrl, which throws without SITE_URL - the
  // rest of this suite is env-free, so it is pinned here rather than globally.
  beforeAll(() => {
    process.env.SITE_URL = 'https://example.test'
  })

  const rule = {
    voicemailGreeting: 'Nobody is free right now.',
    closedVoicemailGreeting: 'We are shut.',
    voicemailVoice: 'Polly.Amy',
    voicemailAudioMediaId: '',
    closedVoicemailAudioMediaId: '',
  }

  it('says the greeting when no audio is uploaded', () => {
    expect(voicemailGreetingTwiml(rule, false)).toBe('<Say voice="Polly.Amy">Nobody is free right now.</Say>')
  })

  it('plays the uploaded audio instead of saying anything', () => {
    const twiml = voicemailGreetingTwiml({ ...rule, voicemailAudioMediaId: 'media123' }, false)
    expect(twiml).toMatch(/^<Play>.*\/api\/m\/twilio\/public\/audio\/media123<\/Play>$/)
  })

  it('prefers the closed audio on a closed call', () => {
    const twiml = voicemailGreetingTwiml(
      { ...rule, voicemailAudioMediaId: 'media123', closedVoicemailAudioMediaId: 'closed456' },
      true
    )
    expect(twiml).toContain('/api/m/twilio/public/audio/closed456')
  })

  // Closed words written specially for out-of-hours callers beat the everyday
  // audio - the admin said something specific and the recording is not it.
  it('says the closed words rather than playing the everyday audio', () => {
    const twiml = voicemailGreetingTwiml({ ...rule, voicemailAudioMediaId: 'media123' }, true)
    expect(twiml).toBe('<Say voice="Polly.Amy">We are shut.</Say>')
  })

  it('falls back to the everyday audio on a closed call with nothing closed-specific', () => {
    const twiml = voicemailGreetingTwiml(
      { ...rule, closedVoicemailGreeting: '', voicemailAudioMediaId: 'media123' },
      true
    )
    expect(twiml).toContain('/api/m/twilio/public/audio/media123')
  })
})

describe('recordingSidFromUrl', () => {
  it('reads the SID off the end of a recording URL', () => {
    expect(recordingSidFromUrl(RECORDING_URL)).toBe(SID)
    expect(recordingSidFromUrl(`${RECORDING_URL}.mp3?foo=1`)).toBe('')
    expect(recordingSidFromUrl(`${RECORDING_URL}?foo=1`)).toBe(SID)
  })

  it('returns nothing for a URL that does not end in one', () => {
    expect(recordingSidFromUrl('https://example.com/whatever')).toBe('')
    expect(recordingSidFromUrl('')).toBe('')
  })
})
