-- Statuses, reshaped after two weeks of use, and a customer type on each lead.
--
-- Run once against production:
--   env -u CLOUDFLARE_API_TOKEN wrangler d1 execute pianoplayertech-leads --remote \
--     --file db/2026-09-30-statuses-and-customer-type.sql
--
-- 'scheduled' duplicated 'booked' and 'contacted' duplicated 'waiting'. Both
-- were empty in production on 2026-09-29; any stragglers are moved, not lost.
UPDATE leads SET status = 'booked'  WHERE status = 'scheduled';
UPDATE leads SET status = 'waiting' WHERE status = 'contacted';
DELETE FROM statuses WHERE key IN ('scheduled', 'contacted');

INSERT OR IGNORE INTO statuses (key, label, sort, is_open, is_won) VALUES
  ('needs_contact',  'Needs Contact',        15, 1, 0),
  ('diag_scheduled', 'Diagnostic Scheduled', 35, 1, 0),
  ('diagnosis',      'Diagnosis',            38, 1, 0),
  ('in_repair',      'In Repair',            75, 1, 1);

-- 'homeowner' | 'business' | 'dealer'. NULL means nobody has said.
ALTER TABLE leads ADD COLUMN customer_type TEXT;
