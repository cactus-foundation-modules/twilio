// POST /api/m/twilio/webhooks/intelligence - Voice Intelligence's callback,
// fired when a transcript it was asked for is ready. Files the words on the
// call's row so the call log and the merged inbox can show them.
//
// THIS ONE IS NOT SIGNED, and that is the whole design of it.
//
// Voice Intelligence webhooks are configured on the Service rather than per
// request, and do not carry the X-Twilio-Signature the voice webhooks are
// checked against. So nothing in the request body is believed. It names a job;
// everything acted on is then read back from Twilio with this site's own
// credentials, and only after the job has been matched to a recording this site
// asked about and to the Voice Intelligence service this site created. A forged
// request can therefore make the site re-read a transcript it already owns, and
// nothing else.
//
// Answers 204 either way. There is no call in progress and nothing to instruct.
import { NextRequest, NextResponse } from 'next/server'
import { isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import {
  TRANSCRIPT_SID,
  fetchTranscriptText,
  intelligenceRegionFallback,
} from '@/modules/twilio/lib/intelligence'
import {
  callTranscriptByTranscriptSid,
  recordCallTranscript,
} from '@/modules/twilio/lib/call-transcripts'

/** Voice Intelligence posts JSON, unlike the voice webhooks' form encoding. */
type Payload = { transcript_sid?: string; event_type?: string }

export async function POST(request: NextRequest) {
  if (!isTwilioConfigured()) return new NextResponse('Not configured', { status: 503 })

  let payload: Payload = {}
  try {
    payload = (await request.json()) as Payload
  } catch {
    return new NextResponse(null, { status: 204 })
  }

  const transcriptSid = payload.transcript_sid ?? ''
  if (!TRANSCRIPT_SID.test(transcriptSid)) return new NextResponse(null, { status: 204 })

  // A job this site did not ask about is not this site's business. This is the
  // first of the two checks that stand in for a signature; the second is inside
  // fetchTranscriptText, which refuses a transcript belonging to another
  // service.
  const row = await callTranscriptByTranscriptSid(transcriptSid)
  if (!row) return new NextResponse(null, { status: 204 })
  // Already filed. Twilio may call twice, and re-reading a finished transcript
  // would only cost a pair of API requests to write down what is already there.
  if (row.status === 'completed') return new NextResponse(null, { status: 204 })

  try {
    const region = row.siteNumber
      ? await resolveNumberRegion(row.siteNumber)
      : intelligenceRegionFallback()
    const { status, text } = await fetchTranscriptText(transcriptSid, region)
    await recordCallTranscript({ transcriptSid, status, text })
  } catch (err) {
    // Logged rather than raised, for the same reason the transcription callback
    // swallows its failures: the recording is safe, and a 500 here only makes
    // Twilio try again at a transcript that is a convenience.
    console.error('[twilio] could not file a call transcript', transcriptSid, err)
  }

  return new NextResponse(null, { status: 204 })
}
