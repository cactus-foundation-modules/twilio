-- Twilio Module - Initial Migration
-- Table prefix: tw_
-- Applied once by the Cactus module migration runner during build.

-- ---------------------------------------------------------------------------
-- Forwarding rules - one per Twilio incoming phone number. When enabled, the
-- number's voice webhook points at this module and inbound calls are dialled
-- straight through to forward_to.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "tw_forwarding_rules" (
    "id"           TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "phone_sid"    TEXT         NOT NULL,
    "phone_number" TEXT         NOT NULL,
    "forward_to"   TEXT         NOT NULL DEFAULT '',
    "enabled"      BOOLEAN      NOT NULL DEFAULT false,
    -- Optional greeting read out (Twilio <Say>) before the call is dialled
    -- through, and whether Twilio records the forwarded leg.
    "greeting_message" TEXT     NOT NULL DEFAULT '',
    "greeting_voice"   TEXT     NOT NULL DEFAULT '',
    "record_calls"     BOOLEAN  NOT NULL DEFAULT false,
    -- When true, the forwarded leg shows the site's Twilio number as caller
    -- ID instead of the original caller's number.
    "show_called_number" BOOLEAN NOT NULL DEFAULT false,
    -- Voicemail: taken when the forwarded leg goes unanswered, when the number
    -- is called outside its opening hours, or when forwarding is off entirely.
    -- ring_timeout is how many seconds the forward-to number rings first, and
    -- business_hours is a JSON array of {day, closed, open, close} entries
    -- (day 0 = Sunday, "HH:MM" in the site timezone). Empty array = no
    -- schedule, so the number behaves the same at every hour. See migration 004.
    "voicemail_enabled"  BOOLEAN NOT NULL DEFAULT false,
    "ring_timeout"       INTEGER NOT NULL DEFAULT 20,
    "voicemail_greeting" TEXT    NOT NULL DEFAULT '',
    "voicemail_voice"    TEXT    NOT NULL DEFAULT '',
    "business_hours"     JSONB   NOT NULL DEFAULT '[]'::jsonb,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_forwarding_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tw_forwarding_rules_phone_sid_key" ON "tw_forwarding_rules" ("phone_sid");
CREATE INDEX IF NOT EXISTS "tw_forwarding_rules_phone_number_idx" ON "tw_forwarding_rules" ("phone_number");

-- ---------------------------------------------------------------------------
-- Numbers from the connected Twilio account that the admin has added to the
-- site. Texts are only ever sent from the (single) default SMS number, which
-- must be SMS-capable. Capability flags and the routing region are refreshed
-- from Twilio whenever the numbers are listed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "tw_site_numbers" (
    "id"             TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "phone_sid"      TEXT         NOT NULL,
    "phone_number"   TEXT         NOT NULL,
    "friendly_name"  TEXT         NOT NULL DEFAULT '',
    "sms_capable"    BOOLEAN      NOT NULL DEFAULT false,
    "is_default_sms" BOOLEAN      NOT NULL DEFAULT false,
    -- Twilio Region processing this number's calls and texts (us1/ie1/au1),
    -- mirrored from the Routes API. See migration 003.
    "region"         TEXT         NOT NULL DEFAULT 'us1',
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_site_numbers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tw_site_numbers_phone_sid_key" ON "tw_site_numbers" ("phone_sid");
-- At most one default SMS number.
CREATE UNIQUE INDEX IF NOT EXISTS "tw_site_numbers_default_sms_key" ON "tw_site_numbers" ("is_default_sms") WHERE "is_default_sms";

-- ---------------------------------------------------------------------------
-- Voicemail messages left on the site's numbers. One row per recording made by
-- the voicemail TwiML; the audio itself stays in the Twilio account. Twilio's
-- Recordings listing cannot say which recordings are voicemails and which are
-- recorded forwarded calls, so the call log matches against this table. See
-- migration 005.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "tw_voicemails" (
    "recording_sid"    TEXT         NOT NULL,
    "call_sid"         TEXT         NOT NULL,
    "from_number"      TEXT         NOT NULL DEFAULT '',
    "to_number"        TEXT         NOT NULL DEFAULT '',
    "duration_seconds" INTEGER      NOT NULL DEFAULT 0,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_voicemails_pkey" PRIMARY KEY ("recording_sid")
);
CREATE INDEX IF NOT EXISTS "tw_voicemails_call_sid_idx" ON "tw_voicemails" ("call_sid");

-- ---------------------------------------------------------------------------
-- Phone verification codes for SMS 2FA enrolment (admins and members).
-- Hashed code, short TTL, capped attempts - mirrors core email challenges.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "tw_verification_codes" (
    "id"              TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
    "subject_type"    TEXT         NOT NULL,
    "subject_id"      TEXT         NOT NULL,
    "phone_encrypted" TEXT         NOT NULL,
    "code_hash"       TEXT         NOT NULL,
    "attempts"        INTEGER      NOT NULL DEFAULT 0,
    "expires_at"      TIMESTAMP(3) NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_verification_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tw_verification_codes_subject_key" ON "tw_verification_codes" ("subject_type", "subject_id");
