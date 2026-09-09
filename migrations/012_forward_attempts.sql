-- Twilio Module - Migration 012: ring a forwarding number more than once.
--
-- The ring timeout already exists to cut a forwarded call off before the
-- receiving handset gives up and offers its OWN voicemail - a caller who lands
-- in a mobile's mailbox never reaches the site's, and the message is lost to
-- whoever owns that handset. Cutting the ring short solves that but gives the
-- person one short chance to pick up.
--
-- forward_attempts is how many times each forwarding number is rung before the
-- call moves on (to the second number, then to voicemail). 1 is exactly the
-- behaviour every existing number has today, which is why it is the default.
ALTER TABLE "tw_forwarding_rules"
    ADD COLUMN IF NOT EXISTS "forward_attempts" INTEGER NOT NULL DEFAULT 1;
