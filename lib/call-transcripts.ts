// The record of which recorded calls have been typed up, and what they said.
//
// Shaped to read exactly like tw_voicemails does, because anything showing the
// two side by side - the call log, the merged inbox - should not have to care
// which kind of recording it is holding. Same status words, same "the text
// arrives minutes later" story, same updated_at so a reader on a schedule can
// tell it has changed.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'

export type CallTranscriptRow = {
  recordingSid: string
  callSid: string
  siteNumber: string
  transcriptSid: string
  /** 'pending' | 'completed' | 'failed'. */
  status: string
  text: string
  createdAt: Date
  updatedAt: Date
}

/** Books a recording in as asked-for, before Voice Intelligence has answered.
 *
 *  Written FIRST, and on purpose: the request that follows it can fail, time
 *  out, or succeed with the reply lost on the way back, and a row saying
 *  "pending" is recoverable where no row at all is a recording nobody will ever
 *  wonder about again. Doing nothing on conflict makes a repeated Twilio
 *  callback for the same recording harmless. */
export async function beginCallTranscript(row: {
  recordingSid: string
  callSid: string
  siteNumber: string
}): Promise<boolean> {
  const inserted = await prisma.$executeRaw`
    INSERT INTO "tw_call_transcripts" ("recording_sid", "call_sid", "site_number", "status")
    VALUES (${row.recordingSid}, ${row.callSid}, ${row.siteNumber}, 'pending')
    ON CONFLICT ("recording_sid") DO NOTHING
  `
  return inserted > 0
}

/** Files Voice Intelligence's own id for the job, once it has accepted it. */
export async function setCallTranscriptSid(recordingSid: string, transcriptSid: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "tw_call_transcripts"
       SET "transcript_sid" = ${transcriptSid}, "updated_at" = CURRENT_TIMESTAMP
     WHERE "recording_sid" = ${recordingSid}
  `
}

/** The words, when they arrive. Failed transcripts keep the row and lose the
 *  text: "we tried and it did not work" is worth being able to see, and an
 *  empty transcript that still called itself completed would read as a silent
 *  call. */
export async function recordCallTranscript(input: {
  transcriptSid: string
  status: 'completed' | 'failed'
  text: string
}): Promise<void> {
  const text = input.status === 'completed' ? input.text : ''
  await prisma.$executeRaw`
    UPDATE "tw_call_transcripts"
       SET "status" = ${input.status}, "text" = ${text}, "updated_at" = CURRENT_TIMESTAMP
     WHERE "transcript_sid" = ${input.transcriptSid}
  `
}

/** The row a Voice Intelligence callback is about. The callback names only the
 *  job, and the Region the transcript lives in is on the row. */
export async function callTranscriptByTranscriptSid(
  transcriptSid: string
): Promise<CallTranscriptRow | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "recording_sid", "call_sid", "site_number", "transcript_sid", "status", "text",
           "created_at", "updated_at"
      FROM "tw_call_transcripts" WHERE "transcript_sid" = ${transcriptSid} LIMIT 1
  `
  const row = rows[0]
  return row ? mapRow(row) : null
}

/** Transcripts for the recordings on one page of calls. Bounded by what is
 *  being looked at, exactly as transcriptionsForSids is. */
export async function callTranscriptsForSids(
  recordingSids: string[]
): Promise<Map<string, CallTranscriptRow>> {
  if (recordingSids.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT "recording_sid", "call_sid", "site_number", "transcript_sid", "status", "text",
           "created_at", "updated_at"
      FROM "tw_call_transcripts"
     WHERE "recording_sid" IN (${Prisma.join(recordingSids)})
  `
  return new Map(rows.map((r) => [r.recording_sid as string, mapRow(r)]))
}

function mapRow(r: Record<string, unknown>): CallTranscriptRow {
  return {
    recordingSid: r.recording_sid as string,
    callSid: (r.call_sid as string) ?? '',
    siteNumber: (r.site_number as string) ?? '',
    transcriptSid: (r.transcript_sid as string) ?? '',
    status: (r.status as string) ?? '',
    text: (r.text as string) ?? '',
    createdAt: r.created_at as Date,
    updatedAt: (r.updated_at as Date) ?? (r.created_at as Date),
  }
}
