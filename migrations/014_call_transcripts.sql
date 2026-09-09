-- Twilio Module - Migration 014: typing up a recorded call.
--
-- A voicemail is transcribed by Twilio as part of the <Record> that captured
-- it, free of any extra plumbing. A recorded CONVERSATION cannot be: <Dial> has
-- no transcribe attribute, and Twilio will only put words to a two-party call
-- through Voice Intelligence, which is a separate paid product working from the
-- finished recording. So this is opt-in per number, off everywhere until an
-- owner switches it on, and it costs them per minute when they do.
--
-- Three pieces: which numbers want it, the Voice Intelligence Service this site
-- transcribes through, and the words themselves.

-- Off on every existing number, which is the only safe default for something
-- that bills by the minute.
ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "transcribe_calls" BOOLEAN NOT NULL DEFAULT false;

-- The Voice Intelligence Service (GA...) this site's transcripts are created
-- against. Provisioned by the module the first time a transcript is asked for
-- and remembered here, so the owner never has to visit the Twilio console.
-- Empty = not provisioned yet.
ALTER TABLE "tw_settings"
    ADD COLUMN IF NOT EXISTS "intelligence_service_sid" TEXT NOT NULL DEFAULT '';

-- One row per recorded call we asked to have typed up.
--
-- Keyed on the RECORDING, not the call: the recording is what Voice
-- Intelligence works from, it is what the callback comes back about, and it is
-- what the call log already matches on. status is '' before anything has been
-- asked for, then 'pending' | 'completed' | 'failed', exactly as tw_voicemails
-- words it, so the two read the same way to anything showing them side by side.
CREATE TABLE IF NOT EXISTS "tw_call_transcripts" (
    "recording_sid"  TEXT         NOT NULL,
    "call_sid"       TEXT         NOT NULL DEFAULT '',
    -- The site number the call came in on, which is what says which Twilio
    -- Region the recording and the transcript live in. Without it a callback
    -- arriving days later has no way to find either of them again.
    "site_number"    TEXT         NOT NULL DEFAULT '',
    -- Voice Intelligence's own id for the job (GT...), empty until it answers.
    "transcript_sid" TEXT         NOT NULL DEFAULT '',
    "status"         TEXT         NOT NULL DEFAULT 'pending',
    "text"           TEXT         NOT NULL DEFAULT '',
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When the words landed, which is minutes after the call. Read by anything
    -- copying calls elsewhere on a schedule, so a transcript that arrived after
    -- the copy was taken is still noticed.
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_call_transcripts_pkey" PRIMARY KEY ("recording_sid")
);

-- The callback arrives knowing only Voice Intelligence's own id for the job.
CREATE INDEX IF NOT EXISTS "tw_call_transcripts_transcript_sid_idx"
    ON "tw_call_transcripts" ("transcript_sid")
    WHERE "transcript_sid" <> '';
