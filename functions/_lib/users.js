// The users table: who may sign in to the CRM, and with which role.
//
// Ported from HRG's platform (api/internal/auth/users.go). Not to be confused
// with the people table, which is contractors and partners.
//
// Two rules matter more than the rest.
//
// Nobody is locked out. Every address in ACCESS_EMAILS is an active owner
// whether or not it has a row here, and a row for it may change the name it
// shows but never its role or whether it is active. That is what makes
// applying the migration, or a bad edit on the Users screen, survivable.
//
// There is always an owner. A change that would leave no active owner -- a
// role change away from owner, or deactivating one, including yourself -- is
// refused. The check and the write are one UPDATE statement, so two owners
// demoting each other at the same moment cannot both succeed.

import { ROLES, isRole, roleName } from './roles.js';
import { emailAllowed } from './auth.js';

export const LIMITS = { email: 200, name: 120 };

// last_seen_at is written at most this often per person.
export const LAST_SEEN_EVERY_MS = 5 * 60 * 1000;

const COLUMNS = 'email, name, role, active, created_at, last_seen_at, created_by';

// How every email is keyed: trimmed and lowercased.
export function cleanEmail(e) {
  return String(e == null ? '' : e).trim().toLowerCase();
}

export function validEmail(e) {
  const s = cleanEmail(e);
  return s.length <= LIMITS.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

// The exact addresses in ACCESS_EMAILS. A '@domain' entry admits a whole
// domain as owners, but it names nobody, so it is not counted when the
// last-owner guard asks whether another owner exists.
export function bootstrapAddresses(env) {
  return String(env.ACCESS_EMAILS || '').toLowerCase().split(/[\s,;]+/)
    .filter((x) => x && !x.startsWith('@') && x.includes('@'));
}

// Is this address an owner because ACCESS_EMAILS says so? Uses the same
// matcher as the sign-in gate, so the two can never disagree.
export function isBootstrapOwner(env, email) {
  return emailAllowed(env, email);
}

function shape(row) {
  return row ? {
    email: row.email, name: row.name || '', role: row.role, active: !!row.active,
    createdAt: row.created_at, lastSeenAt: row.last_seen_at || null, createdBy: row.created_by || ''
  } : null;
}

// One row, active or not, or null.
export async function getUser(env, email) {
  const e = cleanEmail(email);
  if (!e || !env.DB) return null;
  return shape(await env.DB.prepare(`SELECT ${COLUMNS} FROM users WHERE email = ?`).bind(e).first());
}

/**
 * Everyone on the Users screen: every row, plus every ACCESS_EMAILS address
 * that has none, because those are owners too and hiding them would make
 * the screen lie about who can get in.
 */
export async function listUsers(env) {
  const rows = ((await env.DB.prepare(`SELECT ${COLUMNS} FROM users ORDER BY email`).all()).results || [])
    .map(shape);
  const out = rows.map((u) => isBootstrapOwner(env, u.email)
    ? { ...u, role: 'owner', active: true, bootstrap: true }
    : { ...u, bootstrap: false });
  for (const e of bootstrapAddresses(env)) {
    if (!out.some((u) => u.email === e)) {
      out.push({ email: e, name: '', role: 'owner', active: true, createdAt: null,
        lastSeenAt: null, createdBy: 'ACCESS_EMAILS', bootstrap: true });
    }
  }
  return out.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.email.localeCompare(b.email));
}

// The trail for the Users screen. These rows have no lead, so no lead's
// timeline ever shows them.
export async function userActivity(env, limit = 30) {
  const r = await env.DB.prepare(
    `SELECT id, created_at, subject, actor, meta FROM activities
      WHERE lead_id IS NULL AND contact_id IS NULL AND json_extract(meta, '$.area') = 'users'
      ORDER BY id DESC LIMIT ?`).bind(limit).all();
  return r.results || [];
}

// One row of the users trail, as a statement to run in the same batch as
// the change it records. D1 runs a batch as one transaction, so the change
// and its log line land together or not at all. The row is written only if
// `cond` holds afterwards -- that is, only if the change actually happened:
// a refused change leaves the users row as it was, and writes no line.
function logStmt(env, actor, subject, meta, now, cond, condBinds) {
  return env.DB.prepare(
    `INSERT INTO activities
       (created_at, lead_id, contact_id, type, subject, body, due_at, completed_at, actor, meta)
     SELECT ?, NULL, NULL, 'status', ?, NULL, NULL, NULL, ?, ?
      WHERE ${cond}`)
    .bind(now, String(subject).slice(0, 200), String(actor || '').slice(0, 200) || null,
      JSON.stringify({ area: 'users', ...meta }), ...condBinds);
}

const given = (v) => v !== undefined && v !== null;

/**
 * Add someone. Returns { user } or { error, status }.
 */
export async function createUser(env, input, actor, now) {
  const i = input || {};
  const email = typeof i.email === 'string' ? validEmail(i.email) : '';
  if (!email) return { error: 'That email address does not look right.', status: 400 };
  if (given(i.name) && typeof i.name !== 'string') return { error: 'bad name', status: 400 };
  const name = String(i.name || '').trim().slice(0, LIMITS.name);
  // An ACCESS_EMAILS address is an owner whatever the row says, so the row
  // says owner too rather than something that will never apply.
  const boot = isBootstrapOwner(env, email);
  const role = boot ? 'owner' : (typeof i.role === 'string' ? i.role : '');
  if (!isRole(role)) return { error: 'Pick a role.', status: 400 };
  const by = String(actor || '').slice(0, 200) || null;

  const [ins] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (email, name, role, active, created_at, created_by)
       VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(email) DO NOTHING`)
      .bind(email, name, role, now, by),
    // Only if this batch's insert is the row now there.
    logStmt(env, actor, `User added: ${email} as ${roleName(role)}`,
      { user: email, change: 'added', role }, now,
      'EXISTS (SELECT 1 FROM users WHERE email = ? AND created_at = ? AND created_by IS ? AND role = ?)',
      [email, now, by, role])
  ]);
  if (!(ins && ins.meta && ins.meta.changes)) return { error: `${email} is already on the list.`, status: 409 };
  return { user: { ...(await getUser(env, email)), bootstrap: boot } };
}

/**
 * Change someone's name, role or active flag. Anything left undefined is
 * left alone: a role change must never quietly re-enable an account.
 * `active` must be a real boolean and `role` a string: "false" is not false.
 * Returns { user } or { error, status }.
 */
export async function updateUser(env, email, change, actor, now) {
  const c = change || {};
  if (typeof email !== 'string') return { error: 'No such user.', status: 404 };
  if (given(c.active) && typeof c.active !== 'boolean') return { error: 'active must be true or false.', status: 400 };
  if (given(c.role) && (typeof c.role !== 'string' || !isRole(c.role))) return { error: 'Pick a role.', status: 400 };
  if (given(c.name) && typeof c.name !== 'string') return { error: 'bad name', status: 400 };

  const e = cleanEmail(email);
  const cur = await getUser(env, e);
  const boot = isBootstrapOwner(env, e);
  const wantsRole = given(c.role);
  const wantsActive = given(c.active);

  if (boot && ((wantsRole && c.role !== 'owner') || (wantsActive && !c.active))) {
    return { error: `${e} is in ACCESS_EMAILS, so they are always an owner. ` +
      'Take them out of ACCESS_EMAILS in Cloudflare Pages settings first.', status: 409 };
  }

  if (!cur) {
    // An ACCESS_EMAILS owner with no row yet: renaming them creates one.
    if (boot && given(c.name)) {
      return createUser(env, { email: e, name: c.name, role: 'owner' }, actor, now);
    }
    return { error: 'No such user.', status: 404 };
  }

  const name = given(c.name) ? c.name.trim().slice(0, LIMITS.name) : cur.name;
  const role = wantsRole ? c.role : cur.role;
  const active = wantsActive ? (c.active ? 1 : 0) : (cur.active ? 1 : 0);
  const others = bootstrapAddresses(env).filter((x) => x !== e).length;

  const what = [];
  if (role !== cur.role) what.push({ field: 'role', from: cur.role, to: role,
    text: `${roleName(cur.role)} → ${roleName(role)}` });
  if (!!active !== cur.active) what.push({ field: 'active', from: cur.active, to: !!active,
    text: active ? 'reactivated' : 'deactivated' });
  if (name !== cur.name) what.push({ field: 'name', from: cur.name, to: name, text: 'renamed' });

  // The change is one statement: the guard reads the table as it is at the
  // moment of the write, so two concurrent demotions cannot each see the
  // other still active. The row is changed when it is not an active owner
  // now, or stays one, or some other active owner exists. Its log lines ride
  // in the same batch, each written only if the row now holds the new values.
  const after = 'EXISTS (SELECT 1 FROM users WHERE email = ? AND name = ? AND role = ? AND active = ?)';
  const [upd] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET name = ?, role = ?, active = ?
        WHERE email = ?
          AND (NOT (role = 'owner' AND active = 1)
               OR (? = 'owner' AND ? = 1)
               OR ? > 0
               OR EXISTS (SELECT 1 FROM users o WHERE o.role = 'owner' AND o.active = 1 AND o.email <> ?))`)
      .bind(name, role, active, e, role, active, others, e),
    ...what.map((w) => logStmt(env, actor, `User ${e}: ${w.text}`,
      { user: e, change: w.field, from: w.from, to: w.to }, now, after, [e, name, role, active]))
  ]);
  if (!(upd && upd.meta && upd.meta.changes)) {
    if (!(await getUser(env, e))) return { error: 'No such user.', status: 404 };
    return { error: 'That would leave nobody as an active owner. Make someone else an owner first.', status: 409 };
  }
  return { user: { ...(await getUser(env, e)), bootstrap: boot } };
}

// Records that someone was just seen, at most once per LAST_SEEN_EVERY_MS.
// The age check is in the statement too, so concurrent requests still write
// once. Only touches an existing row.
export async function touchIfStale(env, user, now) {
  if (!env.DB || !user || !user.email) return;
  if (user.lastSeenAt && Date.parse(now) - Date.parse(user.lastSeenAt) < LAST_SEEN_EVERY_MS) return;
  const cutoff = new Date(Date.parse(now) - LAST_SEEN_EVERY_MS).toISOString();
  await env.DB.prepare(
    'UPDATE users SET last_seen_at = ? WHERE email = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)')
    .bind(now, cleanEmail(user.email), cutoff).run();
}
