// Doing one thing to many leads.
//
// The danger here is not the SQL, it is the blast radius. A single-lead
// mistake is a click to undo; a bulk mistake is thirty rows changed at once
// and no memory of what they were. So:
//
//   - every id is checked, and a request with one bad id is refused whole
//     rather than half-applied;
//   - there is a hard cap, because nothing legitimate needs to change five
//     thousand leads in one request;
//   - archived leads are skipped for mutations, the same rule the
//     single-lead path enforces, so a stale tab cannot revive them;
//   - every change is logged per lead, so the record view can show what
//     happened and to what.
//
// The reply says how many actually changed, which is not always how many
// were asked for.

import { logQuietly } from './activity.js';

// High enough for "select all on this page", low enough that a runaway
// client cannot rewrite the table.
export const BULK_MAX = 500;

export const BULK_OPS = ['status', 'pipeline', 'archive', 'restore'];

/**
 * Parse and validate the id list.
 * @returns {ids} or {error}
 */
export function parseIds(raw) {
  if (!Array.isArray(raw)) return { error: 'Nothing selected.' };
  const ids = [];
  for (const v of raw) {
    const n = typeof v === 'number' ? v : parseInt(v, 10);
    // A bad id means the client and the server disagree about what is
    // selected. Guessing which rows were meant is worse than refusing.
    if (!Number.isInteger(n) || n <= 0) return { error: 'That selection is not valid — reload and try again.' };
    ids.push(n);
  }
  const unique = [...new Set(ids)];
  if (!unique.length) return { error: 'Nothing selected.' };
  if (unique.length > BULK_MAX) {
    return { error: `That is ${unique.length} leads at once. ${BULK_MAX} is the most this will do in one go.` };
  }
  return { ids: unique };
}

const holes = (n) => new Array(n).fill('?').join(',');

/**
 * Apply one operation to many leads.
 *
 * @param opts.op     one of BULK_OPS
 * @param opts.value  for status and pipeline
 * @param opts.actor  who did it
 * @returns {changed, skipped, value}
 */
export async function applyBulk(env, ids, opts, now) {
  const { op, value, actor } = opts;

  // Which of these actually exist, and which are archived. Doing this first
  // means the reply can distinguish "changed 8" from "asked for 10".
  const found = (await env.DB.prepare(
    `SELECT id, status, pipeline, contact_id, archived_at
       FROM leads WHERE id IN (${holes(ids.length)})`).bind(...ids).all()).results || [];

  const live = op === 'restore'
    ? found.filter((r) => r.archived_at)
    : found.filter((r) => !r.archived_at);
  if (!live.length) return { changed: 0, skipped: ids.length, value: null };

  const targets = live.map((r) => r.id);
  let sql;
  let binds;
  let stamp = null;

  if (op === 'archive') {
    stamp = now;
    sql = `UPDATE leads SET archived_at = ?, updated_at = ? WHERE id IN (${holes(targets.length)})`;
    binds = [now, now, ...targets];
  } else if (op === 'restore') {
    sql = `UPDATE leads SET archived_at = NULL, updated_at = ? WHERE id IN (${holes(targets.length)})`;
    binds = [now, ...targets];
  } else {
    // op is 'status' or 'pipeline', both checked by the caller against their
    // own vocabularies before we get here.
    sql = `UPDATE leads SET ${op} = ?, updated_at = ? WHERE id IN (${holes(targets.length)})`;
    binds = [value, now, ...targets];
  }

  const res = await env.DB.prepare(sql).bind(...binds).run();
  const changed = (res.meta && typeof res.meta.changes === 'number') ? res.meta.changes : targets.length;

  // One line of history per lead, so a bulk change is not an unexplained
  // jump in the record view. Best-effort, like every other automatic log.
  for (const r of live) {
    const subject = op === 'archive' ? 'Archived'
      : op === 'restore' ? 'Restored from archive'
      : `${op === 'status' ? 'Status' : 'Pipeline'} → ${value}`;
    const meta = op === 'archive' ? { archived: true, bulk: true }
      : op === 'restore' ? { archived: false, bulk: true }
      : { field: op, from: r[op], to: value, bulk: true };
    await logQuietly(env, {
      lead_id: r.id, contact_id: r.contact_id, type: 'status',
      subject, actor, meta
    }, now);
  }

  return { changed, skipped: ids.length - live.length, value: stamp };
}
