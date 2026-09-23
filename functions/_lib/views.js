// Saved views: a filter you use often, given a name.
//
// The config is JSON written by the client, which makes it the one place in
// this application where the browser hands over a structure rather than a
// scalar. So it is rebuilt field by field on the way in rather than stored
// as sent: an unknown key is dropped, every value is checked, and what comes
// back out is known to be the shape the client expects. A saved view that
// could carry arbitrary JSON would be a stored payload waiting for the first
// place someone renders it carelessly.

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
    tab: /^[a-z]{1,20}$/.test(String(c.tab || '')) ? String(c.tab) : ''
  };
}

export async function listViews(env) {
  try {
    const r = await env.DB.prepare(
      'SELECT id, created_at, owner, name, config, sort FROM views ORDER BY sort, id').all();
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

export async function saveView(env, { id, name, config, owner }, now) {
  const clean = cleanConfig(config);
  const label = str(name, VIEW_LIMITS.name);
  if (!label) return { error: 'Give the view a name.' };

  if (id != null) {
    const n = parseInt(id, 10);
    if (!Number.isInteger(n)) return { error: 'bad id' };
    const row = await env.DB.prepare(
      `UPDATE views SET name = ?, config = ? WHERE id = ? RETURNING id, name, config, owner, sort`)
      .bind(label, JSON.stringify(clean), n).first();
    if (!row) return { error: 'That view no longer exists.' };
    return { view: { id: row.id, name: row.name, owner: row.owner, sort: row.sort, config: clean } };
  }

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM views').first();
  if (count && count.n >= VIEW_LIMITS.perOwner) {
    return { error: `That is ${VIEW_LIMITS.perOwner} saved views already. Delete one first.` };
  }

  const row = await env.DB.prepare(
    `INSERT INTO views (created_at, owner, name, config, sort)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM views))
     RETURNING id, name, config, owner, sort`)
    .bind(now, str(owner, 200) || null, label, JSON.stringify(clean)).first();
  if (!row) return { error: 'Could not save that view.' };
  return { view: { id: row.id, name: row.name, owner: row.owner, sort: row.sort, config: clean } };
}

export async function deleteView(env, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return { error: 'bad id' };
  const r = await env.DB.prepare('DELETE FROM views WHERE id = ?').bind(n).run();
  return (r.meta && r.meta.changes) ? { deleted: n } : { error: 'That view is already gone.' };
}
