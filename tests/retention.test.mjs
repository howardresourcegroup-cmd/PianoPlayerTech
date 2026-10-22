// Imported (Airtable) leads are never auto-deleted; everyone else keeps the
// 30-day archive clock. The purge is the real purgeExpired against SQLite.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PURGE_DAYS, purgeCutoff, purgeExpired } from '../functions/_lib/db.js';
import { purgeLabel, isImported, KEPT_LABEL } from '../crm/retention.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-22T12:00:00Z');
const DAY = 86400000;

function setup() {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-ret-')), 't.db');
  execFileSync('sqlite3', [db], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  const old = new Date(NOW - 31 * DAY).toISOString();
  const fresh = new Date(NOW - 5 * DAY).toISOString();
  execFileSync('sqlite3', [db], { input: `
    INSERT INTO leads (created_at,pipeline,status,name,source,archived_at) VALUES
      ('2025-01-01T00:00:00Z','tuning','new','normal-old','/tuning','${old}'),
      ('2025-01-01T00:00:00Z','tuning','new','normal-null-source',NULL,'${old}'),
      ('2025-01-01T00:00:00Z','tuning','new','normal-fresh','/tuning','${fresh}'),
      ('2025-01-01T00:00:00Z','tuning','new','imported-old','Airtable: Google','${old}'),
      ('2025-01-01T00:00:00Z','tuning','new','imported-unknown','Airtable: unknown','${old}');` });
  const env = { DB: { prepare: (sql) => ({ bind: (v) => ({ run: async () => {
    const out = execFileSync('sqlite3', [db, sql.replace('?', "'" + v + "'") + '; SELECT changes();'], { encoding: 'utf8' });
    return { meta: { changes: Number(out.trim()) } };
  } }) }) } };
  const names = () => execFileSync('sqlite3', [db, 'SELECT name FROM leads ORDER BY name'], { encoding: 'utf8' }).trim().split('\n');
  return { env, names };
}

test('purge deletes a normal archived lead after 30 days', async () => {
  const { env, names } = setup();
  assert.strictEqual(await purgeExpired(env, purgeCutoff(NOW)), 2);
  assert.ok(!names().includes('normal-old'));
  assert.ok(!names().includes('normal-null-source'));
  assert.ok(names().includes('normal-fresh'), 'inside 30 days is kept');
});

test('purge never deletes an imported lead, however old', async () => {
  const { env, names } = setup();
  await purgeExpired(env, purgeCutoff(NOW));
  await purgeExpired(env, purgeCutoff(new Date(NOW.getTime() + 3650 * DAY)));
  assert.deepStrictEqual(names(), ['imported-old', 'imported-unknown']);
});

test('the Archive tab shows imported leads as kept, others as a countdown', () => {
  const at = new Date(NOW - 10 * DAY).toISOString();
  const imported = { source: 'Airtable: Google', archived_at: new Date(NOW - 400 * DAY).toISOString() };
  assert.ok(isImported(imported));
  assert.deepStrictEqual(purgeLabel(imported, PURGE_DAYS, NOW.getTime()), { text: KEPT_LABEL, soon: false });
  assert.strictEqual(KEPT_LABEL, 'Kept (imported)');
  assert.deepStrictEqual(purgeLabel({ source: '/tuning', archived_at: at }, PURGE_DAYS, NOW.getTime()), { text: '20 days', soon: false });
  assert.deepStrictEqual(purgeLabel({ source: null, archived_at: new Date(NOW - 29 * DAY).toISOString() }, PURGE_DAYS, NOW.getTime()), { text: '1 day', soon: true });
  assert.strictEqual(purgeLabel({ archived_at: new Date(NOW - 40 * DAY).toISOString() }, PURGE_DAYS, NOW.getTime()).text, 'any time now');
});
