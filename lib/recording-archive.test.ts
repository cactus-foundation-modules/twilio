import { beforeEach, describe, expect, it, vi } from 'vitest'

// Taking a recording off Twilio must never be the moment it is lost. The order
// is the whole point: copy on the site first, Twilio second, and a Twilio that
// already dropped it counts as done rather than as a failure.

const queryRaw = vi.hoisted(() => vi.fn())
const executeRaw = vi.hoisted(() => vi.fn())
const getActiveMediaProvider = vi.hoisted(() => vi.fn())
const isMediaProviderConfigured = vi.hoisted(() => vi.fn())
const uploadMedia = vi.hoisted(() => vi.fn())
const deleteMedia = vi.hoisted(() => vi.fn())
const fetchRecordingAudio = vi.hoisted(() => vi.fn())
const deleteRecording = vi.hoisted(() => vi.fn())
const twilioFetch = vi.hoisted(() => vi.fn())

class TwilioApiError extends Error {
  constructor(public readonly httpStatus: number, message: string) { super(message) }
}

vi.mock('@prisma/client', () => ({ Prisma: { join: (v: unknown[]) => v } }))
vi.mock('@/lib/db/prisma', () => ({ prisma: { $queryRaw: queryRaw, $executeRaw: executeRaw } }))
vi.mock('@/lib/config/env', () => ({ getActiveMediaProvider, isMediaProviderConfigured }))
vi.mock('@/lib/media/upload', () => ({
  uploadMedia, deleteMedia, downloadMedia: vi.fn(), mediaKeyPrefix: () => 'media/',
}))
vi.mock('./twilio', () => ({ TwilioApiError, deleteRecording, fetchRecordingAudio, twilioFetch }))

const { removeFromTwilio, deleteSavedCopy, RecordingArchiveError } = await import('./recording-archive')

const SID = 'RE00000000000000000000000000000001'
const input = { recordingSid: SID, siteNumber: '+441134960000', region: 'ie1' as const }
const savedRow = {
  recording_sid: SID, call_sid: 'CA1', site_number: '+441134960000', media_provider: 'B2',
  media_key: 'media/twilio/recordings/abc-x.mp3', media_url: 'https://x', content_type: 'audio/mpeg',
  size_bytes: 3, archived_at: new Date(), twilio_deleted_at: null, copy_deleted_at: null, updated_at: new Date(),
}

beforeEach(() => {
  queryRaw.mockReset()
  executeRaw.mockReset().mockResolvedValue(1)
  getActiveMediaProvider.mockReset().mockResolvedValue('B2')
  isMediaProviderConfigured.mockReset().mockReturnValue(true)
  uploadMedia.mockReset().mockResolvedValue({ key: savedRow.media_key, url: 'https://x', mimeType: 'audio/mpeg', sizeBytes: 3 })
  deleteMedia.mockReset().mockResolvedValue(undefined)
  fetchRecordingAudio.mockReset().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
    status: 200, headers: { 'content-type': 'audio/mpeg' },
  }))
  deleteRecording.mockReset().mockResolvedValue(undefined)
  twilioFetch.mockReset().mockResolvedValue({ call_sid: 'CA00000000000000000000000000000001' })
})

describe('taking a recording off Twilio', () => {
  it('saves a copy on the site before asking Twilio to delete it', async () => {
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([savedRow])
    await removeFromTwilio(input)

    expect(uploadMedia).toHaveBeenCalledTimes(1)
    const key = uploadMedia.mock.calls[0]![6] as string
    // Unguessable: the media Worker serves anything under media/ by key.
    expect(key).toMatch(new RegExp(`^media/twilio/recordings/[0-9a-f]{32}-${SID}\\.mp3$`))
    expect(uploadMedia.mock.invocationCallOrder[0]!).toBeLessThan(deleteRecording.mock.invocationCallOrder[0]!)
    expect(deleteRecording).toHaveBeenCalledWith(SID, 'ie1')
    expect(executeRaw).toHaveBeenCalled()
  })

  it('does not copy twice when the site already holds one', async () => {
    queryRaw.mockResolvedValueOnce([savedRow])
    await removeFromTwilio(input)
    expect(uploadMedia).not.toHaveBeenCalled()
    expect(deleteRecording).toHaveBeenCalled()
  })

  it('counts a recording Twilio already dropped as taken off', async () => {
    queryRaw.mockResolvedValueOnce([savedRow])
    deleteRecording.mockRejectedValue(new TwilioApiError(404, 'not found'))
    await expect(removeFromTwilio(input)).resolves.toBeUndefined()
    expect(executeRaw).toHaveBeenCalled()
  })

  it('leaves Twilio alone when the copy could not be made', async () => {
    queryRaw.mockResolvedValueOnce([])
    getActiveMediaProvider.mockResolvedValue(null)
    await expect(removeFromTwilio(input)).rejects.toBeInstanceOf(RecordingArchiveError)
    expect(deleteRecording).not.toHaveBeenCalled()
  })

  it('says so in words when Twilio refuses, and does not mark it taken off', async () => {
    queryRaw.mockResolvedValueOnce([savedRow])
    deleteRecording.mockRejectedValue(new TwilioApiError(500, 'boom'))
    await expect(removeFromTwilio(input)).rejects.toBeInstanceOf(RecordingArchiveError)
    expect(executeRaw).not.toHaveBeenCalled()
  })
})

describe('throwing away the saved copy', () => {
  it('deletes the bytes before forgetting where they were', async () => {
    queryRaw.mockResolvedValueOnce([savedRow])
    await deleteSavedCopy(SID)
    expect(deleteMedia).toHaveBeenCalledWith('B2', savedRow.media_key)
    expect(deleteMedia.mock.invocationCallOrder[0]!).toBeLessThan(executeRaw.mock.invocationCallOrder[0]!)
  })

  it('does nothing when there is no copy', async () => {
    queryRaw.mockResolvedValueOnce([])
    await deleteSavedCopy(SID)
    expect(deleteMedia).not.toHaveBeenCalled()
    expect(executeRaw).not.toHaveBeenCalled()
  })
})
