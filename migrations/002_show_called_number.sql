-- Twilio Module - Migration 002
-- Adds per-rule caller ID choice: when show_called_number is true, the
-- forwarded call presents the site's Twilio number as caller ID instead of
-- the original caller's number.
ALTER TABLE "tw_forwarding_rules" ADD COLUMN IF NOT EXISTS "show_called_number" BOOLEAN NOT NULL DEFAULT false;
