-- Custom tables (tabs the owner defines) and a category on every lead.
--
-- Step 1 of 3. Run once against production, BEFORE deploying the code:
--   npx wrangler d1 execute pianoplayertech-leads --remote --file db/2026-10-23-custom-tables.sql
-- Step 2: deploy. Step 3, AFTER the deploy:
--   npx wrangler d1 execute pianoplayertech-leads --remote --file db/2026-10-23-custom-tables-seed.sql
-- The seed is separate because the code before this branch shows every
-- views row as a saved-view chip: seeded tables would appear as chips on
-- every tab, and deleting one would delete the table.
--
-- This file is safe for the old code: it only adds columns (with a default)
-- and fills in category, which the old code never reads.
--
-- Running it a second time stops at the first ALTER with "duplicate column
-- name" and changes nothing. If a run ever stops part-way with views.kind
-- added but leads.category missing, do not re-run the file: add the column
-- by hand (ALTER TABLE leads ADD COLUMN category TEXT;) and run this file's
-- statements from the CREATE INDEX lines on. Every statement after the two
-- ALTERs is safe to repeat: the indexes say IF NOT EXISTS and the backfill
-- only touches rows whose category is still NULL.
--
-- What it does:
--   1. views.kind: 'view' (a saved filter chip, which every existing row is)
--      or 'table' (a custom table shown as a tab). Existing saved views keep
--      working unchanged; the DEFAULT is the whole migration for them.
--   2. leads.category: 'tuning' | 'electronic' | 'pneumatic' | 'acoustic',
--      NULL when it cannot be told. New web leads get it from
--      functions/_lib/category.js. Existing leads are backfilled below,
--      conservatively: only from what the customer wrote or the page they
--      used, never from the Airtable Type alone ("Player Repair" covers both
--      electronic and pneumatic work). Anything unclear stays NULL, which
--      lands it in the Repair table where someone will read it.
--   (The three starting tables are in db/2026-10-23-custom-tables-seed.sql.)
--
-- Nothing here deletes or archives a lead, and nothing touches archived_at
-- or source, so the Airtable "never auto-purge" rule is unaffected.

ALTER TABLE views ADD COLUMN kind TEXT NOT NULL DEFAULT 'view';
ALTER TABLE leads ADD COLUMN category TEXT;

CREATE INDEX IF NOT EXISTS idx_views_kind ON views(kind, sort);
CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category);

-- ------------------------------------------------------------- backfill
-- 1. Tuning is tuning, except a teacher signing up as a referral partner.
UPDATE leads SET category = 'tuning'
 WHERE category IS NULL AND pipeline = 'tuning'
   AND COALESCE(service, '') NOT LIKE '%referral partner%';

-- 2. Pneumatic, from what the customer wrote, unless they also named an
--    electronic system (then it stays blank for a person to decide).
UPDATE leads SET category = 'pneumatic'
 WHERE id IN (
  SELECT id FROM (
    SELECT id, pipeline, LOWER(COALESCE(service, '')) AS svc, LOWER(COALESCE(source, '')) AS src,
           LOWER(COALESCE(service, '') || ' ' || COALESCE(system, '') || ' ' ||
                 COALESCE(message, '') || ' ' || COALESCE(fields, '')) AS t
      FROM leads WHERE category IS NULL)
   WHERE pipeline != 'tuning'
     AND (t LIKE '%pneumatic%' OR t LIKE '%ampico%' OR t LIKE '%duo-art%' OR t LIKE '%duo art%' OR t LIKE '%duoart%' OR t LIKE '%welte%' OR t LIKE '%paper roll%' OR t LIKE '%player roll%' OR
          t LIKE '%roll-operated%' OR t LIKE '%roll operated%' OR t LIKE '%reproducing grand%' OR t LIKE '%reproducing piano%' OR t LIKE '%reproducing player%' OR t LIKE '%pianola%' OR t LIKE '%foot pump%' OR
          t LIKE '%foot-pump%' OR t LIKE '%bellows%' OR t LIKE '%suction%' OR t LIKE '%tracker bar%' OR t LIKE '%trackerbar%' OR t LIKE '%nickelodeon%')
     AND NOT (t LIKE '%disklavier%' OR t LIKE '%enspire%' OR t LIKE '%pianodisc%' OR t LIKE '%piano disc%' OR t LIKE '%pianomation%' OR t LIKE '%spirio%' OR t LIKE '%solenoid%' OR t LIKE '%power supply%' OR
          t LIKE '%driver board%' OR t LIKE '%floppy%'));

-- 3. Pneumatic, from the antique player page, unless they named an
--    electronic system.
UPDATE leads SET category = 'pneumatic'
 WHERE id IN (
  SELECT id FROM (
    SELECT id, pipeline, LOWER(COALESCE(service, '')) AS svc, LOWER(COALESCE(source, '')) AS src,
           LOWER(COALESCE(service, '') || ' ' || COALESCE(system, '') || ' ' ||
                 COALESCE(message, '') || ' ' || COALESCE(fields, '')) AS t
      FROM leads WHERE category IS NULL)
   WHERE pipeline != 'tuning' AND (src LIKE '/antique-player-piano%')
     AND NOT (t LIKE '%disklavier%' OR t LIKE '%enspire%' OR t LIKE '%pianodisc%' OR t LIKE '%piano disc%' OR t LIKE '%pianomation%' OR t LIKE '%spirio%' OR t LIKE '%solenoid%' OR t LIKE '%power supply%' OR
          t LIKE '%driver board%' OR t LIKE '%floppy%'));

-- 4. Electronic, from what they wrote. A row still blank here that has a
--    pneumatic word named both kinds, and one from the antique page named
--    an electronic system there; both are left for a person.
UPDATE leads SET category = 'electronic'
 WHERE id IN (
  SELECT id FROM (
    SELECT id, pipeline, LOWER(COALESCE(service, '')) AS svc, LOWER(COALESCE(source, '')) AS src,
           LOWER(COALESCE(service, '') || ' ' || COALESCE(system, '') || ' ' ||
                 COALESCE(message, '') || ' ' || COALESCE(fields, '')) AS t
      FROM leads WHERE category IS NULL)
   WHERE pipeline != 'tuning' AND src NOT LIKE '/antique-player-piano%'
     AND (t LIKE '%disklavier%' OR t LIKE '%enspire%' OR t LIKE '%pianodisc%' OR t LIKE '%piano disc%' OR t LIKE '%pianomation%' OR t LIKE '%spirio%' OR t LIKE '%solenoid%' OR t LIKE '%power supply%' OR
          t LIKE '%driver board%' OR t LIKE '%floppy%' OR t LIKE '%qrs%' OR t LIKE '%player system%')
     AND NOT (t LIKE '%pneumatic%' OR t LIKE '%ampico%' OR t LIKE '%duo-art%' OR t LIKE '%duo art%' OR t LIKE '%duoart%' OR t LIKE '%welte%' OR t LIKE '%paper roll%' OR t LIKE '%player roll%' OR
          t LIKE '%roll-operated%' OR t LIKE '%roll operated%' OR t LIKE '%reproducing grand%' OR t LIKE '%reproducing piano%' OR t LIKE '%reproducing player%' OR t LIKE '%pianola%' OR t LIKE '%foot pump%' OR
          t LIKE '%foot-pump%' OR t LIKE '%bellows%' OR t LIKE '%suction%' OR t LIKE '%tracker bar%' OR t LIKE '%trackerbar%' OR t LIKE '%nickelodeon%'));

-- 5. Electronic, from a page about electronic player systems.
UPDATE leads SET category = 'electronic'
 WHERE id IN (
  SELECT id FROM (
    SELECT id, pipeline, LOWER(COALESCE(service, '')) AS svc, LOWER(COALESCE(source, '')) AS src,
           LOWER(COALESCE(service, '') || ' ' || COALESCE(system, '') || ' ' ||
                 COALESCE(message, '') || ' ' || COALESCE(fields, '')) AS t
      FROM leads WHERE category IS NULL)
   WHERE pipeline != 'tuning'
     AND (src LIKE '/disklavier-repair%' OR src LIKE '/disklavier-power-supply-repair%' OR src LIKE '/pianodisc-repair%' OR src LIKE '/qrs-repair%' OR src LIKE '/spirio-repair%' OR src LIKE '/player-repair%' OR
          src LIKE '/player-unit-mail-in-repair%' OR src LIKE '/for-technicians%')
     AND NOT (t LIKE '%pneumatic%' OR t LIKE '%ampico%' OR t LIKE '%duo-art%' OR t LIKE '%duo art%' OR t LIKE '%duoart%' OR t LIKE '%welte%' OR t LIKE '%paper roll%' OR t LIKE '%player roll%' OR
          t LIKE '%roll-operated%' OR t LIKE '%roll operated%' OR t LIKE '%reproducing grand%' OR t LIKE '%reproducing piano%' OR t LIKE '%reproducing player%' OR t LIKE '%pianola%' OR t LIKE '%foot pump%' OR
          t LIKE '%foot-pump%' OR t LIKE '%bellows%' OR t LIKE '%suction%' OR t LIKE '%tracker bar%' OR t LIKE '%trackerbar%' OR t LIKE '%nickelodeon%'));

-- 6. Ordinary piano repair and cleaning, by page or by the service the form sent.
UPDATE leads SET category = 'acoustic'
 WHERE id IN (
  SELECT id FROM (
    SELECT id, pipeline, LOWER(COALESCE(service, '')) AS svc, LOWER(COALESCE(source, '')) AS src,
           LOWER(COALESCE(service, '') || ' ' || COALESCE(system, '') || ' ' ||
                 COALESCE(message, '') || ' ' || COALESCE(fields, '')) AS t
      FROM leads WHERE category IS NULL)
   WHERE pipeline != 'tuning'
     AND (src LIKE '/piano-repair%' OR src LIKE '/piano-cleaning%' OR svc IN ('piano repair', 'piano detailing'))
     AND NOT (t LIKE '%pneumatic%' OR t LIKE '%ampico%' OR t LIKE '%duo-art%' OR t LIKE '%duo art%' OR t LIKE '%duoart%' OR t LIKE '%welte%' OR t LIKE '%paper roll%' OR t LIKE '%player roll%' OR
          t LIKE '%roll-operated%' OR t LIKE '%roll operated%' OR t LIKE '%reproducing grand%' OR t LIKE '%reproducing piano%' OR t LIKE '%reproducing player%' OR t LIKE '%pianola%' OR t LIKE '%foot pump%' OR
          t LIKE '%foot-pump%' OR t LIKE '%bellows%' OR t LIKE '%suction%' OR t LIKE '%tracker bar%' OR t LIKE '%trackerbar%' OR t LIKE '%nickelodeon%')
     AND NOT (t LIKE '%disklavier%' OR t LIKE '%enspire%' OR t LIKE '%pianodisc%' OR t LIKE '%piano disc%' OR t LIKE '%pianomation%' OR t LIKE '%spirio%' OR t LIKE '%solenoid%' OR t LIKE '%power supply%' OR
          t LIKE '%driver board%' OR t LIKE '%floppy%' OR t LIKE '%qrs%' OR t LIKE '%player system%'));
