-- Users and roles: who may open the CRM, and what each of them may do.
--
-- Run once against production (safe to run again: it only creates):
--   env -u CLOUDFLARE_API_TOKEN wrangler d1 execute pianoplayertech-leads --remote \
--     --file db/2026-10-18-users.sql
--
-- This is NOT the people table. people is contractors and partners, the
-- businesses we pay or that pay us. users is who signs in to the dashboard.
--
-- Nobody is locked out by applying this. Every address in ACCESS_EMAILS is
-- an active owner whether or not it has a row here, and the ADMIN_PASSWORD
-- session acts as owner. See docs/users-and-roles.md.

CREATE TABLE IF NOT EXISTS users (
  -- The address Cloudflare Access proves, trimmed and lowercased. The CHECK
  -- is what stops 'Pat@x.com' and 'pat@x.com' becoming two accounts.
  email        TEXT PRIMARY KEY CHECK (email = lower(trim(email)) AND email LIKE '%_@_%'),
  name         TEXT NOT NULL DEFAULT '',
  -- See functions/_lib/roles.js for exactly what each one may do.
  role         TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'tech', 'viewer')),
  -- 0 = deactivated: refused on their next request. Rows are never deleted,
  -- so the activity log's actor column always names someone on this list.
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  -- Who added them: an email, or 'admin' for the password session.
  created_by   TEXT
);
