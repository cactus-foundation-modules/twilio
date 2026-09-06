-- Twilio Module - Migration 010: one number behaving exactly like another.
--
-- A number can be told to follow another number's call handling. The follower
-- keeps its own row (so unlinking restores whatever it had), but at call time
-- every behaviour field is read from the leader's row instead. Empty string =
-- not following anything, which is how every existing number stays as it is.
--
-- Only one level is allowed: a number that follows another may not itself be
-- followed. That is enforced where the rule is saved rather than in the
-- schema, because the check needs to look at the other row.
ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "follows_phone_sid" TEXT NOT NULL DEFAULT '';

-- Answering "which numbers follow this one" on every save of a leader, so its
-- followers' Twilio webhooks can be re-pointed at the same time.
CREATE INDEX IF NOT EXISTS "tw_forwarding_rules_follows_idx"
    ON "tw_forwarding_rules" ("follows_phone_sid")
    WHERE "follows_phone_sid" <> '';
