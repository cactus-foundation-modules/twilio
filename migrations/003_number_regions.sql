-- Twilio Module - per-number inbound processing Region.
--
-- Each Twilio number is routed to a Region (us1/ie1/au1) that processes and
-- stores its calls and texts. Mirrored here from Twilio's Routes API so the
-- log, recording and outbound-send paths know which regional endpoint holds a
-- given number's data without a round-trip first.
--
-- us1 is Twilio's default for a number that has never been routed, so it is the
-- correct backfill for every existing row.

ALTER TABLE "tw_site_numbers"
    ADD COLUMN IF NOT EXISTS "region" TEXT NOT NULL DEFAULT 'us1';
