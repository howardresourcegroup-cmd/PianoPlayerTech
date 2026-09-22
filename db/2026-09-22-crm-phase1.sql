-- CRM phase 1: contacts, activities, payments, people, statuses, saved views.
--
-- Additive only. Nothing is dropped or retyped and `leads` keeps every column
-- it has, so the deployment currently running is unaffected until code reads
-- the new ones.
--
-- Apply the leads columns first (SQLite has no ADD COLUMN IF NOT EXISTS, so
-- each runs on its own and "duplicate column name" means already-applied):
--
--   for c in "contact_id INTEGER" "assigned_to TEXT" "person_id INTEGER" \
--            "partner_id INTEGER" "lead_source TEXT" "piano_make TEXT" \
--            "piano_model TEXT" "estimated_cents INTEGER" \
--            "quoted_cents INTEGER" "tech_pct INTEGER" "state TEXT" "zip TEXT"; do
--     env -u CLOUDFLARE_API_TOKEN wrangler d1 execute pianoplayertech-leads \
--       --remote --command "ALTER TABLE leads ADD COLUMN $c"
--   done
--
-- Then this file, which is guarded throughout and safe to re-run:
--
--   env -u CLOUDFLARE_API_TOKEN wrangler d1 execute pianoplayertech-leads \
--     --remote --file=db/2026-09-22-crm-phase1.sql

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
  ('new',         'New',                 10, 1, 0),
  ('contacted',   'Contacted',           20, 1, 0),
  ('waiting',     'Waiting on Customer', 30, 1, 0),
  ('quoted',      'Quote Sent',          40, 1, 0),
  ('referred',    'Referred',            50, 1, 0),
  ('scheduled',   'Scheduled',           60, 1, 0),
  ('booked',      'Booked',              70, 1, 0),
  ('completed',   'Completed',           80, 0, 1),
  ('invoiced',    'Invoice Sent',        90, 1, 1),
  ('paid',        'Paid',               100, 0, 1),
  ('closed',      'Closed',             110, 0, 0),
  ('lost',        'Lost',               120, 0, 0);

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

-- ------------------------------------------------------- indexes on leads
-- Guarded, so this file is safe to run before or after the ALTERs above --
-- but they do need the columns to exist, so run the ALTERs first.
CREATE INDEX IF NOT EXISTS idx_leads_contact  ON leads(contact_id)
  WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_partner  ON leads(partner_id)
  WHERE partner_id IS NOT NULL;
