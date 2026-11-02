-- Where a lead came from: the raw detail behind leads.lead_source.
--
-- Run once against production, BEFORE deploying the code:
--   npx wrangler d1 execute pianoplayertech-leads --remote --file db/2026-11-02-lead-attribution.sql
--
-- Safe for the old code, which never reads this column. New code on a database
-- without it still stores the lead and the lead_source label, and loses only
-- the detail. Running it a second time stops with "duplicate column name" and
-- changes nothing.

ALTER TABLE leads ADD COLUMN attribution TEXT;
