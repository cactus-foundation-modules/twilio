// POST /api/m/twilio/webhooks/transcription - Twilio's transcribeCallback,
// requested a few minutes after a voicemail <Record> with transcribe="true"
// finishes. Files the text (or the failure) onto the voicemail's row so the
// call log can show it. Signature-validated; no session (Twilio is the caller).
//
// Twilio expects a 200 and nothing else - this callback carries no TwiML
// stage, the call is long over.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { recordTranscription } from '@/modules/twilio/lib/voicemail-log'

export async function POST(request: NextRequest) {
  if (!isTwilioConfigured()) {
    return new NextResponse('Not configured', { status: 503 })
  }

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }

  const signature = request.headers.get('x-twilio-signature') ?? ''
  const url = `${getSiteUrl()}/api/m/twilio/webhooks/transcription`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  const recordingSid = params.RecordingSid ?? ''
  if (recordingSid) {
    // Logged, never thrown: a failure to file the text must not make Twilio
    // retry into an error loop - the recording itself is safe either way.
    try {
      await recordTranscription({
        recordingSid,
        status: params.TranscriptionStatus ?? '',
        text: params.TranscriptionText ?? '',
      })
    } catch (err) {
      console.error('[twilio] failed to record transcription', recordingSid, err)
    }
  }

  return new NextResponse(null, { status: 204 })
}
