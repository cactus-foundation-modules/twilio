-- Twilio Module - Migration 015: keeping a copy of a recording on the site.
--
-- A recording lives in the Twilio account, which charges to keep it and which an
-- owner may want it out of. Before one is deleted there, it is copied into the
-- site's own storage, so taking it off Twilio never means losing it. The copy
-- can then be thrown away on its own, which is the end of the recording for good.
--
-- One row per recording ever copied, kept after either copy goes: it is what
-- says a recording missing from Twilio was taken off on purpose rather than
-- lost, and what the call log reads to keep offering the saved copy.
CREATE TABLE IF NOT EXISTS "tw_recording_archive" (
    "recording_sid"     TEXT         NOT NULL,
    -- The call it belongs to, so a call whose recording has left Twilio can
    -- still show it: the call listing only knows the recordings Twilio holds.
    "call_sid"          TEXT         NOT NULL DEFAULT '',
    -- The site number, which says which Twilio Region the recording was in.
    "site_number"       TEXT         NOT NULL DEFAULT '',
    -- Where the copy is. Empty once it has been deleted.
    "media_provider"    TEXT         NOT NULL DEFAULT '',
    "media_key"         TEXT         NOT NULL DEFAULT '',
    "media_url"         TEXT         NOT NULL DEFAULT '',
    "content_type"      TEXT         NOT NULL DEFAULT 'audio/mpeg',
    "size_bytes"        INTEGER      NOT NULL DEFAULT 0,
    "archived_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- When it was taken off Twilio, and when the site's copy was thrown away.
    "twilio_deleted_at" TIMESTAMP(3),
    "copy_deleted_at"   TIMESTAMP(3),
    "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_recording_archive_pkey" PRIMARY KEY ("recording_sid")
);

CREATE INDEX IF NOT EXISTS "tw_recording_archive_call_sid_idx"
    ON "tw_recording_archive" ("call_sid")
    WHERE "call_sid" <> '';
