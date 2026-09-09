// POST /api/m/twilio/webhooks/recording - Twilio's recordingStatusCallback for
// a forwarded call that was being recorded. Fires once the recording is ready,
// which is after the two people have hung up.
//
// Its ONLY job is to ask Voice Intelligence to type the recording up, and only
// where the number's owner switched that on - it bills by the minute, so a
// number that never asked for it must never reach the request below. The words
// come back later still, through the intelligence webhook.
//
// Signature-validated; no session (Twilio is the caller). Answers 204 with no
// TwiML: the call is long over and there is nothing left to tell it to do.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { validateTwilioSignature, isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { getRuleForNumber } from '@/modules/twilio/lib/forwarding'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { requestTranscript } from '@/modules/twilio/lib/intelligence'
import { beginCallTranscript, setCallTranscriptSid } from '@/modules/twilio/lib/call-transcripts'

const RECORDING_SID = /^RE[a-f0-9]{32}$/i

export async function POST(request: NextRequest) {
  if (!isTwilioConfigured()) return new NextResponse('Not configured', { status: 503 })

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }

  // Twilio signs the exact URL it was given, query string included - the site
  // number rides on it, because the callback payload names the two ends of the
  // DIALLED leg and neither of them need be ours.
  const signature = request.headers.get('x-twilio-signature') ?? ''
  const url = `${getSiteUrl()}/api/m/twilio/webhooks/recording${request.nextUrl.search}`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  const recordingSid = params.RecordingSid ?? ''
  // Twilio sends this callback for several recording events. Anything but a
  // finished recording has nothing to transcribe.
  if (params.RecordingStatus !== 'completed' || !RECORDING_SID.test(recordingSid)) {
    return new NextResponse(null, { status: 204 })
  }

  const siteNumber = request.nextUrl.searchParams.get('number') ?? ''
  const rule = siteNumber ? await getRuleForNumber(siteNumber) : null
  // The switch is read at the moment the recording lands rather than trusted
  // from when the call started: an owner who turned it off mid-call meant it.
  if (!rule?.transcribeCalls) return new NextResponse(null, { status: 204 })

  // Booked in before the request goes out, so a request that fails or whose
  // reply is lost leaves a row somebody can see rather than nothing at all.
  // A repeat callback for the same recording stops here.
  const fresh = await beginCallTranscript({
    recordingSid,
    callSid: params.CallSid ?? '',
    siteNumber,
  })
  if (!fresh) return new NextResponse(null, { status: 204 })

  // Logged, never thrown. Twilio retries a failed recording callback, and a
  // retry would find the row already booked in and do nothing - so an error
  // here must not turn into a loop of 500s over a transcript that is a
  // convenience. The recording itself is safe either way.
  try {
    const region = await resolveNumberRegion(siteNumber)
    const transcriptSid = await requestTranscript(recordingSid, region)
    await setCallTranscriptSid(recordingSid, transcriptSid)
  } catch (err) {
    console.error('[twilio] could not ask for a transcript of', recordingSid, err)
  }

  return new NextResponse(null, { status: 204 })
}
