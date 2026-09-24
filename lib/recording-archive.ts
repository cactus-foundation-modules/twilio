// A copy of a recording in the site's own storage, so it can come off Twilio.
//
// Twilio keeps every recording in the account and charges to keep it there. An
// owner who wants one off Twilio still wants to be able to play it, so taking a
// recording off Twilio copies it into the site's storage FIRST and only then
// asks Twilio to delete it. The copy can then be thrown away on its own, which
// is the end of the recording for good.
//
// Calls and voicemails alike: both are recordings, keyed by recording SID, and
// nothing here needs to know which one it is holding.
//
// WHERE THE COPY GOES. The site's active media provider, under this module's
// own private folder (declared in lib/media-private-storage.ts), with no media
// library row - a recording of somebody's phone call has no business in the
// media picker. The key carries 16 random bytes on purpose: the media Worker
// serves anything under `media/` to whoever asks for it by key, so the copy's
// privacy rests on nobody being able to guess where it is. It is only ever
// served back through the recording route, which checks who is asking.
import { randomBytes } from 'node:crypto'
import { Prisma, type MediaProviderType } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { deleteMedia, downloadMedia, mediaKeyPrefix, uploadMedia } from '@/lib/media/upload'
import { TwilioApiError, deleteRecording, fetchRecordingAudio, twilioFetch, type TwilioRegion } from './twilio'

/** The folder, inside the provider's media prefix, the copies are kept in. */
export const RECORDING_ARCHIVE_FOLDER = 'twilio'

export const RECORDING_SID = /^RE[a-f0-9]{32}$/i

/** Refuse to haul anything absurd through a serverless function. An MP3 of a
 *  phone call is roughly a megabyte a minute, so this is well over an hour. */
const MAX_RECORDING_BYTES = 100 * 1024 * 1024

export type ArchiveRow = {
  recordingSid: string
  callSid: string
  siteNumber: string
  mediaProvider: string
  mediaKey: string
  mediaUrl: string
  contentType: string
  sizeBytes: number
  archivedAt: Date
  twilioDeletedAt: Date | null
  copyDeletedAt: Date | null
  updatedAt: Date
}

/** Plain words for a person, rather than a stack trace, when something here
 *  cannot be done. */
export class RecordingArchiveError extends Error {}

function mapRow(r: Record<string, unknown>): ArchiveRow {
  return {
    recordingSid: r.recording_sid as string,
    callSid: (r.call_sid as string) ?? '',
    siteNumber: (r.site_number as string) ?? '',
    mediaProvider: (r.media_provider as string) ?? '',
    mediaKey: (r.media_key as string) ?? '',
    mediaUrl: (r.media_url as string) ?? '',
    contentType: (r.content_type as string) || 'audio/mpeg',
    sizeBytes: Number(r.size_bytes ?? 0),
    archivedAt: r.archived_at as Date,
    twilioDeletedAt: (r.twilio_deleted_at as Date | null) ?? null,
    copyDeletedAt: (r.copy_deleted_at as Date | null) ?? null,
    updatedAt: r.updated_at as Date,
  }
}

/** Whether the site still holds a copy. */
export function hasSavedCopy(row: ArchiveRow | null | undefined): boolean {
  return !!row && !!row.mediaKey && !!row.mediaProvider
}

/** Whether Twilio still holds it, as far as this site knows. A recording
 *  nobody ever copied is assumed to be on Twilio, which is where every
 *  recording starts. */
export function onTwilio(row: ArchiveRow | null | undefined): boolean {
  return !row || row.twilioDeletedAt === null
}

export async function archiveRowsForSids(recordingSids: string[]): Promise<Map<string, ArchiveRow>> {
  const wanted = recordingSids.filter((sid) => RECORDING_SID.test(sid))
  if (wanted.length === 0) return new Map()
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "tw_recording_archive" WHERE "recording_sid" IN (${Prisma.join(wanted)})
  `
  return new Map(rows.map((r) => [r.recording_sid as string, mapRow(r)]))
}

export async function archiveRow(recordingSid: string): Promise<ArchiveRow | null> {
  return (await archiveRowsForSids([recordingSid])).get(recordingSid) ?? null
}

/** Recordings that have left Twilio, for the call log to put back on their
 *  calls: Twilio's own listing no longer knows them. `kept` says whether the
 *  site still has a copy to play - one with neither copy stays on its call so a
 *  screen can say it was deleted, rather than the recording silently vanishing.
 *  Only ones with a call SID, and bounded - this is read on every listing. */
export async function recordingsOffTwilio(
  limit = 500
): Promise<Array<{ recordingSid: string; callSid: string; kept: boolean }>> {
  const rows = await prisma.$queryRaw<Array<{ recording_sid: string; call_sid: string; media_key: string }>>`
    SELECT "recording_sid", "call_sid", "media_key" FROM "tw_recording_archive"
     WHERE "twilio_deleted_at" IS NOT NULL AND "call_sid" <> ''
     ORDER BY "archived_at" DESC
     LIMIT ${limit}
  `
  return rows.map((r) => ({ recordingSid: r.recording_sid, callSid: r.call_sid, kept: r.media_key !== '' }))
}

/** The saved copy's bytes, or null when there is no copy to read. */
export async function readSavedCopy(row: ArchiveRow): Promise<Buffer | null> {
  if (!hasSavedCopy(row)) return null
  return downloadMedia(row.mediaProvider as MediaProviderType, row.mediaKey, row.mediaUrl)
}

/** Copies a recording into the site's storage, unless it is already there.
 *  Returns the row either way. */
export async function saveRecordingCopy(input: {
  recordingSid: string
  siteNumber: string
  region: TwilioRegion
}): Promise<ArchiveRow> {
  const existing = await archiveRow(input.recordingSid)
  if (hasSavedCopy(existing)) return existing!
  if (existing && !onTwilio(existing)) {
    throw new RecordingArchiveError('This recording has already been taken off Twilio and its saved copy deleted, so there is nothing left to save.')
  }

  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    throw new RecordingArchiveError('The site has no file storage set up, so there is nowhere to keep a copy. Set one up under Media first.')
  }

  const audio = await fetchRecordingAudio(input.recordingSid, input.region)
  if (audio.status === 404) {
    throw new RecordingArchiveError('Twilio no longer has this recording, so there is nothing to copy.')
  }
  if (!audio.ok) {
    throw new RecordingArchiveError('Twilio would not hand the recording over just now. Try again in a moment.')
  }
  const buffer = Buffer.from(await audio.arrayBuffer())
  if (buffer.length === 0) throw new RecordingArchiveError('Twilio sent back an empty recording, so nothing was saved.')
  if (buffer.length > MAX_RECORDING_BYTES) {
    throw new RecordingArchiveError('That recording is too large to copy from here.')
  }
  const contentType = audio.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/mpeg'

  // Which call it belongs to, read from Twilio while it still has it. Not fatal
  // when it cannot be read: the copy is what matters, and a voicemail finds its
  // way back to its message by recording SID alone.
  let callSid = existing?.callSid ?? ''
  if (!callSid) {
    try {
      const meta = (await twilioFetch(`/Recordings/${encodeURIComponent(input.recordingSid)}.json`, {
        region: input.region,
      })) as { call_sid?: string }
      callSid = /^CA[a-f0-9]{32}$/i.test(meta.call_sid ?? '') ? meta.call_sid! : ''
    } catch (err) {
      console.warn('[twilio] could not read which call a recording belongs to', input.recordingSid, err)
    }
  }

  const key = `${mediaKeyPrefix(provider)}${RECORDING_ARCHIVE_FOLDER}/recordings/${randomBytes(16).toString('hex')}-${input.recordingSid}.mp3`
  const stored = await uploadMedia(buffer, contentType, provider, `${input.recordingSid}.mp3`, undefined, false, key)

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    INSERT INTO "tw_recording_archive"
      ("recording_sid", "call_sid", "site_number", "media_provider", "media_key", "media_url",
       "content_type", "size_bytes")
    VALUES (${input.recordingSid}, ${callSid}, ${input.siteNumber}, ${provider}, ${stored.key},
            ${stored.url}, ${contentType}, ${stored.sizeBytes || buffer.length})
    ON CONFLICT ("recording_sid") DO UPDATE SET
      "call_sid" = EXCLUDED."call_sid",
      "site_number" = EXCLUDED."site_number",
      "media_provider" = EXCLUDED."media_provider",
      "media_key" = EXCLUDED."media_key",
      "media_url" = EXCLUDED."media_url",
      "content_type" = EXCLUDED."content_type",
      "size_bytes" = EXCLUDED."size_bytes",
      "archived_at" = CURRENT_TIMESTAMP,
      "copy_deleted_at" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    RETURNING *
  `
  return mapRow(rows[0]!)
}

/** Takes a recording off Twilio, having made sure the site holds a copy first.
 *  A recording Twilio has already dropped counts as taken off, not as a
 *  failure - somebody asking to be rid of it must not be told no because the far
 *  end got there first. */
export async function removeFromTwilio(input: {
  recordingSid: string
  siteNumber: string
  region: TwilioRegion
}): Promise<void> {
  const row = await saveRecordingCopy(input)
  if (!onTwilio(row)) return

  try {
    await deleteRecording(input.recordingSid, input.region)
  } catch (err) {
    if (!(err instanceof TwilioApiError && err.httpStatus === 404)) {
      throw new RecordingArchiveError('Twilio would not delete the recording just now. The copy on the site is safe - try again in a moment.')
    }
  }

  await prisma.$executeRaw`
    UPDATE "tw_recording_archive"
       SET "twilio_deleted_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
     WHERE "recording_sid" = ${input.recordingSid}
  `
}

/** Throws away the site's copy. Bytes before the row, so an interrupted delete
 *  leaves a row still pointing at an object rather than an object nothing
 *  points at. A copy already gone from storage counts as deleted. */
export async function deleteSavedCopy(recordingSid: string): Promise<void> {
  const row = await archiveRow(recordingSid)
  if (!row || !hasSavedCopy(row)) return
  try {
    await deleteMedia(row.mediaProvider as MediaProviderType, row.mediaKey)
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? ''
    if (name !== 'NoSuchKey' && name !== 'NotFound') throw err
  }
  await prisma.$executeRaw`
    UPDATE "tw_recording_archive"
       SET "media_provider" = '', "media_key" = '', "media_url" = '', "size_bytes" = 0,
           "copy_deleted_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
     WHERE "recording_sid" = ${recordingSid}
  `
}

/** For the retention sweep: every copy saved on or before the cutoff, so a
 *  keep-for period covers the copies as well as what Twilio holds. */
export async function savedCopiesBefore(cutoff: Date, limit = 200): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ recording_sid: string }>>`
    SELECT "recording_sid" FROM "tw_recording_archive"
     WHERE "media_key" <> '' AND "archived_at" < ${cutoff}
     ORDER BY "archived_at" ASC
     LIMIT ${limit}
  `
  return rows.map((r) => r.recording_sid)
}
