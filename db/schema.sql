-- PianoPlayerTech lead store (Cloudflare D1).
--
-- Replaces the Airtable base. One row per form submission, split into two
-- pipelines so tuning referrals never bury a $1,500 repair job.
--
-- Apply with:
--   npx wrangler d1 execute pianoplayertech-leads --remote --file=db/schema.sql

CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,              -- ISO-8601 UTC
  updated_at  TEXT,

  -- 'tuning' | 'repair'. The two buckets the business actually works from.
  pipeline    TEXT NOT NULL,

  -- 'new' | 'called' | 'booked' | 'closed'. Drives the dashboard columns.
  status      TEXT NOT NULL DEFAULT 'new',

  name        TEXT,
  email       TEXT,
  phone       TEXT,

  -- Specific service label, e.g. "Piano Tuning", "Power Supply Rebuild".
  service     TEXT,
  -- Player system or piano make/model, e.g. "Disklavier DKC-850".
  system      TEXT,
  city        TEXT,
  -- What the customer typed: issue / notes / message / quiz summary.
  message     TEXT,

  -- Page path + form id, so we know which page earns leads.
  source      TEXT,
  -- Every submitted field as JSON. Nothing a form collects is ever lost,
  -- even if this schema does not have a column for it.
  fields      TEXT,

  -- Internal only. Never shown to the customer.
  notes       TEXT
);

-- The dashboard's main query: one pipeline, newest first.
CREATE INDEX IF NOT EXISTS idx_leads_pipeline_created ON leads(pipeline, created_at DESC);

-- "What haven't I called back yet?" — the query that protects the
-- 30-to-60-minute callback promise.
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, created_at DESC);
