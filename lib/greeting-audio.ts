// Uploaded greeting audio - the file alternative to the <Say> text/voice pair.
//
// Files live in the core media library (root "twilio" folder) so they are
// stored on whatever media provider the site uses and visible to the admin in
// one place. The forwarding rule stores only the media id; Twilio fetches the
// bytes through this module's own public audio route rather than the media
// Worker, because the Worker's content-type table knows images and 3D models,
// not audio - and because the route can then refuse to serve anything that is
// not actually a greeting (media ids for private files, say).
// Deliberately free of DB imports - voicemail.ts (pure, unit-tested) builds
// greeting URLs from here, so the rule-reference check that needs the database
// lives with the public audio route instead.
import { getSiteUrl } from '@/lib/config/env'

// What Twilio's <Play> accepts and people actually have: MP3 and WAV. The
// left-hand side is what browsers variously call them; the value is the type
// the file is stored under.
export const GREETING_AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
}

// A greeting is seconds long, not a podcast. 10 MB is roomy even for WAV.
export const MAX_GREETING_AUDIO_BYTES = 10 * 1024 * 1024

export const GREETING_AUDIO_FOLDER = 'twilio'

// The URL Twilio (and the admin's preview player) fetches a greeting from.
export function greetingAudioUrl(mediaId: string): string {
  return `${getSiteUrl()}/api/m/twilio/public/audio/${encodeURIComponent(mediaId)}`
}

