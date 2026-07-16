-- Twilio Module - Migration 005: voicemail log
--
-- Twilio's own Recordings listing cannot tell a voicemail message apart from a
-- recorded forwarded call: both are plain recordings against a call SID. The
-- only place the two are distinguishable is the moment the <Record> in the
-- voicemail TwiML finishes, which is a request this module handles - so that is
-- where the recording SID gets written down.
--
-- One row per voicemail message. The audio itself stays in the Twilio account;
-- this table only says "that recording is a voicemail" and carries enough
-- caller detail for the admin notification.
--
-- Also mirrored into 001_initial.sql so fresh installs get the table from the
-- start. The DDL here is idempotent, so the overlap on a fresh install is
-- harmless.

CREATE TABLE IF NOT EXISTS "tw_voicemails" (
    -- The Twilio recording SID, which is what the call log matches on. Also the
    -- natural primary key: Twilio will not hand out the same SID twice, and it
    -- makes a repeated callback for one recording an idempotent no-op.
    "recording_sid"    TEXT         NOT NULL,
    "call_sid"         TEXT         NOT NULL,
    -- Caller and called number, in E.164. Kept here rather than looked up from
    -- Twilio later: the notification needs them, and a call's own record ages
    -- out of the account's listing long before this row does.
    "from_number"      TEXT         NOT NULL DEFAULT '',
    "to_number"        TEXT         NOT NULL DEFAULT '',
    "duration_seconds" INTEGER      NOT NULL DEFAULT 0,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_voicemails_pkey" PRIMARY KEY ("recording_sid")
);

-- The call log looks voicemails up by call SID, in batches of one page of calls.
CREATE INDEX IF NOT EXISTS "tw_voicemails_call_sid_idx" ON "tw_voicemails" ("call_sid");
