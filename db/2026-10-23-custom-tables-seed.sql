-- The three starting tables: Tuning, Repair and Pneumatic. Step 3 of 3:
-- run AFTER deploying the custom-tables code, and after
-- db/2026-10-23-custom-tables.sql (it needs views.kind):
--   npx wrangler d1 execute pianoplayertech-leads --remote --file db/2026-10-23-custom-tables-seed.sql
--
-- Safe to run again: it inserts only when there are no tables at all, so it
-- never brings back a table the owner deleted while others remain.
--
-- Same rows as the end of db/schema.sql. The config shape is the one
-- functions/_lib/tablefilter.js cleanTable() produces; tests/tables.test.mjs
-- checks these survive it unchanged.
INSERT INTO views (created_at, owner, name, config, sort, kind)
SELECT '2026-10-23T00:00:00.000Z', NULL, s.name, s.config, s.sort, 'table'
  FROM (
    SELECT 'Tuning' AS name, 10 AS sort,
           '{"rules":[{"field":"pipeline","op":"in","value":["tuning"]}],"columns":["phone","status","referral_status","scheduled_at","created_at","city","address","system","email","message","notes"],"sort":null,"color":"blue","icon":"♪"}' AS config
    UNION ALL
    SELECT 'Repair', 20,
           '{"rules":[{"field":"pipeline","op":"in","value":["repair"]},{"field":"category","op":"not_in","value":["pneumatic"]}],"columns":null,"sort":null,"color":"gold","icon":"⚙"}'
    UNION ALL
    SELECT 'Pneumatic', 30,
           '{"rules":[{"field":"category","op":"in","value":["pneumatic"]}],"columns":null,"sort":null,"color":"purple","icon":"✦"}'
  ) AS s
 WHERE NOT EXISTS (SELECT 1 FROM views WHERE kind = 'table');
