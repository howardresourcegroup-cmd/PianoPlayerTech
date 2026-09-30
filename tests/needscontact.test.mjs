// Needs Contact: the status that means "you owe them a call".
//
// Marking it should put a reminder in front of the owner without them
// having to create one, and moving on from it should take the reminder
// away again. A reminder that lingers after the call was made trains the
// owner to ignore the panel.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onStatusChange, REMIND_AFTER_HOURS } from '../functions/_lib/needscontact.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lit = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
function sqlite(file, sql) {
  const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}
function fakeDb(file) {
  return {
    prepare(sql) {
      let params = [];
      const api = {
        bind(...p) { params = p; return api; },
        _sql() { let i = 0; return sql.replace(/\?/g, () => lit(params[i++])); },
        async first() { return sqlite(file, api._sql())[0] || null; },
        async all() { return { results: sqlite(file, api._sql()) }; },
        async run() {
          const r = sqlite(file, api._sql() + '; SELECT changes() AS c;');
          return { meta: { changes: r.length ? r[r.length - 1].c : 0 } };
        }
      };
      return api;
    }
  };
}
const NOW = '2026-10-10T12:00:00.000Z';
function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-nc-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  sqlite(file, `INSERT INTO leads (id, created_at, pipeline, status, name) VALUES (1, '${NOW}', 'repair', 'new', 'Dana')`);
  return { DB: fakeDb(file), _file: file };
}
const tasks = (env) => sqlite(env._file, "SELECT * FROM activities WHERE due_at IS NOT NULL ORDER BY id");

test('moving a lead to Needs Contact leaves a reminder due the next day', async () => {
  const env = freshEnv();
  await onStatusChange(env, 1, 'new', 'needs_contact', 'owner@example.com', NOW);
  const t = tasks(env);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].lead_id, 1);
  assert.strictEqual(t[0].completed_at, null);
  assert.match(t[0].subject, /Dana/);
  const hours = (Date.parse(t[0].due_at) - Date.parse(NOW)) / 3600000;
  assert.strictEqual(hours, REMIND_AFTER_HOURS);
});

test('moving on from Needs Contact clears the reminder it made, and no other', async () => {
  const env = freshEnv();
  sqlite(env._file, `INSERT INTO activities (created_at, lead_id, type, subject, due_at) VALUES ('${NOW}', 1, 'task', 'Order a part', '2026-10-12T12:00:00.000Z')`);
  await onStatusChange(env, 1, 'new', 'needs_contact', 'o', NOW);
  await onStatusChange(env, 1, 'needs_contact', 'waiting', 'o', '2026-10-10T13:00:00.000Z');
  const t = tasks(env);
  assert.strictEqual(t.length, 2);
  const mine = t.find((x) => /Dana/.test(x.subject));
  const theirs = t.find((x) => x.subject === 'Order a part');
  assert.strictEqual(mine.completed_at, '2026-10-10T13:00:00.000Z');
  assert.strictEqual(theirs.completed_at, null);
});

test('marking it Needs Contact twice does not stack reminders', async () => {
  const env = freshEnv();
  await onStatusChange(env, 1, 'new', 'needs_contact', 'o', NOW);
  await onStatusChange(env, 1, 'needs_contact', 'needs_contact', 'o', NOW);
  assert.strictEqual(tasks(env).length, 1);
});

test('any other change does nothing', async () => {
  const env = freshEnv();
  await onStatusChange(env, 1, 'new', 'quoted', 'o', NOW);
  assert.strictEqual(tasks(env).length, 0);
});
