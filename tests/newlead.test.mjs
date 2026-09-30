// Leads added by hand from the dashboard.
//
// A web lead arrives with a form behind it. A phone call has nothing, so the
// owner types it in. What matters: it lands in the right pipeline, nothing
// typed is lost, it is marked as hand-entered, and junk is refused.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLead, CAME_IN_BY } from '../functions/_lib/newlead.js';

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
          const r = sqlite(file, api._sql() + '; SELECT changes() AS c, last_insert_rowid() AS id;');
          const last = r.length ? r[r.length - 1] : {};
          return { meta: { changes: last.c || 0, last_row_id: last.id } };
        }
      };
      return api;
    }
  };
}
function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-newlead-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  return { DB: fakeDb(file), _file: file };
}

const NOW = '2026-10-10T12:00:00.000Z';
const leads = (env) => sqlite(env._file, 'SELECT * FROM leads ORDER BY id');
const acts = (env) => sqlite(env._file, 'SELECT * FROM activities ORDER BY id');

test('a phone call becomes a new repair lead with everything typed kept', async () => {
  const env = freshEnv();
  const out = await createLead(env, {
    pipeline: 'repair', name: 'Pat Caller', phone: '(470) 555-0100', email: 'pat@example.com',
    address: '1 Main St', city: 'Marietta', system: 'PianoDisc iQ', service: 'Player unit repair',
    message: 'Unit powers on but will not play.', notes: 'Call back after 5', came_in_by: 'phone'
  }, 'owner@example.com', NOW);
  assert.equal(out.error, undefined);
  const [row] = leads(env);
  assert.equal(out.lead.id, row.id);
  assert.equal(row.status, 'new');
  assert.equal(row.pipeline, 'repair');
  assert.equal(row.created_at, NOW);
  assert.equal(row.name, 'Pat Caller');
  assert.equal(row.phone, '(470) 555-0100');
  assert.equal(row.city, 'Marietta');
  assert.equal(row.system, 'PianoDisc iQ');
  assert.equal(row.message, 'Unit powers on but will not play.');
  assert.equal(row.notes, 'Call back after 5');
  assert.equal(row.lead_source, 'phone');
});

test('a hand-entered lead is marked as such, apart from web leads', async () => {
  const env = freshEnv();
  await createLead(env, { pipeline: 'tuning', name: 'Sam' }, 'owner@example.com', NOW);
  const [row] = leads(env);
  assert.equal(row.source, 'dashboard');
  assert.deepEqual(JSON.parse(row.fields), { name: 'Sam' });
});

test('adding one writes an "Added by hand" line in its history, naming who', async () => {
  const env = freshEnv();
  const out = await createLead(env, { pipeline: 'repair', phone: '4705550100' }, 'owner@example.com', NOW);
  const [a] = acts(env);
  assert.equal(a.lead_id, out.lead.id);
  assert.equal(a.actor, 'owner@example.com');
  assert.match(a.subject, /Added by hand/);
});

test('someone with no name, phone or email is refused', async () => {
  const env = freshEnv();
  const out = await createLead(env, { pipeline: 'repair', city: 'Atlanta', message: 'hi' }, 'o', NOW);
  assert.equal(out.status, 400);
  assert.match(out.error, /name, phone or email/i);
  assert.equal(leads(env).length, 0);
});

test('an unknown pipeline is refused', async () => {
  const env = freshEnv();
  const out = await createLead(env, { pipeline: 'sales', name: 'X' }, 'o', NOW);
  assert.equal(out.status, 400);
  assert.equal(leads(env).length, 0);
});

test('an unknown "came in by" is dropped rather than stored', async () => {
  const env = freshEnv();
  await createLead(env, { pipeline: 'repair', name: 'X', came_in_by: 'carrier pigeon' }, 'o', NOW);
  assert.equal(leads(env)[0].lead_source, null);
  assert.ok(CAME_IN_BY.includes('phone'));
});

test('long values are cut to the same caps as editing', async () => {
  const env = freshEnv();
  await createLead(env, { pipeline: 'repair', name: 'n'.repeat(500), notes: 'x'.repeat(5000) }, 'o', NOW);
  const [row] = leads(env);
  assert.equal(row.name.length, 200);
  assert.equal(row.notes.length, 4000);
});

test('whitespace-only fields are stored as nothing', async () => {
  const env = freshEnv();
  await createLead(env, { pipeline: 'repair', name: '  Lee ', email: '   ', city: '' }, 'o', NOW);
  const [row] = leads(env);
  assert.equal(row.name, 'Lee');
  assert.equal(row.email, null);
  assert.equal(row.city, null);
});
