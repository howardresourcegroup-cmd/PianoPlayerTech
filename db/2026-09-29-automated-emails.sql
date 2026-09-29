-- Automated emails: the queue and log, and the unsubscribe list.
--
-- Additive. Creates two tables and their indexes; alters and removes nothing.
-- Safe to run more than once.
--
--   wrangler d1 execute pianoplayertech-leads --remote --file db/2026-09-29-automated-emails.sql

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
