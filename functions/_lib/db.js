// Shared data rules: constants and query fragments that more than one module
// needs. Kept out of grid.js so the server does not depend on the client
// application to know what a referral is worth.

// World Class pays per referral they actually book — not per referral sent.
export const REFERRAL_FEE = 25;

// One spelling of "not archived", so a new query cannot quietly omit it.
// Archived leads are invisible to every working view, every count, every stat
// and the CSV export. Only a lookup by explicit id may see one, so archive
// and restore can work at all.
export const NOT_ARCHIVED = 'archived_at IS NULL';

// Pages Functions have no cron triggers -- Cloudflare's Pages-to-Workers
// migration guide lists Cron Triggers among the features Workers has and
// Pages lacks. So the purge cannot be a scheduled job. It runs when the
// dashboard is opened, inside waitUntil, off the response path.
//
// Consequence: if nobody opens the CRM for 45 days, records purge on the next
// open. Thirty days is a floor on retention, not a ceiling, and the Archive
// tab says "about" for that reason.
export const PURGE_DAYS = 30;

// ISO-8601 UTC strings sort lexicographically, which is why this compares
// strings rather than calling SQLite's datetime(): mixing the two silently
// mishandles the Z suffix.
export function purgeCutoff(now) {
  return new Date(now.getTime() - PURGE_DAYS * 86400000).toISOString();
}

export async function purgeExpired(env, cutoff) {
  const r = await env.DB.prepare(
    'DELETE FROM leads WHERE archived_at IS NOT NULL AND archived_at < ?'
  ).bind(cutoff).run();
  return (r.meta && r.meta.changes) || 0;
}

// The status vocabulary lives in the database so it can change without a
// deploy. The hardcoded list stays as a fallback: a database that has not
// had db/schema.sql applied yet must still show a working dashboard rather
// than an empty Status dropdown.
export const FALLBACK_STATUSES = [
  { key: 'new', label: 'New', sort: 10, is_open: 1, is_won: 0 },
  { key: 'contacted', label: 'Contacted', sort: 20, is_open: 1, is_won: 0 },
  { key: 'referred', label: 'Referred', sort: 50, is_open: 1, is_won: 0 },
  { key: 'booked', label: 'Booked', sort: 70, is_open: 1, is_won: 0 },
  { key: 'closed', label: 'Closed', sort: 110, is_open: 0, is_won: 0 }
];

export async function loadStatuses(env) {
  try {
    const r = await env.DB.prepare(
      'SELECT key, label, sort, is_open, is_won FROM statuses ORDER BY sort, key').all();
    const rows = r.results || [];
    return rows.length ? rows : FALLBACK_STATUSES;
  } catch (err) {
    console.error('status vocabulary unavailable, using the fallback', err && err.message);
    return FALLBACK_STATUSES;
  }
}
