// The nightly retention sweep: deletes call recordings (voicemails included -
// they are recordings like any other) older than the configured keep-for
// period from the Twilio account, and prunes the matching voicemail rows here.
// retentionDays 0 means the sweep does nothing at all - the default, and the
// behaviour every install had before the setting existed.
import { prisma } from '@/lib/db/prisma'
import { getTwilioSettings } from './settings'
import {
  deleteRecording,
  getConfiguredRegions,
  isTwilioConfigured,
  listRecordingSidsBefore,
} from './twilio'

export type RetentionResult = {
  recordingsDeleted: number
  voicemailRowsDeleted: number
  errors: string[]
}

export async function runRetentionSweep(now: Date = new Date()): Promise<RetentionResult> {
  const result: RetentionResult = { recordingsDeleted: 0, voicemailRowsDeleted: 0, errors: [] }

  const { retentionDays } = await getTwilioSettings()
  if (retentionDays <= 0 || !isTwilioConfigured()) return result

  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)

  // Every Region the site holds a token for: recordings live in the Region
  // their call was processed in, so each one keeps its own listing. A Region
  // that fails is reported and skipped rather than aborting the others.
  for (const region of getConfiguredRegions()) {
    try {
      const sids = await listRecordingSidsBefore(cutoff, region)
      for (const sid of sids) {
        try {
          await deleteRecording(sid, region)
          result.recordingsDeleted++
        } catch (err) {
          result.errors.push(err instanceof Error ? err.message : `Failed to delete ${sid}`)
        }
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : `Failed to list recordings in ${region}`)
    }
  }

  // The rows go on our side regardless of how the Twilio deletes fared: a row
  // pointing at a recording Twilio already dropped is just noise in the log.
  result.voicemailRowsDeleted = await prisma.$executeRaw`
    DELETE FROM "tw_voicemails" WHERE "created_at" < ${cutoff}
  `

  return result
}
