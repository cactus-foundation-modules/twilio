// GET /api/m/twilio/cron/retention - nightly sweep deleting recordings and
// voicemail rows older than the configured keep-for period. A retention of 0
// (the default) makes this a no-op.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { runRetentionSweep } from '@/modules/twilio/lib/retention'

// Vercel appends `Authorization: Bearer $CRON_SECRET` to its own cron requests
// automatically when CRON_SECRET is set - no separate secret scheme needed.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)

  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  const result = await runRetentionSweep()
  if (result.errors.length > 0) {
    console.error('[twilio] retention sweep errors', result.errors)
  }
  return NextResponse.json({ ok: true, ...result })
}
