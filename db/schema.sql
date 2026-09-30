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
--
-- Added 2026-09-22, CRM phase 1 (see db/2026-09-22-crm-phase1.sql for the
-- full list and the runbook): contact_id, assigned_to, person_id, partner_id,
-- lead_source, piano_make, piano_model, estimated_cents, quoted_cents,
-- tech_pct, state, zip.

CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,              -- ISO-8601 UTC
  updated_at  TEXT,

  -- 'tuning' | 'repair'. The two buckets the business actually works from.
  pipeline    TEXT NOT NULL,

  -- A key from the statuses table. Drives the dashboard columns.
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

  -- CRM phase 1. contact_id is the person; partner_id means the work was done
  -- FOR a partner who pays us; person_id + tech_pct means a contractor we pay.
  contact_id     INTEGER,
  assigned_to    TEXT,     -- Access email of whoever owns this lead
  person_id      INTEGER,  -- contractor performing the work (we pay them)
  partner_id     INTEGER,  -- partner the work was done for (they pay us)
  lead_source    TEXT,
  piano_make     TEXT,
  piano_model    TEXT,
  estimated_cents INTEGER,
  quoted_cents   INTEGER,
  tech_pct       INTEGER,  -- contractor's cut, percent of the sale
  state          TEXT,
  zip            TEXT,
  -- 'homeowner' | 'business' | 'dealer'. NULL means nobody has said.
  customer_type  TEXT,

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


-- ---------------------------------------------------------------- contacts
-- A person. One per human, not one per enquiry: the whole point is that
-- someone who submits three forms over three years is one customer with a
-- history, not three unrelated rows.
CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT,
  name        TEXT,
  phone       TEXT,
  phone_norm  TEXT,           -- last 10 digits; what dedupe matches on
  email       TEXT,
  email_norm  TEXT,           -- lowercased and trimmed
  address     TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  preferred_contact TEXT,     -- 'phone' | 'email' | 'sms'
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_norm)
  WHERE phone_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email_norm)
  WHERE email_norm IS NOT NULL;

-- -------------------------------------------------------------- activities
-- Anything that happened, or is due to happen, on a lead. Status changes are
-- activities too: one timeline, rather than a second parallel history table
-- that can drift out of step with it.
CREATE TABLE IF NOT EXISTS activities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  lead_id      INTEGER,
  contact_id   INTEGER,
  type         TEXT NOT NULL,  -- call|email|sms|note|task|appointment|followup|status
  subject      TEXT,
  body         TEXT,
  due_at       TEXT,           -- set = it is a follow-up or an appointment
  completed_at TEXT,
  actor        TEXT,           -- the Access email that did it
  meta         TEXT            -- JSON; for status: {"from":"new","to":"contacted"}
);
CREATE INDEX IF NOT EXISTS idx_activities_lead
  ON activities(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_contact
  ON activities(contact_id, created_at DESC);
-- "What is overdue or coming up?" -- the query the dashboard leans on.
CREATE INDEX IF NOT EXISTS idx_activities_due ON activities(due_at)
  WHERE due_at IS NOT NULL AND completed_at IS NULL;

-- ---------------------------------------------------------------- payments
-- Money received. An invoice's balance and a lead's "amount paid" are derived
-- from these and never stored, so the balance cannot disagree with the
-- payment history.
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  invoice_id   INTEGER,
  contact_id   INTEGER,
  lead_id      INTEGER,
  person_id    INTEGER,        -- set when this is a partner paying us
  amount_cents INTEGER NOT NULL,
  method       TEXT,           -- 'stripe' | 'check' | 'cash' | 'other'
  paid_at      TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_lead    ON payments(lead_id);

-- ------------------------------------------------------------------ people
-- Whoever does work or trades work with this business.
--
-- Two directions, and they are not symmetrical:
--   partner    -- Piano Gallery, also called World Class. They pay us, both
--                 for referrals they book and for technician work we do for
--                 them, on one invoice a month.
--   contractor -- someone who performs a job and takes a percentage of it.
--                 We pay them.
-- Direction is a property of the job, not of the person: see leads.partner_id
-- (they pay us) versus leads.person_id + leads.tech_pct (we pay them).
CREATE TABLE IF NOT EXISTS people (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL,
  name          TEXT NOT NULL,
  aka           TEXT,          -- other names for the same company, comma-separated
  email         TEXT,
  phone         TEXT,
  kind          TEXT NOT NULL, -- 'contractor' | 'partner' | 'owner'
  default_pct   INTEGER,       -- a contractor's cut, percent of the sale
  bills_monthly INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT
);

-- ---------------------------------------------------------------- statuses
-- In a table rather than a constant, so they can be renamed and reordered
-- without a deploy. 'archived' is deliberately absent: archiving is
-- leads.archived_at, and a status of the same name would be a second source
-- of truth that can disagree with it.
CREATE TABLE IF NOT EXISTS statuses (
  key     TEXT PRIMARY KEY,
  label   TEXT NOT NULL,
  sort    INTEGER NOT NULL,
  is_open INTEGER NOT NULL DEFAULT 1,  -- counts as live work
  is_won  INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO statuses (key, label, sort, is_open, is_won) VALUES
  ('new',            'New',                  10, 1, 0),
  ('needs_contact',  'Needs Contact',        15, 1, 0),  -- you owe them a call
  ('waiting',        'Waiting on Customer',  30, 1, 0),  -- they owe you a reply
  ('diag_scheduled', 'Diagnostic Scheduled', 35, 1, 0),
  ('diagnosis',      'Diagnosis',            38, 1, 0),  -- looked at; quote being worked out
  ('quoted',         'Quote Sent',           40, 1, 0),
  ('referred',       'Referred',             50, 1, 0),
  ('booked',         'Booked',               70, 1, 0),  -- repair approved and on the calendar
  ('in_repair',      'In Repair',            75, 1, 1),
  ('completed',      'Completed',            80, 0, 1),
  ('invoiced',       'Invoice Sent',         90, 1, 1),
  ('paid',           'Paid',                100, 0, 1),
  ('closed',         'Closed',              110, 0, 0),
  ('lost',           'Lost',                120, 0, 0);

-- ------------------------------------------------------------------- views
-- A saved view: filters, sort order and visible columns. owner NULL means
-- everyone sees it.
CREATE TABLE IF NOT EXISTS views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  owner      TEXT,
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,   -- JSON {filters, sort, columns}
  sort       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_leads_contact  ON leads(contact_id)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_partner  ON leads(partner_id)
  WHERE partner_id IS NOT NULL;

-- ------------------------------------------------------- automated emails
-- One row per email the system drafted, whatever became of it. The unique
-- index is what makes "nobody gets the same email twice" a fact about the
-- database rather than a hope about the code.
CREATE TABLE IF NOT EXISTS outreach (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  lead_id     INTEGER NOT NULL,
  contact_id  INTEGER,
  kind        TEXT NOT NULL,             -- quote_checkin | review_request | tuning_reminder
  cycle       TEXT NOT NULL DEFAULT '',  -- '' once-only; '1', '2'... for a yearly reminder
  email       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL,             -- draft | sent | skipped | failed
  decided_at  TEXT,
  decided_by  TEXT,
  error       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_once ON outreach(lead_id, kind, cycle);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach(status, created_at);

-- Keyed by address, not by contact: a person who opts out must stay opted
-- out across every lead they ever send, including ones not yet linked.
CREATE TABLE IF NOT EXISTS unsubscribes (
  email_norm  TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  source      TEXT
);
