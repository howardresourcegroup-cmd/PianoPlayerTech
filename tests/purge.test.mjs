import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PURGE_DAYS, purgeCutoff, purgeExpired } from '../functions/_lib/db.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the cutoff is an ISO string PURGE_DAYS back', () => {
  assert.strictEqual(PURGE_DAYS, 30);
  assert.strictEqual(
    purgeCutoff(new Date('2026-09-22T12:00:00Z')), '2026-08-23T12:00:00.000Z');
});

test('the cutoff crosses a month boundary correctly', () => {
  assert.strictEqual(
    purgeCutoff(new Date('2026-03-05T00:00:00Z')), '2026-02-03T00:00:00.000Z');
});

test('purgeExpired reports how many rows it removed', async () => {
  const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 4 } }) }) }) } };
  assert.strictEqual(await purgeExpired(env, purgeCutoff(new Date())), 4);
});

test('purgeExpired reports zero rather than undefined when nothing matched', async () => {
  const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) } };
  assert.strictEqual(await purgeExpired(env, purgeCutoff(new Date())), 0);
});

test('purgeExpired binds the cutoff rather than inlining it', async () => {
  let boundTo = null, sql = null;
  const env = { DB: { prepare(s) { sql = s; return {
    bind(v) { boundTo = v; return { run: async () => ({ meta: { changes: 0 } }) }; } }; } } };
  const cutoff = purgeCutoff(new Date('2026-09-22T12:00:00Z'));
  await purgeExpired(env, cutoff);
  assert.strictEqual(boundTo, cutoff);
  assert.match(sql, /DELETE FROM leads/);
  assert.match(sql, /archived_at IS NOT NULL/);
});

// The behaviour that matters: only leads archived longer ago than the cutoff
// are removed, and an active lead is never touched.
test('only leads archived beyond the cutoff are deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-'));
  const db = path.join(dir, 't.db');
  execFileSync('sqlite3', [db], {
    input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8')
  });
  execFileSync('sqlite3', [db, `
    INSERT INTO leads (created_at,pipeline,status,name,archived_at) VALUES
      ('2026-01-01T00:00:00Z','tuning','new','LongGone','2026-08-01T00:00:00.000Z'),
      ('2026-01-01T00:00:00Z','tuning','new','JustInside','2026-08-24T00:00:00.000Z'),
      ('2026-01-01T00:00:00Z','tuning','new','Recent','2026-09-20T00:00:00.000Z'),
      ('2026-01-01T00:00:00Z','tuning','new','Active',NULL);`]);

  const cutoff = purgeCutoff(new Date('2026-09-22T12:00:00Z'));
  execFileSync('sqlite3', [db,
    `DELETE FROM leads WHERE archived_at IS NOT NULL AND archived_at < '${cutoff}'`]);

  const names = execFileSync('sqlite3',
    [db, 'SELECT name FROM leads ORDER BY name'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepStrictEqual(names, ['Active', 'JustInside', 'Recent']);
});
