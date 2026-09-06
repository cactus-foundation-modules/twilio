-- Twilio Module - Migration 011: WhatsApp.
--
-- Twilio carries WhatsApp over the same Messages resource as SMS, with both
-- ends addressed "whatsapp:+E164" instead of "+E164". So there is no message
-- store to add here: WhatsApp messages are read live from Twilio exactly as
-- texts and calls already are, and what this migration adds is only the two
-- things Twilio cannot tell us.
--
--   WHICH NUMBER SENDS. A WhatsApp sender is registered with Meta per number
--   and does not appear in the account's IncomingPhoneNumbers capabilities, so
--   nothing on the API says "this number does WhatsApp". It also need not be a
--   number on the account at all: everybody starts on Twilio's shared sandbox
--   sender, which belongs to Twilio. Hence a plain stored E.164 on the settings
--   row rather than a flag on tw_site_numbers, which could not express it.
--
--   WHICH TEMPLATES ARE APPROVED. Outside the 24 hours after a customer's last
--   message WhatsApp refuses free text and takes only a template Meta has
--   approved, addressed by its Twilio Content SID. Twilio's Content API can
--   list them, but only the site knows which ones it actually means to use and
--   what to call them in front of staff, so they are registered here.
--
-- All DDL idempotent.

-- The WhatsApp sender ----------------------------------------------------------
-- whatsapp_sender is E.164 with no "whatsapp:" prefix - the prefix is Twilio's
-- addressing scheme and belongs in the code that talks to Twilio, not in the
-- stored value. Empty = no sender chosen, which keeps WhatsApp off whatever the
-- toggle says (same rule as notify_email and the alert toggles).
--
-- whatsapp_region is stored rather than derived because the sender may not be
-- one of the site's own numbers, so there is no tw_site_numbers row to read a
-- region off. Empty = the account's home region.
ALTER TABLE "tw_settings" ADD COLUMN IF NOT EXISTS "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tw_settings" ADD COLUMN IF NOT EXISTS "whatsapp_sender"  TEXT    NOT NULL DEFAULT '';
ALTER TABLE "tw_settings" ADD COLUMN IF NOT EXISTS "whatsapp_region"  TEXT    NOT NULL DEFAULT '';

-- Approved message templates ---------------------------------------------------
-- content_sid is Twilio's own id for the template (HX + 32 hex). Unique,
-- because registering the same template twice is a mistake rather than a
-- second template, and the list is picked from by hand.
--
-- variable_count is what the template expects, so the send form can ask for
-- exactly that many and refuse a mismatch before Twilio does. Twilio numbers
-- its variables from 1.
CREATE TABLE IF NOT EXISTS "tw_whatsapp_templates" (
    "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "content_sid"    TEXT         NOT NULL,
    "label"          TEXT         NOT NULL DEFAULT '',
    "variable_count" INTEGER      NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tw_whatsapp_templates_content_sid_key"
    ON "tw_whatsapp_templates" ("content_sid");
