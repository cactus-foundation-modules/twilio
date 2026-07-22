// Curated list of Twilio <Say> text-to-speech voices for the greeting picker.
// Twilio has no REST endpoint that lists voices - they are published in the
// docs only (https://www.twilio.com/docs/voice/twiml/say/text-speech), so this
// list is maintained by hand. Safe to import from client components.

export type TwilioVoice = {
  id: string
  label: string
  group: string
  /**
   * Only synthesises for calls processed in Twilio's US (us1) Region. The
   * Generative voices are Public Beta and not yet available in ie1/au1: a
   * number processed in Ireland that asks for one gets Twilio error 13520
   * "Say: Invalid text" and the call dies after the greeting line (seen live
   * on an ie1 number, 2026-07-21). Render paths swap these for
   * `regionalFallback` on non-us1 calls instead of killing the call.
   */
  usOnly?: boolean
  /** Said instead when a usOnly voice is asked for outside us1. */
  regionalFallback?: string
}

export const TWILIO_VOICES: TwilioVoice[] = [
  { id: '', label: 'Twilio default', group: 'Default' },

  // Basic voices - free, robotic; fine for a short notice.
  { id: 'man', label: 'Man (basic)', group: 'Basic' },
  { id: 'woman', label: 'Woman (basic)', group: 'Basic' },
  { id: 'alice', label: 'Alice (basic)', group: 'Basic' },

  // Amazon Polly standard voices.
  { id: 'Polly.Amy', label: 'Amy - British English, female', group: 'Standard' },
  { id: 'Polly.Emma', label: 'Emma - British English, female', group: 'Standard' },
  { id: 'Polly.Brian', label: 'Brian - British English, male', group: 'Standard' },
  { id: 'Polly.Joanna', label: 'Joanna - American English, female', group: 'Standard' },
  { id: 'Polly.Matthew', label: 'Matthew - American English, male', group: 'Standard' },
  { id: 'Polly.Nicole', label: 'Nicole - Australian English, female', group: 'Standard' },

  // Amazon Polly neural voices - more natural, higher per-character cost.
  { id: 'Polly.Amy-Neural', label: 'Amy - British English, female', group: 'Neural (more natural)' },
  { id: 'Polly.Emma-Neural', label: 'Emma - British English, female', group: 'Neural (more natural)' },
  { id: 'Polly.Brian-Neural', label: 'Brian - British English, male', group: 'Neural (more natural)' },
  { id: 'Polly.Arthur-Neural', label: 'Arthur - British English, male', group: 'Neural (more natural)' },
  { id: 'Polly.Joanna-Neural', label: 'Joanna - American English, female', group: 'Neural (more natural)' },
  { id: 'Polly.Matthew-Neural', label: 'Matthew - American English, male', group: 'Neural (more natural)' },
  { id: 'Polly.Olivia-Neural', label: 'Olivia - Australian English, female', group: 'Neural (more natural)' },

  // Amazon Polly generative voices - most human-like, highest cost. US-handled
  // calls only (see usOnly above); elsewhere the Neural sibling is said instead.
  { id: 'Polly.Amy-Generative', label: 'Amy - British English, female', group: 'Generative (most natural)', usOnly: true, regionalFallback: 'Polly.Amy-Neural' },
  { id: 'Polly.Joanna-Generative', label: 'Joanna - American English, female', group: 'Generative (most natural)', usOnly: true, regionalFallback: 'Polly.Joanna-Neural' },
  { id: 'Polly.Matthew-Generative', label: 'Matthew - American English, male', group: 'Generative (most natural)', usOnly: true, regionalFallback: 'Polly.Matthew-Neural' },
]

export function isValidVoice(id: string): boolean {
  return TWILIO_VOICES.some((v) => v.id === id)
}

// Whether a voice can actually be said on a call processed in `region`.
// Unknown ids read as available - they were validated on save, and the render
// paths must never invent a reason to change what the admin chose.
export function voiceAvailableInRegion(id: string, region: string): boolean {
  if (region === 'us1') return true
  const voice = TWILIO_VOICES.find((v) => v.id === id)
  return !voice?.usOnly
}

// The voice to actually put on the <Say> for a call processed in `region`:
// the chosen one where it works, its regional fallback where it does not, and
// the Twilio default ('') as the last resort. Keeping the call alive beats
// honouring the exact voice - a us-only voice on an Irish call is Twilio error
// 13520 and a dead line.
export function voiceForRegion(id: string, region: string): string {
  if (voiceAvailableInRegion(id, region)) return id
  const fallback = TWILIO_VOICES.find((v) => v.id === id)?.regionalFallback ?? ''
  return voiceAvailableInRegion(fallback, region) ? fallback : ''
}
