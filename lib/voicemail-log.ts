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

// Writes the voicemail down and raises the admin notification. Safe to call
// twice for the same recording: the insert is a no-op on conflict and the alert
// is keyed by the recording SID.
export async function recordVoicemail(row: {
  recordingSid: string
  callSid: string
  fromNumber: string
  toNumber: string
  durationSeconds: number
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "tw_voicemails" ("recording_sid", "call_sid", "from_number", "to_number", "duration_seconds")
    VALUES (${row.recordingSid}, ${row.callSid}, ${row.fromNumber}, ${row.toNumber}, ${row.durationSeconds})
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
