-- Twilio Module - Migration 009
-- Blocked callers: numbers whose calls are refused before anything on the site
-- rings, records, texts back or emails.
-- All DDL idempotent; 001_initial.sql carries the same shape for fresh installs.

-- The number itself is the key. There is one answer to "is this caller blocked"
-- and it is a property of the number, so a second row for the same number is a
-- contradiction rather than a second fact - hence the primary key rather than an
-- id column with a unique index bolted on beside it.
--
-- E.164 only, enforced on the way in. A withheld caller has no number to keep,
-- so cannot be blocked here at all; each number's own anonymous_callers rule is
-- what turns those away.
--
-- blocked_by is who did it, for the audit trail, and goes null rather than
-- taking the block with it when that person leaves. A caller stays blocked
-- because somebody decided they should be, not because that somebody still
-- works here.
CREATE TABLE IF NOT EXISTS "tw_blocked_numbers" (
    "phone_number" TEXT         NOT NULL,
    "reason"       TEXT         NOT NULL DEFAULT '',
    "blocked_by"   TEXT,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tw_blocked_numbers_pkey" PRIMARY KEY ("phone_number"),
    CONSTRAINT "tw_blocked_numbers_blocked_by_fk" FOREIGN KEY ("blocked_by")
        REFERENCES "User" ("id") ON DELETE SET NULL
);
