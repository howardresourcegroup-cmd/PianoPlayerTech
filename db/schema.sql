-- PianoPlayerTech lead store (Cloudflare D1).
--
-- Replaces the Airtable base. One row per form submission, split into two
-- pipelines so tuning referrals never bury a $1,500 repair job.
--
-- Apply with:
--   npx wrangler d1 execute pianoplayertech-leads --remote --file=db/schema.sql
--
-- Upgrading a database created before 2026-09-18 (the live one already has
-- these; CREATE TABLE IF NOT EXISTS will not add columns to an old table):
--   ALTER TABLE leads ADD COLUMN address TEXT;
--   ALTER TABLE leads ADD COLUMN referred_at TEXT;
--   ALTER TABLE leads ADD COLUMN referral_status TEXT;
--   ALTER TABLE leads ADD COLUMN referral_paid_at TEXT;
--   ALTER TABLE leads ADD COLUMN referral_invoice_id INTEGER;
--
-- Added 2026-09-22 (see db/2026-09-22-add-scheduling-and-archive.sql):
--   ALTER TABLE leads ADD COLUMN scheduled_at TEXT;
--   ALTER TABLE leads ADD COLUMN scheduled_mins INTEGER;
--   ALTER TABLE leads ADD COLUMN archived_at TEXT;

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
  -- Where the piano is. World Class needs it to take a referral.
  address     TEXT,
  -- What the customer typed: issue / notes / message / quiz summary.
  message     TEXT,

  -- Page path + form id, so we know which page earns leads.
  source      TEXT,
  -- Every submitted field as JSON. Nothing a form collects is ever lost,
  -- even if this schema does not have a column for it.
  fields      TEXT,

  -- Internal only. Never shown to the customer.
  notes       TEXT,

  -- When the job is booked for, and how long it runs. Feeds the calendar.
  scheduled_at   TEXT,     -- ISO-8601 UTC
  scheduled_mins INTEGER,  -- NULL means the 90-minute default

  -- Set = archived: hidden from every working view, purged after 30 days.
  archived_at    TEXT,

  -- World Class referral tracking. We earn a fee only on referrals they
  -- actually book, so "sent" and "booked" are tracked separately.
  referred_at       TEXT,  -- when we handed it to World Class
  referral_status   TEXT,  -- 'sent' | 'booked' | 'no_booking'
  referral_paid_at  TEXT,  -- when World Class paid us for it
  referral_invoice_id INTEGER  -- invoices.id that billed it; stops double billing
);

-- The dashboard's main query: one pipeline, newest first.
CREATE INDEX IF NOT EXISTS idx_leads_pipeline_created ON leads(pipeline, created_at DESC);

-- The Referrals tab: everything handed to World Class, newest first.
CREATE INDEX IF NOT EXISTS idx_leads_referred ON leads(referred_at);

-- Upcoming work, for the calendar feed and the schedule view.
CREATE INDEX IF NOT EXISTS idx_leads_scheduled ON leads(scheduled_at)
  WHERE scheduled_at IS NOT NULL;

-- The Archive tab, and the purge that sweeps it.
CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(archived_at);

-- Small key/value store. Holds the calendar feed token, so it can be rotated
-- from the dashboard without a redeploy.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);

-- "What haven't I called back yet?" — the query that protects the
-- 30-to-60-minute callback promise.
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, created_at DESC);

-- Stripe invoices sent from the dashboard: the monthly World Class referral
-- bill ('referral') and one-off invoices to anyone ('custom'). Stripe is the
-- source of truth for payment; this mirrors it so the dashboard can list and
-- total invoices without calling Stripe for every row.
CREATE TABLE IF NOT EXISTS invoices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- 'referral' | 'custom'
  lead_id      INTEGER,              -- set when invoiced from a lead
  bill_to      TEXT,
  email        TEXT,
  description  TEXT,                 -- memo shown on the invoice
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL,        -- creating | open | paid | void | uncollectible
  stripe_id    TEXT,
  number       TEXT,                 -- Stripe's invoice number
  hosted_url   TEXT,                 -- the customer's pay page
  due_date     TEXT,
  paid_at      TEXT,
  lines        TEXT                  -- JSON [{description, cents}]
);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
