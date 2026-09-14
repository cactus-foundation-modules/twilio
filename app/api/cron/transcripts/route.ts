// GET /api/m/twilio/cron/transcripts - gives another chance to recorded calls
// that were booked locally but never received a Voice Intelligence transcript
// id from Twilio.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { retryUnacceptedCallTranscripts } from '@/modules/twilio/lib/call-transcripts'

// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests
// automatically when CRON_SECRET is set - no separate secret scheme needed.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)

  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const result = await retryUnacceptedCallTranscripts()
  return NextResponse.json({ ok: true, ...result })
}
