-- Twilio Module - Migration 008
-- Settings-page redesign batch: per-number call features (auto-text on missed
-- call, holiday dates, voicemail transcription, anonymous-caller handling,
-- second forward-to number), voicemail transcription storage, and a singleton
-- module settings row (email alerts + recording retention).
-- All DDL idempotent; 001_initial.sql carries the same shape for fresh installs.

-- Per-number call features -------------------------------------------------
-- Auto-text: when nobody picks up a forwarded call, text the caller back from
-- the number they rang. Message empty = a stock line is sent.
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "missed_call_sms_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "missed_call_sms_message" TEXT NOT NULL DEFAULT '';
-- One-off closed dates on top of the weekly schedule: JSON array of
-- "YYYY-MM-DD" strings, evaluated in the site timezone like business_hours.
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "holiday_dates" JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Ask Twilio to transcribe voicemail messages; the transcription callback
-- writes the text onto tw_voicemails.
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "transcribe_voicemail" BOOLEAN NOT NULL DEFAULT false;
-- What happens to callers with a withheld number: 'allow' (ring through,
-- the default), 'voicemail' (straight to voicemail), 'reject'.
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "anonymous_callers" TEXT NOT NULL DEFAULT 'allow';
-- Optional second forward-to number, rung when the first goes unanswered and
-- before voicemail takes the call. Empty = no second leg.
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "forward_to_second" TEXT NOT NULL DEFAULT '';

-- Voicemail transcription --------------------------------------------------
-- status: '' (never requested) | 'pending' | 'completed' | 'failed'.
ALTER TABLE "tw_voicemails" ADD COLUMN IF NOT EXISTS "transcription_text" TEXT NOT NULL DEFAULT '';
ALTER TABLE "tw_voicemails" ADD COLUMN IF NOT EXISTS "transcription_status" TEXT NOT NULL DEFAULT '';

-- Module settings (singleton row) -------------------------------------------
-- notify_email empty = alerts stay off regardless of the toggles.
-- retention_days 0 = keep recordings and voicemails forever.
CREATE TABLE IF NOT EXISTS "tw_settings" (
    "id"                       TEXT         NOT NULL DEFAULT 'singleton',
    "notify_voicemail_email"   BOOLEAN      NOT NULL DEFAULT false,
    "notify_missed_call_email" BOOLEAN      NOT NULL DEFAULT false,
    "notify_email"             TEXT         NOT NULL DEFAULT '',
    "retention_days"           INTEGER      NOT NULL DEFAULT 0,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_settings_pkey" PRIMARY KEY ("id")
);
