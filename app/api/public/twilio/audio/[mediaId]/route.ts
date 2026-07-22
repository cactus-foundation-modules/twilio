// GET /api/m/twilio/public/audio/[mediaId] - streams an uploaded greeting so
// Twilio's <Play> (and the admin's preview player) can fetch it.
//
// Public and unauthenticated, which is the feature: Twilio fetches greeting
// audio with a plain GET, and the content is what every caller to the number
// hears anyway. Ungated is not unchecked, though - the id must be referenced
// as greeting audio by a forwarding rule (isGreetingAudioMediaId), so this
// route cannot be used as an open proxy onto arbitrary media library files,
// some of which (digital products, say) are decidedly not public.
//
// Bytes are read by provider + key rather than the stored url - the url is
// the media Worker's, which may move or be unconfigured, while the key keeps
// working (the lesson product-downloads learned before us). It also sidesteps
// the Worker's content-type table, which knows images and 3D models but not
// audio.
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { downloadMedia } from '@/lib/media/upload'

// Whether this media id is referenced as greeting audio by any forwarding
// rule - the gate that stops this route doubling as an open proxy onto
// arbitrary media library files (some of which - digital products, member
// exports - are anything but public).
async function isGreetingAudioMediaId(mediaId: string): Promise<boolean> {
  if (!mediaId) return false
  const rows = await prisma.$queryRaw<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM "tw_forwarding_rules"
    WHERE greeting_audio_media_id = ${mediaId}
       OR voicemail_audio_media_id = ${mediaId}
       OR closed_voicemail_audio_media_id = ${mediaId}
    LIMIT 1
  `
  return rows.length > 0
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ mediaId: string }> }) {
  const { mediaId } = await params

  if (!(await isGreetingAudioMediaId(mediaId))) {
    return new NextResponse('Not found', { status: 404 })
  }

  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    select: { key: true, url: true, provider: true, mimeType: true },
  })
  if (!media) return new NextResponse('Not found', { status: 404 })

  let bytes: Buffer
  try {
    bytes = await downloadMedia(media.provider, media.key, media.url)
  } catch (err) {
    console.error(`[twilio] could not read greeting audio ${media.key}:`, err)
    return new NextResponse('That file could not be retrieved.', { status: 502 })
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': media.mimeType,
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      // Greetings change rarely, but a swapped one should not play the old
      // words all afternoon - and Twilio itself caches what it fetches.
      'Cache-Control': 'public, max-age=300',
    },
  })
}
