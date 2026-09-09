-- Twilio Module - Migration 013: when a voicemail row last changed.
--
-- A transcription lands minutes after the recording, in a request of its own,
-- and until now nothing recorded that the row had moved. Anything reading this
-- table on a schedule - the unified inbox copies conversations across on a tick
-- - therefore saw a voicemail exactly once, in whatever state it was in at that
-- moment, and a transcript that arrived a minute later was never picked up.
--
-- created_at still says when the message was left, which is what orders it in a
-- conversation. updated_at says when we last learned something new about it.
ALTER TABLE "tw_voicemails"
    ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
