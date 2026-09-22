-- Backfill: referrals the old Status dropdown swallowed.
--
-- Until 2026-09-22 the Status column offered 'referred' as a choice. Picking
-- it set leads.status and nothing else -- referred_at stayed NULL. A lead in
-- that state is invisible to the Referrals tab (WHERE referred_at IS NOT NULL),
-- absent from the referral stats, and can never be billed to World Class.
--
-- The dashboard no longer lets anyone create that state. This repairs the rows
-- already in it.
--
-- STEP 1 -- look before you write. Run this and read the list:
--
--   npx wrangler d1 execute pianoplayertech-leads --remote \
--     --command "SELECT id, name, phone, city, status, created_at, updated_at \
--                  FROM leads WHERE status = 'referred' AND referred_at IS NULL \
--                 ORDER BY created_at DESC"
--
-- Every row it returns is a referral the CRM never recorded. If any of them
-- were NOT actually handed to World Class, fix their status by hand first --
-- this file trusts status = 'referred' to mean the referral really happened.
--
-- STEP 2 -- apply:
--
--   npx wrangler d1 execute pianoplayertech-leads --remote \
--     --file=db/2026-09-22-backfill-referred-at.sql
--
-- Safe to run twice: the WHERE clause matches nothing on a second pass.

UPDATE leads
   SET referred_at     = COALESCE(updated_at, created_at),
       referral_status = COALESCE(referral_status, 'sent'),
       notes           = TRIM(COALESCE(notes, '') || char(10) ||
                          '[' || substr(COALESCE(updated_at, created_at), 1, 10) ||
                          '] Referral date backfilled — marked referred before the' ||
                          ' dashboard recorded referral dates.'),
       updated_at      = COALESCE(updated_at, created_at)
 WHERE status = 'referred'
   AND referred_at IS NULL;

-- Afterwards these leads appear in the Referrals tab as "Sent — waiting".
-- Set each one's real outcome (Booked / Didn't book) there, then bill the
-- booked ones from the Invoices tab.
