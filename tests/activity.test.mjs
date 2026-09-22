// The activity trail, run against the real schema.
//
// The interesting failure here is not logic, it is a column name that does
// not exist. `loadRecord` joins four tables; a typo in one of them compiles,
// lints and ships, then throws the first time somebody opens a lead. So
// these tests execute activity.js's actual SQL against a database built from
// db/schema.sql, through a small shim that stands in for D1.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_TYPES, LOGGABLE_TYPES, SCHEDULED_TYPES, normStamp,
  logActivity, logQuietly, contactIdFor, loadRecord, setActivityDone,
  deleteActivity, openFollowups
} from '../functions/_lib/activity.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------- the D1 shim
const lit = (v) => v == null ? 'NULL'
  : typeof v === 'number' ? String(v)
  : typeof v === 'boolean' ? (v ? '1' : '0')
  : `'${String(v).replace(/'/g, "''")}'`;

function fill(sql, params) {
  let i = 0;
  return sql.replace(/\?/g, () => lit(params[i++]));
}

function sqlite(file, sql) {
  const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

// Enough of D1's interface for this module: prepare/bind/first/all/run.
function fakeDb(file) {
  return {
    prepare(sql) {
      let params = [];
      const api = {
        bind(...p) { params = p; return api; },
        async first() { return sqlite(file, fill(sql, params))[0] || null; },
        async all() { return { results: sqlite(file, fill(sql, params)) }; },
        async run() {
          const r = sqlite(file, fill(sql, params) + '; SELECT changes() AS c;');
          return { meta: { changes: r.length ? r[r.length - 1].c : 0 } };
        }
      };
      return api;
    }
  };
}

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-act-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  return { DB: fakeDb(file), _file: file };
}

const T0 = '2026-09-22T12:00:00.000Z';

function seed(env) {
  const q = (sql) => sqlite(env._file, sql);
  q(`INSERT INTO contacts (id, created_at, name, phone, email)
     VALUES (1, '${T0}', 'Dana Whitfield', '770-555-0142', 'dana@example.com')`);
  q(`INSERT INTO leads (id, created_at, pipeline, status, name, contact_id, service)
     VALUES (10, '${T0}', 'tuning', 'new', 'Dana Whitfield', 1, 'Piano Tuning')`);
  q(`INSERT INTO leads (id, created_at, pipeline, status, name, contact_id, service)
     VALUES (11, '2026-05-01T09:00:00.000Z', 'repair', 'closed', 'Dana Whitfield', 1, 'Player Repair')`);
  // An archived job for the same person: history, but not current work.
  q(`INSERT INTO leads (id, created_at, pipeline, status, name, contact_id, archived_at)
     VALUES (12, '2026-04-01T09:00:00.000Z', 'repair', 'new', 'Dana Whitfield', 1, '${T0}')`);
  // Someone else entirely.
  q(`INSERT INTO leads (id, created_at, pipeline, status, name, contact_id)
     VALUES (20, '${T0}', 'tuning', 'new', 'Marcus Bell', 2)`);
  q(`INSERT INTO invoices (id, created_at, kind, lead_id, bill_to, amount_cents, status)
     VALUES (100, '${T0}', 'custom', 11, 'Dana Whitfield', 25000, 'paid')`);
  return env;
}

// ----------------------------------------------------------------- stamps
test('a stamp is normalised to ISO, or rejected', () => {
  assert.strictEqual(normStamp('2026-09-22T12:00:00Z'), '2026-09-22T12:00:00.000Z');
  assert.strictEqual(normStamp('2026-09-22'), '2026-09-22T00:00:00.000Z');
  assert.strictEqual(normStamp('next tuesday'), '');
  assert.strictEqual(normStamp(''), '');
  assert.strictEqual(normStamp(null), '');
});

// The decoy problem again: a value the system writes must not be offerable
// as something a person can claim by hand.
test('status is a real activity type but nobody may write one', () => {
  assert.ok(ACTIVITY_TYPES.includes('status'));
  assert.ok(!LOGGABLE_TYPES.includes('status'));
});

test('every loggable and scheduled type is a real type', () => {
  for (const t of LOGGABLE_TYPES) assert.ok(ACTIVITY_TYPES.includes(t), `${t} is not a real type`);
  for (const t of SCHEDULED_TYPES) assert.ok(ACTIVITY_TYPES.includes(t), `${t} is not a real type`);
});

// ---------------------------------------------------------------- writing
test('an activity is written and returned', async () => {
  const env = seed(freshEnv());
  const row = await logActivity(env, {
    lead_id: 10, contact_id: 1, type: 'call',
    subject: 'Called about the pitch raise', body: 'Wants a quote.', actor: 'e@x.com'
  }, T0);
  assert.ok(row, 'no row came back');
  assert.strictEqual(row.type, 'call');
  assert.strictEqual(row.lead_id, 10);
  assert.strictEqual(row.contact_id, 1);
  assert.strictEqual(row.actor, 'e@x.com');
  assert.strictEqual(row.completed_at, null);
});

test('an unknown type is stored as a note rather than rejected silently', async () => {
  const env = seed(freshEnv());
  const row = await logActivity(env, { lead_id: 10, type: 'telepathy', body: 'hm' }, T0);
  assert.strictEqual(row.type, 'note');
});

test('a logging failure does not throw at the caller', async () => {
  const env = { DB: { prepare() { throw new Error('database is gone'); } } };
  const row = await logQuietly(env, { lead_id: 1, type: 'note', body: 'x' }, T0);
  assert.strictEqual(row, null, 'logQuietly must swallow, so the real write survives');
});

test('the contact is found for a lead, and absent for one without', async () => {
  const env = seed(freshEnv());
  assert.strictEqual(await contactIdFor(env, 10), 1);
  assert.strictEqual(await contactIdFor(env, 9999), null);
});

// ---------------------------------------------------------------- reading
test('the record gathers the lead, the person, their other jobs and invoices', async () => {
  const env = seed(freshEnv());
  await logActivity(env, { lead_id: 10, contact_id: 1, type: 'note', body: 'first' }, T0);
  await logActivity(env, { lead_id: 11, contact_id: 1, type: 'note', body: 'older job' }, T0);

  const rec = await loadRecord(env, 10);
  assert.ok(rec, 'no record');
  assert.strictEqual(rec.lead.id, 10);
  assert.strictEqual(rec.contact.name, 'Dana Whitfield');

  // The same person's other live job, and not the archived one.
  const ids = rec.otherLeads.map((l) => l.id);
  assert.deepStrictEqual(ids, [11], `expected only lead 11, saw ${ids}`);

  // An invoice raised against her other job still belongs to her history.
  assert.deepStrictEqual(rec.invoices.map((i) => i.id), [100]);

  // Her whole timeline, not just this lead's.
  assert.strictEqual(rec.activities.length, 2);
});

test('a lead with no contact still has a record', async () => {
  const env = seed(freshEnv());
  sqlite(env._file, `UPDATE leads SET contact_id = NULL WHERE id = 10`);
  await logActivity(env, { lead_id: 10, type: 'note', body: 'orphan' }, T0);
  const rec = await loadRecord(env, 10);
  assert.strictEqual(rec.contact, null);
  assert.deepStrictEqual(rec.otherLeads, []);
  assert.strictEqual(rec.activities.length, 1);
});

test('a missing lead has no record', async () => {
  const env = seed(freshEnv());
  assert.strictEqual(await loadRecord(env, 9999), null);
});

// Another person's leads must never appear in this one's history.
test('the record does not leak another person', async () => {
  const env = seed(freshEnv());
  await logActivity(env, { lead_id: 20, contact_id: 2, type: 'note', body: 'not Dana' }, T0);
  const rec = await loadRecord(env, 10);
  assert.ok(!rec.otherLeads.some((l) => l.id === 20));
  assert.ok(!rec.activities.some((a) => a.lead_id === 20));
});

// -------------------------------------------------------------- follow-ups
test('follow-ups split into overdue and upcoming by ISO comparison', async () => {
  const env = seed(freshEnv());
  await logActivity(env, { lead_id: 10, contact_id: 1, type: 'followup',
    subject: 'late', due_at: '2026-09-01T00:00:00Z' }, T0);
  await logActivity(env, { lead_id: 10, contact_id: 1, type: 'followup',
    subject: 'soon', due_at: '2026-10-01T00:00:00Z' }, T0);

  const due = await openFollowups(env, T0);
  assert.strictEqual(due.overdue.length, 1);
  assert.strictEqual(due.upcoming.length, 1);
  assert.strictEqual(due.overdue[0].subject, 'late');
  // Soonest first, so the thing most overdue is what you see.
  assert.strictEqual(due.all[0].subject, 'late');
});

test('a completed follow-up drops out, and a note never counted', async () => {
  const env = seed(freshEnv());
  const f = await logActivity(env, { lead_id: 10, contact_id: 1, type: 'followup',
    subject: 'ring back', due_at: '2026-09-01T00:00:00Z' }, T0);
  await logActivity(env, { lead_id: 10, contact_id: 1, type: 'note', body: 'no due date' }, T0);

  assert.strictEqual((await openFollowups(env, T0)).all.length, 1);
  const done = await setActivityDone(env, f.id, true, T0);
  assert.strictEqual(done.completed_at, T0);
  assert.strictEqual((await openFollowups(env, T0)).all.length, 0);

  // And back again, for a tick in the wrong box.
  await setActivityDone(env, f.id, false, T0);
  assert.strictEqual((await openFollowups(env, T0)).all.length, 1);
});

// An archived lead is on its way to deletion; chasing it is not work.
test('a follow-up on an archived lead is not chased', async () => {
  const env = seed(freshEnv());
  await logActivity(env, { lead_id: 12, contact_id: 1, type: 'followup',
    subject: 'archived job', due_at: '2026-09-01T00:00:00Z' }, T0);
  assert.strictEqual((await openFollowups(env, T0)).all.length, 0);
});

test('ticking or deleting something already gone says so', async () => {
  const env = seed(freshEnv());
  assert.strictEqual(await setActivityDone(env, 9999, true, T0), null);
  assert.strictEqual(await deleteActivity(env, 9999), false);
});

test('an activity can be deleted', async () => {
  const env = seed(freshEnv());
  const a = await logActivity(env, { lead_id: 10, contact_id: 1, type: 'note', body: 'oops' }, T0);
  assert.strictEqual(await deleteActivity(env, a.id), true);
  assert.strictEqual((await loadRecord(env, 10)).activities.length, 0);
});
