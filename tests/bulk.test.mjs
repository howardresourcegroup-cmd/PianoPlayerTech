// Bulk operations, against the real schema.
//
// A single-lead mistake is one click to undo. A bulk mistake is thirty rows
// changed at once with no memory of what they were, so these tests are less
// about the happy path than about refusing: bad ids, too many, archived
// leads, and reporting honestly how many actually changed.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIds, applyBulk, BULK_MAX, BULK_OPS } from '../functions/_lib/bulk.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const lit = (v) => v == null ? 'NULL'
  : typeof v === 'number' ? String(v)
  : typeof v === 'boolean' ? (v ? '1' : '0')
  : `'${String(v).replace(/'/g, "''")}'`;

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

const T0 = '2026-09-22T12:00:00.000Z';

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-bulk-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  const env = { DB: fakeDb(file), _file: file };
  sqlite(file, `INSERT INTO contacts (id, created_at, name) VALUES (1, '${T0}', 'Dana')`);
  for (const id of [1, 2, 3]) {
    sqlite(file, `INSERT INTO leads (id, created_at, pipeline, status, name, contact_id)
                  VALUES (${id}, '${T0}', 'tuning', 'new', 'Lead ${id}', 1)`);
  }
  // One already archived.
  sqlite(file, `INSERT INTO leads (id, created_at, pipeline, status, name, contact_id, archived_at)
                VALUES (4, '${T0}', 'tuning', 'new', 'Lead 4', 1, '${T0}')`);
  return env;
}

const get = (env, id) => sqlite(env._file, `SELECT * FROM leads WHERE id = ${id}`)[0];
const acts = (env) => sqlite(env._file, `SELECT * FROM activities ORDER BY id`);

// ------------------------------------------------------------ id parsing
test('ids are parsed, de-duplicated and kept as integers', () => {
  assert.deepStrictEqual(parseIds([3, '1', 2, '1']).ids, [3, 1, 2]);
});

// The important refusal: a bad id means the client and server disagree about
// what is selected, and guessing is worse than stopping.
test('one bad id refuses the whole request', () => {
  for (const bad of [['1', 'abc'], [1, null], [1, -2], [1, 0], [1, 1.5]]) {
    const r = parseIds(bad);
    assert.ok(r.error, `${JSON.stringify(bad)} should have been refused`);
    assert.ok(!r.ids);
  }
});

test('an empty or non-array selection is refused', () => {
  assert.ok(parseIds([]).error);
  assert.ok(parseIds(null).error);
  assert.ok(parseIds('1,2,3').error);
});

test('there is a hard cap, and it is reported with the number', () => {
  const many = Array.from({ length: BULK_MAX + 1 }, (_, i) => i + 1);
  const r = parseIds(many);
  assert.ok(r.error);
  assert.match(r.error, new RegExp(String(BULK_MAX)));
  assert.ok(parseIds(many.slice(0, BULK_MAX)).ids, 'exactly the cap is allowed');
});

// ------------------------------------------------------------- applying
test('a status is set on every live lead', async () => {
  const env = freshEnv();
  const out = await applyBulk(env, [1, 2, 3], { op: 'status', value: 'booked', actor: 'e@x.com' }, T0);
  assert.strictEqual(out.changed, 3);
  assert.strictEqual(out.skipped, 0);
  for (const id of [1, 2, 3]) assert.strictEqual(get(env, id).status, 'booked');
});

test('a pipeline move works the same way', async () => {
  const env = freshEnv();
  await applyBulk(env, [1, 2], { op: 'pipeline', value: 'repair', actor: 'e@x.com' }, T0);
  assert.strictEqual(get(env, 1).pipeline, 'repair');
  assert.strictEqual(get(env, 3).pipeline, 'tuning', 'untouched');
});

// The same rule the single-lead path enforces: a stale tab must not mutate
// something nobody can see.
test('archived leads are skipped, and the reply says so', async () => {
  const env = freshEnv();
  const out = await applyBulk(env, [1, 4], { op: 'status', value: 'booked', actor: 'e@x.com' }, T0);
  assert.strictEqual(out.changed, 1);
  assert.strictEqual(out.skipped, 1);
  assert.strictEqual(get(env, 4).status, 'new', 'the archived lead is untouched');
});

test('asking for leads that do not exist changes nothing and admits it', async () => {
  const env = freshEnv();
  const out = await applyBulk(env, [900, 901], { op: 'status', value: 'booked', actor: 'e@x.com' }, T0);
  assert.strictEqual(out.changed, 0);
  assert.strictEqual(out.skipped, 2);
});

test('archive and restore are mirror images', async () => {
  const env = freshEnv();
  const archived = await applyBulk(env, [1, 2], { op: 'archive', actor: 'e@x.com' }, T0);
  assert.strictEqual(archived.changed, 2);
  assert.strictEqual(get(env, 1).archived_at, T0);

  // Restore only touches archived ones -- lead 3 is live, so it is skipped.
  const back = await applyBulk(env, [1, 2, 3], { op: 'restore', actor: 'e@x.com' }, T0);
  assert.strictEqual(back.changed, 2);
  assert.strictEqual(back.skipped, 1);
  assert.strictEqual(get(env, 1).archived_at, null);
});

// -------------------------------------------------------------- history
test('every lead in a bulk change gets its own history entry', async () => {
  const env = freshEnv();
  await applyBulk(env, [1, 2, 3], { op: 'status', value: 'booked', actor: 'e@x.com' }, T0);
  const a = acts(env);
  assert.strictEqual(a.length, 3);
  assert.deepStrictEqual(a.map((x) => x.lead_id).sort(), [1, 2, 3]);
  for (const x of a) {
    assert.strictEqual(x.type, 'status');
    assert.strictEqual(x.actor, 'e@x.com');
    assert.strictEqual(x.contact_id, 1, 'the contact is stamped, so history is per person');
    const meta = JSON.parse(x.meta);
    assert.strictEqual(meta.from, 'new', 'records what it changed from');
    assert.strictEqual(meta.to, 'booked');
    assert.strictEqual(meta.bulk, true, 'marked as a bulk change');
  }
});

test('a skipped lead gets no history entry', async () => {
  const env = freshEnv();
  await applyBulk(env, [1, 4], { op: 'status', value: 'booked', actor: 'e@x.com' }, T0);
  assert.deepStrictEqual(acts(env).map((x) => x.lead_id), [1]);
});

test('the operation list is what the route validates against', () => {
  assert.deepStrictEqual(BULK_OPS, ['status', 'pipeline', 'archive', 'restore']);
});
