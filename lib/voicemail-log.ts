// The record of which recordings are voicemail messages, plus the admin
// notification raised when one arrives.
//
// Twilio keeps every recording in one flat listing with nothing to say whether
// a given one is a voicemail message or the recording of a forwarded call that
// someone actually answered. The distinction only exists at the moment the
// voicemail <Record> finishes, in a request this module handles - so that is
// where it gets written down, and the call log reads it back from here.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { upsertAlert } from '@/lib/notifications/alerts'
import { sendVoicemailEmail } from './notify'

export type VoicemailRow = {
  recordingSid: string
  callSid: string
  fromNumber: string
  toNumber: string
  durationSeconds: number
  createdAt: Date
}

// A voicemail's dedupe key is its recording SID, so each message raises its own
// notification and reading one does not hide the next. Twilio only issues a
// recording SID once, which also makes a repeated callback harmless.
function dedupeKey(recordingSid: string): string {
  return `twilio-voicemail:${recordingSid}`
}

// Writes the voicemail down, raises the admin notification, and sends the
// email alert when that is switched on. Safe to call twice for the same
// recording: the insert is a no-op on conflict, the alert is keyed by the
// recording SID, and the email only goes out on the request that actually
// inserted the row.
export async function recordVoicemail(row: {
  recordingSid: string
  callSid: string
  fromNumber: string
  toNumber: string
  durationSeconds: number
  /** Whether the number asked Twilio for a transcription of this message. */
  transcriptionRequested: boolean
}): Promise<void> {
  const status = row.transcriptionRequested ? 'pending' : ''
  const inserted = await prisma.$executeRaw`
    INSERT INTO "tw_voicemails"
      ("recording_sid", "call_sid", "from_number", "to_number", "duration_seconds", "transcription_status")
    VALUES (${row.recordingSid}, ${row.callSid}, ${row.fromNumber}, ${row.toNumber},
            ${row.durationSeconds}, ${status})
    ON CONFLICT ("recording_sid") DO NOTHING
  `

  // Withheld numbers arrive as an empty From, or as 'anonymous'/'restricted'.
  const caller = /^\+/.test(row.fromNumber) ? row.fromNumber : 'a withheld number'
  await upsertAlert({
    type: 'message',
    dedupeKey: dedupeKey(row.recordingSid),
    title: `New voicemail from ${caller}`,
    link: '/m/twilio',
  })

  if (inserted > 0) await sendVoicemailEmail(row)
}

// Files Twilio's transcription onto its voicemail row when it arrives, minutes
// after the recording. Twilio reports 'completed' or 'failed'; anything else is
// stored as failed rather than left claiming to be pending forever.
export async function recordTranscription(input: {
  recordingSid: string
  status: string
  text: string
}): Promise<void> {
  const status = input.status === 'completed' ? 'completed' : 'failed'
  const text = status === 'completed' ? input.text : ''
  await prisma.$executeRaw`
    UPDATE "tw_voicemails"
    SET "transcription_status" = ${status}, "transcription_text" = ${text}
    WHERE "recording_sid" = ${input.recordingSid}
  `
}

// Transcriptions for the given recording SIDs, for the call log to show under
// the voicemail badge. Same bounded shape as filterVoicemailSids.
export async function transcriptionsForSids(
  recordingSids: string[]
): Promise<Map<string, { status: string; text: string }>> {
  if (recordingSids.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Array<{ recording_sid: string; transcription_status: string; transcription_text: string }>>`
    SELECT "recording_sid", "transcription_status", "transcription_text"
    FROM "tw_voicemails"
    WHERE "recording_sid" IN (${Prisma.join(recordingSids)}) AND "transcription_status" <> ''
  `
  return new Map(rows.map((r) => [r.recording_sid, { status: r.transcription_status, text: r.transcription_text }]))
}

// The recording SIDs, out of the ones given, that are voicemail messages. Takes
// the call log's SIDs rather than listing the table so the query stays bounded
// by the page being looked at.
export async function filterVoicemailSids(recordingSids: string[]): Promise<Set<string>> {
  if (recordingSids.length === 0) return new Set()
  const rows = await prisma.$queryRaw<Array<{ recording_sid: string }>>`
    SELECT "recording_sid" FROM "tw_voicemails" WHERE "recording_sid" IN (${Prisma.join(recordingSids)})
  `
  return new Set(rows.map((r) => r.recording_sid))
}
