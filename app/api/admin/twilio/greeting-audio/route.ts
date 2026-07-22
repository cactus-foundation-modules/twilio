// POST /api/m/twilio/admin/greeting-audio - upload an audio file to play as a
// call/voicemail greeting instead of text-to-speech. The file lands in the
// core media library's root "twilio" folder on the site's active media
// provider; the response hands back the media id the forwarding form stores
// on the rule when saved.
import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { validateNonImageUpload, uploadMedia, saveMediaRecord } from '@/lib/media/upload'
import { resolveFolderPath, createFolder } from '@/lib/media/organise'
import { prisma } from '@/lib/db/prisma'
import {
  GREETING_AUDIO_TYPES,
  MAX_GREETING_AUDIO_BYTES,
  GREETING_AUDIO_FOLDER,
} from '@/modules/twilio/lib/greeting-audio'

// Find the twilio folder, creating it on first use. Handles the rare create
// race (two uploads at once) by re-reading after a unique-constraint fail -
// same shape as the gemini module's processed folder.
async function ensureTwilioFolder(): Promise<string> {
  const existing = await prisma.folder.findFirst({
    where: { parentId: null, name: GREETING_AUDIO_FOLDER },
    select: { id: true },
  })
  if (existing) return existing.id
  try {
    const folder = await createFolder(GREETING_AUDIO_FOLDER, null)
    return folder.id
  } catch {
    const row = await prisma.folder.findFirst({
      where: { parentId: null, name: GREETING_AUDIO_FOLDER },
      select: { id: true },
    })
    if (row) return row.id
    throw new Error('Could not create the twilio media folder')
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'twilio.manage'))) return errorResponse('Forbidden', 403)

  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    return errorResponse('No media storage is configured yet - set one up on the Media page first.', 503)
  }

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return errorResponse('Choose an audio file to upload.')

  // The stored type is the normalised one - browsers report MP3 and WAV under
  // several names (GREETING_AUDIO_TYPES) and Twilio's player cares which.
  const mimeType = GREETING_AUDIO_TYPES[file.type]
  if (!mimeType) {
    return errorResponse('That is not a supported audio file. Upload an MP3 or WAV.')
  }

  const validation = await validateNonImageUpload(mimeType, file.size, {
    allowedMimeTypes: Object.values(GREETING_AUDIO_TYPES),
    maxSizeBytes: MAX_GREETING_AUDIO_BYTES,
  })
  if (!validation.valid) return errorResponse(validation.reason)

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const folderId = await ensureTwilioFolder()
    const folderPath = await resolveFolderPath(folderId)
    const result = await uploadMedia(buffer, mimeType, provider, file.name, folderPath || undefined)
    const media = await saveMediaRecord({
      key: result.key,
      url: result.url,
      provider,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      uploadedById: user.id,
      originalName: file.name,
      folderId,
    })
    return NextResponse.json(
      { mediaId: media.id, name: file.name },
      { status: 201 }
    )
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Failed to upload the audio file', 502)
  }
}
