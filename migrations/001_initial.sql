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
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_forwarding_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "tw_forwarding_rules_phone_sid_key" ON "tw_forwarding_rules" ("phone_sid");
CREATE INDEX IF NOT EXISTS "tw_forwarding_rules_phone_number_idx" ON "tw_forwarding_rules" ("phone_number");

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
