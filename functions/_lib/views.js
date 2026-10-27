// Saved views: a filter you use often, given a name.
//
// The config is JSON written by the client, which makes it the one place in
// this application where the browser hands over a structure rather than a
// scalar. So it is rebuilt field by field on the way in rather than stored
// as sent: an unknown key is dropped, every value is checked, and what comes
// back out is known to be the shape the client expects. A saved view that
// could carry arbitrary JSON would be a stored payload waiting for the first
// place someone renders it carelessly.

import { cleanTable, FilterError, LIMITS as TABLE_LIMITS } from './tablefilter.js';

export const VIEW_LIMITS = { name: 60, query: 400, perOwner: 40 };

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * Rebuild a config from whatever the client sent.
 * Unknown keys are dropped; bad values fall back to a sane default.
 */
export function cleanConfig(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const size = parseInt(c.pageSize, 10);
  const dir = parseInt(c.sortDir, 10);
  return {
    // The search box, in the grammar the parser already validates: anything
    // it cannot make sense of simply matches nothing.
    q: str(c.q, VIEW_LIMITS.query),
    // The status dropdown's value.
    sf: str(c.sf, 60),
    // Which column, if any. A column name is a short identifier or nothing.
    sortKey: /^[a-z_]{1,40}$/i.test(String(c.sortKey || '')) ? String(c.sortKey) : null,
    sortDir: dir === -1 ? -1 : 1,
    pageSize: [0, 50, 100, 250].includes(size) ? size : 100,
    // Which tab it belongs to, so a Referrals view does not appear on Repair.
    // A custom table's saved views use 't' + its id, hence the digits.
    tab: /^[a-z][a-z0-9]{0,19}$/.test(String(c.tab || '')) ? String(c.tab) : ''
  };
}

// The views table holds two kinds of row since 2026-10-23: 'view', a saved
// filter chip on one tab (every row written before then), and 'table', a
// custom table shown as its own tab (further down; its filter is checked
// and compiled by ./tablefilter.js). Every query
// here names its kind, so a chip can never be edited or deleted as a table
// or the other way round.
export async function listViews(env) {
  try {
    let r;
    try {
      r = await env.DB.prepare(
        "SELECT id, created_at, owner, name, config, sort FROM views WHERE kind = 'view' ORDER BY sort, id").all();
    } catch (err) {
      // Deployed before db/2026-10-23-custom-tables.sql ran: no kind column
      // yet, and every row is a saved view.
      if (!/no such column/i.test(String(err && err.message))) throw err;
      r = await env.DB.prepare(
        'SELECT id, created_at, owner, name, config, sort FROM views ORDER BY sort, id').all();
    }
    return (r.results || []).map((v) => {
      let config;
      // A row written by an older version, or by hand, must not break the
      // dashboard. A view that cannot be parsed is simply an empty one.
      try { config = cleanConfig(JSON.parse(v.config)); } catch { config = cleanConfig(null); }
      return { id: v.id, name: v.name, owner: v.owner, sort: v.sort, config };
    });
  } catch (err) {
    console.error('saved views unavailable', err && err.message);
    return [];
  }
}

// Before db/2026-10-23-custom-tables.sql there is no kind column, and every
// row is a saved view. These run a statement and, only on that error, the
// same statement as it was written before tables existed.
const noKind = (err) => /no such column|has no column/i.test(String(err && err.message));
async function withKind(withIt, without) {
  try { return await withIt(); } catch (err) { if (!noKind(err)) throw err; return without(); }
}

export async function saveView(env, { id, name, config, owner }, now) {
  const clean = cleanConfig(config);
  const label = str(name, VIEW_LIMITS.name);
  if (!label) return { error: 'Give the view a name.' };

  if (id != null) {
    const n = parseInt(id, 10);
    if (!Number.isInteger(n)) return { error: 'bad id' };
    const row = await withKind(
      () => env.DB.prepare(
        `UPDATE views SET name = ?, config = ? WHERE id = ? AND kind = 'view' RETURNING id, name, config, owner, sort`)
        .bind(label, JSON.stringify(clean), n).first(),
      () => env.DB.prepare(
        'UPDATE views SET name = ?, config = ? WHERE id = ? RETURNING id, name, config, owner, sort')
        .bind(label, JSON.stringify(clean), n).first());
    if (!row) return { error: 'That view no longer exists.' };
    return { view: { id: row.id, name: row.name, owner: row.owner, sort: row.sort, config: clean } };
  }

  const count = await withKind(
    () => env.DB.prepare("SELECT COUNT(*) AS n FROM views WHERE kind = 'view'").first(),
    () => env.DB.prepare('SELECT COUNT(*) AS n FROM views').first());
  if (count && count.n >= VIEW_LIMITS.perOwner) {
    return { error: `That is ${VIEW_LIMITS.perOwner} saved views already. Delete one first.` };
  }

  const row = await withKind(
    () => env.DB.prepare(
      `INSERT INTO views (created_at, owner, name, config, sort, kind)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM views WHERE kind = 'view'), 'view')
       RETURNING id, name, config, owner, sort`)
      .bind(now, str(owner, 200) || null, label, JSON.stringify(clean)).first(),
    () => env.DB.prepare(
      `INSERT INTO views (created_at, owner, name, config, sort)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM views))
       RETURNING id, name, config, owner, sort`)
      .bind(now, str(owner, 200) || null, label, JSON.stringify(clean)).first());
  if (!row) return { error: 'Could not save that view.' };
  return { view: { id: row.id, name: row.name, owner: row.owner, sort: row.sort, config: clean } };
}

export async function deleteView(env, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return { error: 'bad id' };
  const r = await withKind(
    () => env.DB.prepare("DELETE FROM views WHERE id = ? AND kind = 'view'").bind(n).run(),
    () => env.DB.prepare('DELETE FROM views WHERE id = ?').bind(n).run());
  return (r.meta && r.meta.changes) ? { deleted: n } : { error: 'That view is already gone.' };
}

// ------------------------------------------------------------ custom tables
//
// A table is a view promoted to a tab: a name, a filter over any lead field,
// the columns and sort to show it with, and a colour or icon for the tab.
// It lives in the same views table with kind = 'table', and `sort` is its
// place in the tab strip. Everything that arrives from the browser goes
// through cleanTable, which refuses (rather than drops) anything unknown.

export { TABLE_LIMITS };

function tableRow(v) {
  let config;
  let broken = '';
  try {
    // Re-checked on the way out too: a row edited by hand, or written by a
    // later version, must not reach the SQL builder unchecked.
    config = cleanTable({ name: v.name || 'Untitled', config: JSON.parse(v.config) }).config;
  } catch (err) {
    broken = err instanceof FilterError ? err.message : 'The saved filter could not be read.';
    config = { rules: [], columns: null, sort: null, color: '', icon: '' };
  }
  return { id: v.id, name: v.name, sort: v.sort, config, broken };
}

export async function listTables(env) {
  try {
    const r = await env.DB.prepare(
      "SELECT id, name, config, sort FROM views WHERE kind = 'table' ORDER BY sort, id").all();
    return (r.results || []).map(tableRow);
  } catch (err) {
    // Before the migration there are no tables, and the dashboard must still
    // load. That is expected, so it is not logged on every page view.
    if (!noKind(err)) console.error('custom tables unavailable', err && err.message);
    return [];
  }
}

export async function getTable(env, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== String(id).trim()) return null;
  try {
    const v = await env.DB.prepare(
      "SELECT id, name, config, sort FROM views WHERE id = ? AND kind = 'table'").bind(n).first();
    return v ? tableRow(v) : null;
  } catch (err) {
    console.error('custom table unavailable', err && err.message);
    return null;
  }
}

// Create when there is no id, otherwise replace. Returns { table } or
// { error } -- an error here is always the person's to fix, so a 400.
export async function saveTable(env, body, owner, now, statusKeys) {
  let clean;
  try {
    clean = cleanTable({ name: body.name, config: body.config }, statusKeys);
  } catch (err) {
    if (err instanceof FilterError) return { error: err.message };
    throw err;
  }
  const json = JSON.stringify(clean.config);

  if (body.tableId != null && body.tableId !== '') {
    const n = parseInt(body.tableId, 10);
    if (!Number.isInteger(n)) return { error: 'bad id' };
    const row = await env.DB.prepare(
      `UPDATE views SET name = ?, config = ? WHERE id = ? AND kind = 'table'
       RETURNING id, name, config, sort`).bind(clean.name, json, n).first();
    if (!row) return { error: 'That table no longer exists.' };
    return { table: tableRow(row) };
  }

  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM views WHERE kind = 'table'").first();
  if (count && count.n >= TABLE_LIMITS.tables) {
    return { error: `That is ${TABLE_LIMITS.tables} tables already. Delete one first.` };
  }
  const row = await env.DB.prepare(
    `INSERT INTO views (created_at, owner, name, config, sort, kind)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM views WHERE kind = 'table'), 'table')
     RETURNING id, name, config, sort`)
    .bind(now, str(owner, 200) || null, clean.name, json).first();
  if (!row) return { error: 'Could not save that table.' };
  return { table: tableRow(row) };
}

export async function duplicateTable(env, id, owner, now) {
  const t = await getTable(env, id);
  if (!t) return { error: 'That table no longer exists.' };
  const name = (`Copy of ${t.name}`).slice(0, TABLE_LIMITS.name);
  return saveTable(env, { name, config: t.config }, owner, now);
}

export async function deleteTable(env, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return { error: 'bad id' };
  const r = await env.DB.prepare("DELETE FROM views WHERE id = ? AND kind = 'table'").bind(n).run();
  return (r.meta && r.meta.changes) ? { deleted: n } : { error: 'That table is already gone.' };
}

// The tab order, as the full list of table ids in their new order. Every
// table must be named exactly once: a partial list from a stale page would
// otherwise leave two tables sharing a place.
export async function orderTables(env, ids) {
  if (!Array.isArray(ids) || ids.length > TABLE_LIMITS.tables) return { error: 'bad order' };
  const want = ids.map((x) => parseInt(x, 10));
  if (want.some((n) => !Number.isInteger(n)) || new Set(want).size !== want.length) return { error: 'bad order' };
  const have = ((await env.DB.prepare("SELECT id FROM views WHERE kind = 'table'").all()).results || [])
    .map((r) => r.id);
  if (have.length !== want.length || !have.every((id) => want.includes(id))) {
    return { error: 'The tables changed since this page loaded. Reload and try again.' };
  }
  // One transaction: the strip is either in the old order or the new one.
  await env.DB.batch(want.map((id, i) =>
    env.DB.prepare("UPDATE views SET sort = ? WHERE id = ? AND kind = 'table'").bind((i + 1) * 10, id)));
  return { order: want };
}
