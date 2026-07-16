-- Twilio Module - Migration 004: per-number voicemail
--
-- Adds voicemail to each number's forwarding rule: whether it is switched on,
-- how long the forward-to number rings before voicemail takes the call, the
-- greeting the caller hears, and the opening hours outside of which callers go
-- straight to voicemail without the phone ringing at all.
--
-- Also mirrored into 001_initial.sql so fresh installs get the columns from the
-- start. The DDL here is idempotent, so the overlap on a fresh install is
-- harmless.

ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "voicemail_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Seconds the forward-to number rings before voicemail takes over. Only used
-- when voicemail is on; Twilio caps <Dial timeout> at 600, the admin form at 120.
ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "ring_timeout" INTEGER NOT NULL DEFAULT 20;

-- Read to the caller before recording. Separate from greeting_message, which is
-- the notice played before a call is forwarded.
ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "voicemail_greeting" TEXT NOT NULL DEFAULT '';

ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "voicemail_voice" TEXT NOT NULL DEFAULT '';

-- Opening hours as a JSON array of {day, closed, open, close} entries, where
-- day 0 is Sunday and open/close are "HH:MM" in the site's timezone. An empty
-- array means no schedule at all: the number behaves identically at every hour,
-- which is what every rule written before this migration wants.
ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "business_hours" JSONB NOT NULL DEFAULT '[]'::jsonb;
