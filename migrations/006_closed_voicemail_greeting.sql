-- Twilio Module - Migration 006: a separate voicemail greeting for closed hours
--
-- "Sorry, nobody is available to take your call" is the right thing to say when
-- the phone rang out, and the wrong thing to say at 3am on a Sunday, when the
-- caller would rather be told when the place opens again. So the greeting the
-- caller hears outside opening hours gets its own text.
--
-- Empty means "say the usual voicemail greeting", which is how every rule
-- written before this migration already behaves. Only the words differ: the
-- voice, the recording length and everything else stay shared with
-- voicemail_greeting, because a number that sounds like two different
-- businesses depending on the hour is a bug, not a feature.
--
-- Also mirrored into 001_initial.sql so fresh installs get the column from the
-- start. The DDL here is idempotent, so the overlap on a fresh install is
-- harmless.

ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "closed_voicemail_greeting" TEXT NOT NULL DEFAULT '';
