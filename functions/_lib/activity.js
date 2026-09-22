// The history of a lead: notes, calls, follow-ups, and the trail the CRM
// writes for itself when a status changes or a referral goes out.
//
// Two rules shape this file.
//
// Logging must never break the thing it is logging. A status change that
// saved is saved; if writing its activity row fails, that is worth a line in
// the Worker log, not a 500 the operator has to interpret. Every automatic
// log call is therefore best-effort.
//
// History is per person, not per form submission. A customer who fills in
// the form three times is one contact with three leads, so the record view
// asks for activities on this lead OR on its contact. That is why
// contact_id is stamped on every row at write time rather than joined later.

// Everything the column accepts.
export const ACTIVITY_TYPES = [
  'call', 'email', 'sms', 'note', 'task', 'appointment', 'followup', 'status'
];

// What a person may create from the record view. 'status' is excluded on
// purpose: it is written by the status change itself, and a hand-written one
// would claim a change that never happened.
export const LOGGABLE_TYPES = ['call', 'email', 'sms', 'note', 'task', 'followup', 'appointment'];

// A follow-up or appointment is the same row with a due date.
export const SCHEDULED_TYPES = ['task', 'followup', 'appointment'];

export const LIMITS = { subject: 200, body: 4000 };

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// An ISO-8601 instant, or ''. Anything the browser sends that is not a real
// date is dropped rather than stored as a string no query can compare.
export function normStamp(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * Write one activity row.
 *
 * @returns the inserted row, or null if the insert failed.
 */
export async function logActivity(env, a, now) {
  const type = ACTIVITY_TYPES.includes(a.type) ? a.type : 'note';
  const due = normStamp(a.due_at);
  const res = await env.DB.prepare(
    `INSERT INTO activities
       (created_at, lead_id, contact_id, type, subject, body, due_at, completed_at, actor, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`)
    .bind(
      now,
      a.lead_id == null ? null : a.lead_id,
      a.contact_id == null ? null : a.contact_id,
      type,
      clip(a.subject, LIMITS.subject) || null,
      clip(a.body, LIMITS.body) || null,
      due || null,
      a.completed_at || null,
      clip(a.actor, 200) || null,
      a.meta ? JSON.stringify(a.meta) : null
    )
    .first();
  return res || null;
}

// Best-effort: used where the activity is a side effect of a write that has
// already happened and must not be undone by a logging failure.
export async function logQuietly(env, a, now) {
  try {
    return await logActivity(env, a, now);
  } catch (err) {
    console.error('activity log failed', a && a.type, err && err.message);
    return null;
  }
}

// The contact a lead belongs to, so automatic logs carry it without the
// caller having to look it up.
export async function contactIdFor(env, leadId) {
  const r = await env.DB.prepare('SELECT contact_id FROM leads WHERE id = ?')
    .bind(leadId).first();
  return r && r.contact_id != null ? r.contact_id : null;
}

/**
 * Everything the record view shows for one lead: the lead, the person it
 * belongs to, their other jobs, their invoices and the whole timeline.
 *
 * Returns null when the lead does not exist.
 */
export async function loadRecord(env, leadId) {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first();
  if (!lead) return null;

  const cid = lead.contact_id;

  const contact = cid == null ? null
    : await env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(cid).first();

  // The same person's other jobs. Archived ones are left out: the record
  // view is about work, and an archived lead is on its way to deletion.
  const others = cid == null ? { results: [] }
    : await env.DB.prepare(
        `SELECT id, created_at, pipeline, status, service, system, city,
                referred_at, referral_status, scheduled_at, archived_at
           FROM leads
          WHERE contact_id = ? AND id != ? AND archived_at IS NULL
          ORDER BY created_at DESC
          LIMIT 50`).bind(cid, leadId).all();

  // Invoices raised from this lead, plus any raised from the same person's
  // other leads.
  const invoices = cid == null
    ? await env.DB.prepare(
        `SELECT * FROM invoices WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50`)
        .bind(leadId).all()
    : await env.DB.prepare(
        `SELECT i.* FROM invoices i
           LEFT JOIN leads l ON l.id = i.lead_id
          WHERE i.lead_id = ? OR l.contact_id = ?
          ORDER BY i.created_at DESC LIMIT 50`).bind(leadId, cid).all();

  const activities = cid == null
    ? await env.DB.prepare(
        `SELECT * FROM activities WHERE lead_id = ?
          ORDER BY created_at DESC LIMIT 200`).bind(leadId).all()
    : await env.DB.prepare(
        `SELECT * FROM activities WHERE lead_id = ? OR contact_id = ?
          ORDER BY created_at DESC LIMIT 200`).bind(leadId, cid).all();

  return {
    lead,
    contact: contact || null,
    otherLeads: others.results || [],
    invoices: invoices.results || [],
    activities: activities.results || []
  };
}

// Tick or untick a follow-up. Returns the updated row, or null if there was
// no such activity.
export async function setActivityDone(env, activityId, done, now) {
  return await env.DB.prepare(
    `UPDATE activities SET completed_at = ? WHERE id = ? RETURNING *`)
    .bind(done ? now : null, activityId).first() || null;
}

export async function deleteActivity(env, activityId) {
  const r = await env.DB.prepare('DELETE FROM activities WHERE id = ?').bind(activityId).run();
  return !!(r.meta && r.meta.changes);
}

/**
 * Open follow-ups across the whole CRM, soonest first -- what the dashboard
 * and the header badge count.
 *
 * Compared as ISO-8601 strings. Every stamp this application writes is
 * `toISOString()`, so lexicographic order is chronological order; mixing in
 * SQLite's datetime() would compare a 'Z'-suffixed string against one
 * without and quietly mis-sort.
 */
export async function openFollowups(env, nowIso, limit = 50) {
  const r = await env.DB.prepare(
    `SELECT a.*, l.name AS lead_name, l.archived_at AS lead_archived
       FROM activities a
       LEFT JOIN leads l ON l.id = a.lead_id
      WHERE a.due_at IS NOT NULL
        AND a.completed_at IS NULL
        AND (l.id IS NULL OR l.archived_at IS NULL)
      ORDER BY a.due_at ASC
      LIMIT ?`).bind(limit).all();
  const rows = r.results || [];
  return {
    all: rows,
    overdue: rows.filter((x) => x.due_at < nowIso),
    upcoming: rows.filter((x) => x.due_at >= nowIso)
  };
}
