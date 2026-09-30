// A lead the owner types in, rather than one a web form sent.
//
// A phone call or a walk-in has no form behind it. This is the one door for
// those. It stores what was typed under the same caps as editing, marks the
// row as hand-entered so it is never mistaken for a web lead, and leaves a
// line in the history saying who added it.

import { logQuietly } from './activity.js';

export const PIPELINES = ['repair', 'tuning'];
export const CAME_IN_BY = ['phone', 'text', 'email', 'in_person', 'other'];

// Same limits as the dashboard's edit path in functions/leads.js.
const CAPS = {
  name: 200, phone: 50, email: 200, address: 300, city: 100,
  system: 200, service: 200, message: 4000, notes: 4000
};

const clean = (v, cap) => {
  const s = String(v == null ? '' : v).trim().slice(0, cap);
  return s || null;
};

// Returns { ok, lead } or { error, status }.
export async function createLead(env, body, actor, nowIso) {
  const b = body || {};
  if (!PIPELINES.includes(b.pipeline)) return { error: 'bad pipeline', status: 400 };

  const lead = {};
  for (const k of Object.keys(CAPS)) lead[k] = clean(b[k], CAPS[k]);
  if (!lead.name && !lead.phone && !lead.email) {
    return { error: 'Give at least a name, phone or email so they can be reached.', status: 400 };
  }
  const cameInBy = CAME_IN_BY.includes(b.came_in_by) ? b.came_in_by : null;

  // Everything typed, so nothing is lost even if a column is dropped later.
  const fields = {};
  for (const k of Object.keys(lead)) if (lead[k] != null) fields[k] = lead[k];
  if (cameInBy) fields.came_in_by = cameInBy;

  const res = await env.DB.prepare(
    `INSERT INTO leads
       (created_at, updated_at, pipeline, status, name, email, phone, service, system, city, address,
        message, notes, source, lead_source, fields)
     VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dashboard', ?, ?)`
  ).bind(
    nowIso, nowIso, b.pipeline, lead.name, lead.email, lead.phone, lead.service, lead.system,
    lead.city, lead.address, lead.message, lead.notes, cameInBy, JSON.stringify(fields)
  ).run();
  const id = res.meta && res.meta.last_row_id;
  const row = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first();

  await logQuietly(env, {
    lead_id: row.id, contact_id: null, type: 'status', actor,
    subject: 'Added by hand' + (cameInBy ? ' (' + cameInBy.replace('_', ' ') + ')' : ''),
    meta: { field: 'status', to: 'new', created: true }
  }, nowIso);

  return { ok: true, lead: row };
}
