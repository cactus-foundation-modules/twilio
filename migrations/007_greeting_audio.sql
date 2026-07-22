-- Twilio Module - Migration 007: uploaded greeting audio
--
-- Each of the three spoken slots (call greeting, voicemail greeting, closed
-- voicemail greeting) can carry an uploaded audio file instead of text-to-
-- speech. The column holds the core media library id of the file (uploaded
-- into a root "twilio" folder via admin/greeting-audio); empty means no file,
-- so the <Say> text/voice pair carries on as before. The webhook serves the
-- bytes through public/audio/[mediaId], which only answers for ids referenced
-- by one of these columns.
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "greeting_audio_media_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "voicemail_audio_media_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "closed_voicemail_audio_media_id" TEXT NOT NULL DEFAULT '';
