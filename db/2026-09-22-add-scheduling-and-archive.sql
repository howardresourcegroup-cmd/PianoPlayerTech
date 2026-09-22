-- Adds scheduling and archiving to an existing database.
--
-- Additive only: every new column is nullable and nothing is dropped or
-- retyped, so the deployment currently running is unaffected until code
-- starts reading them.
--
-- STEP 1 -- the columns. SQLite has no ADD COLUMN IF NOT EXISTS, and
-- CREATE TABLE IF NOT EXISTS will not add columns to an existing table, so
-- these run individually. A "duplicate column name" error means that column
-- is already there: that is success, not failure.
--
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute pianoplayertech-leads \
--     --remote --command "ALTER TABLE leads ADD COLUMN scheduled_at TEXT"
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute pianoplayertech-leads \
--     --remote --command "ALTER TABLE leads ADD COLUMN scheduled_mins INTEGER"
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute pianoplayertech-leads \
--     --remote --command "ALTER TABLE leads ADD COLUMN archived_at TEXT"
--
-- The `env -u CLOUDFLARE_API_TOKEN` matters: that variable is set at the macOS
-- level via launchctl, it overrides the OAuth login, and it has no D1
-- permission. Without it every command above fails with
-- "Authentication error [code: 10000]".
--
-- STEP 2 -- the indexes and the settings table. Guarded, so safe to re-run:
--
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute pianoplayertech-leads \
--     --remote --file=db/2026-09-22-add-scheduling-and-archive.sql
--
-- STEP 3 -- confirm, before deploying any code that reads these columns:
--
--   env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute pianoplayertech-leads \
--     --remote --command "SELECT name FROM pragma_table_info('leads')"

CREATE INDEX IF NOT EXISTS idx_leads_scheduled ON leads(scheduled_at)
  WHERE scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(archived_at);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);
