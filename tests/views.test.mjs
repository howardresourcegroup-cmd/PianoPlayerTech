// Saved views.
//
// This is the one place the browser hands the server a structure rather than
// a scalar, so most of these tests are about what happens when that
// structure is wrong, hostile, or written by a version that no longer
// exists.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanConfig, listViews, saveView, deleteView, VIEW_LIMITS }
  from '../functions/_lib/views.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const lit = (v) => v == null ? 'NULL'
  : typeof v === 'number' ? String(v)
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

const T0 = '2026-09-23T12:00:00.000Z';
function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-views-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  return { DB: fakeDb(file), _file: file };
}

// ------------------------------------------------------------ the config
test('a good config survives intact', () => {
  const c = cleanConfig({ q: 'is:unbilled', sf: 'booked', sortKey: 'created_at', sortDir: -1, pageSize: 50, tab: 'tuning' });
  assert.deepStrictEqual(c, { q: 'is:unbilled', sf: 'booked', sortKey: 'created_at', sortDir: -1, pageSize: 50, tab: 'tuning' });
});

// The point of rebuilding rather than storing what was sent.
test('unknown keys are dropped', () => {
  const c = cleanConfig({ q: 'x', evil: '<script>', __proto__: { polluted: true }, onclick: 'boom' });
  assert.deepStrictEqual(Object.keys(c).sort(),
    ['pageSize', 'q', 'sf', 'sortDir', 'sortKey', 'tab']);
  assert.strictEqual(c.evil, undefined);
  assert.strictEqual(c.onclick, undefined);
});

test('a bad value falls back rather than being stored', () => {
  assert.strictEqual(cleanConfig({ pageSize: 9999 }).pageSize, 100);
  assert.strictEqual(cleanConfig({ pageSize: 'lots' }).pageSize, 100);
  assert.strictEqual(cleanConfig({ sortDir: 7 }).sortDir, 1);
  assert.strictEqual(cleanConfig({ sortKey: 'name; DROP TABLE leads' }).sortKey, null);
  assert.strictEqual(cleanConfig({ sortKey: 'created_at' }).sortKey, 'created_at');
  assert.strictEqual(cleanConfig({ tab: '../../etc' }).tab, '');
});

test('anything at all can be passed without throwing', () => {
  for (const bad of [null, undefined, 'a string', 42, [], true]) {
    const c = cleanConfig(bad);
    assert.strictEqual(c.pageSize, 100);
    assert.strictEqual(c.q, '');
  }
});

test('long values are clipped, not rejected', () => {
  const c = cleanConfig({ q: 'x'.repeat(5000) });
  assert.strictEqual(c.q.length, VIEW_LIMITS.query);
});

// ------------------------------------------------------------- storing
test('a view is saved and comes back', async () => {
  const env = freshEnv();
  const { view } = await saveView(env, { name: 'Unbilled tunings',
    config: { q: 'is:unbilled', tab: 'tuning' }, owner: 'e@x.com' }, T0);
  assert.ok(view.id);
  assert.strictEqual(view.name, 'Unbilled tunings');
  assert.strictEqual(view.config.q, 'is:unbilled');

  const all = await listViews(env);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].owner, 'e@x.com');
});

test('a view needs a name', async () => {
  const env = freshEnv();
  assert.ok((await saveView(env, { name: '   ', config: {} }, T0)).error);
});

test('saving over an existing view replaces it', async () => {
  const env = freshEnv();
  const { view } = await saveView(env, { name: 'Mine', config: { q: 'a' } }, T0);
  const { view: v2 } = await saveView(env, { id: view.id, name: 'Renamed', config: { q: 'b' } }, T0);
  assert.strictEqual(v2.id, view.id);
  assert.strictEqual(v2.name, 'Renamed');
  assert.strictEqual((await listViews(env)).length, 1, 'replaced, not duplicated');
});

test('saving over one that is gone says so', async () => {
  const env = freshEnv();
  assert.ok((await saveView(env, { id: 999, name: 'x', config: {} }, T0)).error);
});

test('there is a limit on how many can be saved', async () => {
  const env = freshEnv();
  for (let i = 0; i < VIEW_LIMITS.perOwner; i++) {
    await saveView(env, { name: 'v' + i, config: {} }, T0);
  }
  const r = await saveView(env, { name: 'one too many', config: {} }, T0);
  assert.ok(r.error);
  assert.match(r.error, new RegExp(String(VIEW_LIMITS.perOwner)));
});

test('views come back in their saved order', async () => {
  const env = freshEnv();
  for (const n of ['first', 'second', 'third']) await saveView(env, { name: n, config: {} }, T0);
  assert.deepStrictEqual((await listViews(env)).map((v) => v.name), ['first', 'second', 'third']);
});

test('a view can be deleted, once', async () => {
  const env = freshEnv();
  const { view } = await saveView(env, { name: 'temp', config: {} }, T0);
  assert.strictEqual((await deleteView(env, view.id)).deleted, view.id);
  assert.ok((await deleteView(env, view.id)).error, 'deleting twice says so');
  assert.strictEqual((await listViews(env)).length, 0);
});

// A row written by hand or by an older version must not break the dashboard.
test('an unparseable stored config becomes an empty one', async () => {
  const env = freshEnv();
  sqlite(env._file, `INSERT INTO views (created_at, name, config, sort)
                     VALUES ('${T0}', 'broken', 'not json at all', 10)`);
  const all = await listViews(env);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].config.q, '', 'survived, as an empty view');
  assert.strictEqual(all[0].config.pageSize, 100);
});

test('a stored config with junk in it is cleaned on the way out', async () => {
  const env = freshEnv();
  sqlite(env._file, `INSERT INTO views (created_at, name, config, sort)
                     VALUES ('${T0}', 'junky', '{"q":"ok","evil":"<img onerror=1>","pageSize":99999}', 10)`);
  const [v] = await listViews(env);
  assert.strictEqual(v.config.q, 'ok');
  assert.strictEqual(v.config.evil, undefined, 'dropped on read, not just on write');
  assert.strictEqual(v.config.pageSize, 100);
});

test('a missing views table does not break the dashboard', async () => {
  const env = { DB: { prepare() { throw new Error('no such table: views'); } } };
  assert.deepStrictEqual(await listViews(env), []);
});
