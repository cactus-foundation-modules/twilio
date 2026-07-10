// Curated list of Twilio <Say> text-to-speech voices for the greeting picker.
// Twilio has no REST endpoint that lists voices - they are published in the
// docs only (https://www.twilio.com/docs/voice/twiml/say/text-speech), so this
// list is maintained by hand. Safe to import from client components.

export type TwilioVoice = {
  id: string
  label: string
  group: string
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

  // Amazon Polly generative voices - most human-like, highest cost.
  { id: 'Polly.Amy-Generative', label: 'Amy - British English, female', group: 'Generative (most natural)' },
  { id: 'Polly.Joanna-Generative', label: 'Joanna - American English, female', group: 'Generative (most natural)' },
  { id: 'Polly.Matthew-Generative', label: 'Matthew - American English, male', group: 'Generative (most natural)' },
]

export function isValidVoice(id: string): boolean {
  return TWILIO_VOICES.some((v) => v.id === id)
}
