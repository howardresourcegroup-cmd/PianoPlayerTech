// Custom tables: the owner's own tabs.
//
// The filter is the one place a browser describes a query, so most of this
// is about what happens when that description is wrong or hostile: unknown
// fields and operators are refused, values never reach the SQL text, and an
// archived lead stays out unless a table asks for it. The rest drives the
// real /leads handlers role by role, and checks the seed and the migration.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanRule, cleanRules, cleanTable, compileRules, compileOrder, FilterError,
  FIELDS, OPS, TABLE_COLUMNS, LIMITS, paramCount
} from '../functions/_lib/tablefilter.js';
import { listViews, listTables, saveView, deleteView } from '../functions/_lib/views.js';
import { purgeExpired } from '../functions/_lib/db.js';
import { onRequestGet, onRequestPost } from '../functions/leads.js';
import { ROOT, sqlite, fakeDb, freshDbFile, accessEnv, addUser, asUser, installFetch, context }
  from './fixtures/harness.mjs';

test.before(installFetch);

const OWNER = 'boss@ppt.test';
const PEOPLE = { manager: 'm@ppt.test', tech: 't@ppt.test', viewer: 'v@ppt.test' };
const NOW = new Date('2026-10-23T12:00:00.000Z');

const lit = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

// A handful of leads covering every field a rule can look at.
const LEADS = [
  { id: 1, created_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z', pipeline: 'tuning', status: 'new',
    name: 'Dana Tune', phone: '(770) 555-0101', email: 'dana@example.com', service: 'Piano Tuning', city: 'Marietta',
    source: '/tuning #tuning-booking-form', category: 'tuning', quoted_cents: null, assigned_to: 'm@ppt.test' },
  { id: 2, created_at: '2026-10-10T10:00:00.000Z', pipeline: 'repair', status: 'quoted',
    name: 'Glenn Disk', phone: '', email: 'g@example.com', service: 'Player Repair', system: 'Disklavier DKC-850',
    city: 'Atlanta', source: '/disklavier-power-supply-repair', category: 'electronic', quoted_cents: 150000 },
  { id: 3, created_at: '2026-10-15T10:00:00.000Z', pipeline: 'repair', status: 'new',
    name: 'Ada Ampico', phone: '404-555-0103', email: null, service: 'Player Repair', system: 'Ampico grand',
    city: 'Roswell', source: '/antique-player-piano', category: 'pneumatic', quoted_cents: 800000 },
  { id: 4, created_at: '2026-09-01T10:00:00.000Z', pipeline: 'repair', status: 'closed',
    name: 'Una Known', phone: '678-555-0104', email: 'u@example.com', service: 'Player Repair',
    city: 'Atlanta', source: 'Airtable: Website', category: null, quoted_cents: 50000 },
  { id: 5, created_at: '2026-10-05T10:00:00.000Z', pipeline: 'repair', status: 'new', archived_at: '2026-10-06T10:00:00.000Z',
    name: 'Archie Ved', phone: '770-555-0105', email: 'a@example.com', service: 'Player Repair', system: 'Welte',
    city: 'Atlanta', source: '/antique-player-piano', category: 'pneumatic' },
  { id: 6, created_at: '2026-10-21T10:00:00.000Z', pipeline: 'repair', status: 'new',
    name: '50% Off_Guy', phone: '770-555-0106', email: 'pct@example.com', service: 'Piano Detailing',
    city: 'Cumming', source: '/piano-cleaning #detailing-form', category: 'acoustic', message: "it's 100% out" }
];

function seedLeads(file) {
  for (const l of LEADS) {
    const cols = Object.keys(l);
    sqlite(file, `INSERT INTO leads (${cols.join(', ')}) VALUES (${cols.map((c) => lit(l[c])).join(', ')})`);
  }
}

function dbEnv() {
  const file = freshDbFile('ppt-tables-');
  seedLeads(file);
  return { DB: fakeDb(file), _file: file };
}

function roleEnv() {
  const e = accessEnv({ ACCESS_EMAILS: OWNER });
  for (const [role, email] of Object.entries(PEOPLE)) addUser(e, email, role);
  seedLeads(e._file);
  return e;
}

// The ids a rule list selects, run for real against SQLite.
async function ids(env, rules, opts = {}) {
  const c = compileRules(cleanRules(rules), { now: NOW, ...opts });
  let stmt = env.DB.prepare(`SELECT id FROM leads WHERE ${c.sql} ${compileOrder(null)}`);
  if (c.params.length) stmt = stmt.bind(...c.params);
  return ((await stmt.all()).results || []).map((r) => r.id).sort((a, b) => a - b);
}

async function post(e, email, body) {
  const ctx = context(await asUser(email, { method: 'POST', body }), e);
  const res = await onRequestPost(ctx);
  await ctx.settle();
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(e, email, query) {
  const ctx = context(await asUser(email, { path: `/leads${query}` }), e);
  const res = await onRequestGet(ctx);
  await ctx.settle();
  return { status: res.status, text: await res.text() };
}

// The JSON payload the dashboard renders into the page.
function payload(html) {
  const m = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
}

// ------------------------------------------------------- the whitelist

test('an unknown field is refused, not ignored', () => {
  for (const field of ['notes; DROP TABLE leads', 'fields', 'referral_paid_at', '__proto__', 'constructor', '']) {
    assert.throws(() => cleanRule({ field, op: 'contains', value: 'x' }), FilterError, field);
  }
});

test('an operator the field does not have is refused', () => {
  assert.throws(() => cleanRule({ field: 'pipeline', op: 'contains', value: 'x' }), FilterError);
  assert.throws(() => cleanRule({ field: 'service', op: 'gt', value: 1 }), FilterError);
  assert.throws(() => cleanRule({ field: 'created_at', op: 'like', value: '2026-01-01' }), FilterError);
  assert.throws(() => cleanRule({ field: 'status', op: 'is_empty' }), FilterError);
  assert.throws(() => cleanRule({ field: 'text', op: 'OR 1=1 --', value: 'x' }), FilterError);
});

test('every field names a known type, and every type has operators', () => {
  for (const [k, f] of Object.entries(FIELDS)) {
    assert.ok(OPS[f.type] && OPS[f.type].length, `${k} has no operators`);
    if (f.col !== null) assert.match(f.col, /^[a-z_]+$/, `${k}'s column is a plain identifier`);
  }
});

test('bad values are refused with a message a person can act on', () => {
  const bad = [
    { field: 'pipeline', op: 'in', value: ['repair', 'wholesale'] },
    { field: 'pipeline', op: 'in', value: [] },
    { field: 'category', op: 'in', value: 'pneumatic; --' },
    { field: 'status', op: 'in', value: ['new', 'Robert"); DROP'] },
    { field: 'created_at', op: 'after', value: '2026-13-45' },
    { field: 'created_at', op: 'after', value: "2026-01-01' OR '1'='1" },
    { field: 'created_at', op: 'between', value: ['2026-10-10', '2026-10-01'] },
    { field: 'created_at', op: 'last_days', value: 0 },
    { field: 'created_at', op: 'last_days', value: '7 OR 1=1' },
    { field: 'quoted', op: 'gt', value: 'lots' },
    { field: 'quoted', op: 'gt', value: -5 },
    { field: 'has_phone', op: 'is', value: 'yes' },
    { field: 'assigned_to', op: 'is', value: 'not an email' },
    { field: 'service', op: 'contains', value: '' },
    { field: 'service', op: 'contains', value: 'x'.repeat(201) }
  ];
  for (const r of bad) {
    assert.throws(() => cleanRule(r), (e) => e instanceof FilterError && e.message.length > 5, JSON.stringify(r));
  }
  assert.throws(() => cleanRules('not a list'), FilterError);
  assert.throws(() => cleanRules(Array.from({ length: 21 }, () => ({ field: 'has_phone', op: 'is', value: true }))), FilterError);
});

test('a status must be one the business uses, when the vocabulary is given', () => {
  assert.throws(() => cleanRule({ field: 'status', op: 'in', value: ['made_up'] }, ['new', 'quoted']), FilterError);
  assert.deepStrictEqual(cleanRule({ field: 'status', op: 'in', value: ['quoted', 'quoted'] }, ['new', 'quoted']).value, ['quoted']);
});

test('columns, sort, colour and icon are checked too', () => {
  assert.throws(() => cleanTable({ name: 'x', config: { columns: ['phone', 'fields'] } }), FilterError);
  assert.throws(() => cleanTable({ name: 'x', config: { sort: { key: 'name; DROP', dir: 'asc' } } }), FilterError);
  assert.throws(() => cleanTable({ name: 'x', config: { sort: { key: 'name', dir: 'sideways' } } }), FilterError);
  assert.throws(() => cleanTable({ name: 'x', config: { color: 'url(javascript:1)' } }), FilterError);
  assert.throws(() => cleanTable({ name: 'x', config: { icon: '<img src=x onerror=alert(1)>' } }), FilterError);
  assert.throws(() => cleanTable({ name: '   ', config: {} }), FilterError);
  const t = cleanTable({ name: '  Mine  ', config: { columns: ['city', 'phone', 'city'], sort: { key: 'quoted_cents', dir: 'desc' },
    color: 'teal', icon: '★', evil: 1 } });
  assert.deepStrictEqual(t, { name: 'Mine', config: { rules: [], columns: ['city', 'phone'],
    sort: { key: 'quoted_cents', dir: 'desc' }, color: 'teal', icon: '★' } });
});

// ------------------------------------------------------- SQL safety

test('no value a rule carries ever appears in the SQL text', () => {
  const evil = "x'); DROP TABLE leads; --";
  const rules = cleanRules([
    { field: 'service', op: 'is', value: evil },
    { field: 'city', op: 'contains', value: evil },
    { field: 'source', op: 'starts_with', value: evil },
    { field: 'text', op: 'contains', value: evil },
    { field: 'assigned_to', op: 'is', value: 'a@b.c' },
    { field: 'created_at', op: 'between', value: ['2026-01-01', '2026-02-01'] },
    { field: 'quoted', op: 'between', value: [10, 20] },
    { field: 'status', op: 'not_in', value: ['new'] }
  ]);
  const c = compileRules(rules, { now: NOW });
  for (const bit of ['DROP', 'x\'', 'a@b.c', '2026-01-01', 'new']) {
    assert.ok(!c.sql.includes(bit), `"${bit}" leaked into the SQL: ${c.sql}`);
  }
  // One placeholder per parameter, and nothing else in the text but
  // identifiers from this file's constants.
  assert.strictEqual((c.sql.match(/\?/g) || []).length, c.params.length);
  assert.ok(c.params.some((p) => String(p).includes('DROP')), 'the value is passed as a parameter');
});

test('a hostile value is just text to search for', async () => {
  const env = dbEnv();
  assert.deepStrictEqual(await ids(env, [{ field: 'text', op: 'contains', value: "'; DROP TABLE leads; --" }]), []);
  assert.deepStrictEqual(await ids(env, [{ field: 'service', op: 'is', value: "x' OR '1'='1" }]), []);
  assert.strictEqual(sqlite(env._file, 'SELECT COUNT(*) AS n FROM leads')[0].n, LEADS.length, 'the table is still there');
});

test('% and _ in a search are literal characters, not wildcards', async () => {
  const env = dbEnv();
  assert.deepStrictEqual(await ids(env, [{ field: 'text', op: 'contains', value: '100%' }]), [6]);
  assert.deepStrictEqual(await ids(env, [{ field: 'text', op: 'contains', value: '%' }]), [6]);
  // As a wildcard, O_f would match "Off".
  assert.deepStrictEqual(await ids(env, [{ field: 'text', op: 'contains', value: 'O_f' }]), []);
  assert.deepStrictEqual(await ids(env, [{ field: 'text', op: 'contains', value: 'off_g' }]), [6]);
});

// ------------------------------------------------------- what rules select

test('archived leads stay out unless the table asks for them', async () => {
  const env = dbEnv();
  assert.ok(!(await ids(env, [])).includes(5));
  assert.deepStrictEqual(await ids(env, [{ field: 'archived', op: 'is', value: true }]), [5]);
  assert.ok(!(await ids(env, [{ field: 'archived', op: 'is', value: false }])).includes(5));
  assert.match(compileRules([]).sql, /archived_at IS NULL/);
});

test('each operator selects what it says', async () => {
  const env = dbEnv();
  const t = async (rule, want) => assert.deepStrictEqual(await ids(env, [rule]), want, JSON.stringify(rule));
  await t({ field: 'pipeline', op: 'in', value: ['tuning'] }, [1]);
  await t({ field: 'pipeline', op: 'not_in', value: ['tuning'] }, [2, 3, 4, 6]);
  // "not pneumatic" keeps the uncategorised lead.
  await t({ field: 'category', op: 'not_in', value: ['pneumatic'] }, [1, 2, 4, 6]);
  await t({ field: 'category', op: 'is_empty' }, [4]);
  await t({ field: 'category', op: 'not_empty' }, [1, 2, 3, 6]);
  await t({ field: 'status', op: 'in', value: ['new'] }, [1, 3, 6]);
  await t({ field: 'service', op: 'is', value: 'player repair' }, [2, 3, 4]);
  await t({ field: 'service', op: 'is_not', value: 'Player Repair' }, [1, 6]);
  await t({ field: 'service', op: 'not_contains', value: 'repair' }, [1, 6]);
  await t({ field: 'source', op: 'starts_with', value: 'Airtable:' }, [4]);
  await t({ field: 'city', op: 'contains', value: 'atl' }, [2, 4]);
  await t({ field: 'assigned_to', op: 'is', value: 'M@ppt.test' }, [1]);
  await t({ field: 'assigned_to', op: 'is_empty' }, [2, 3, 4, 6]);
  await t({ field: 'created_at', op: 'after', value: '2026-10-15' }, [3, 6]);
  await t({ field: 'created_at', op: 'before', value: '2026-10-01' }, [4]);
  await t({ field: 'created_at', op: 'between', value: ['2026-10-01', '2026-10-10'] }, [1, 2]);
  await t({ field: 'created_at', op: 'last_days', value: 10 }, [3, 6]);
  await t({ field: 'updated_at', op: 'not_empty' }, [1]);
  await t({ field: 'quoted', op: 'gte', value: 1500 }, [2, 3]);
  await t({ field: 'quoted', op: 'lt', value: 1500 }, [4]);
  await t({ field: 'quoted', op: 'between', value: [500, 1500] }, [2, 4]);
  await t({ field: 'quoted', op: 'is_empty' }, [1, 6]);
  await t({ field: 'has_phone', op: 'is', value: false }, [2]);
  await t({ field: 'has_email', op: 'is', value: false }, [3]);
  await t({ field: 'text', op: 'contains', value: 'disklavier' }, [2]);
  assert.deepStrictEqual(await ids(env, [{ field: 'assigned_to', op: 'is_me' }], { me: 'm@ppt.test' }), [1]);
  assert.deepStrictEqual(await ids(env, [{ field: 'assigned_to', op: 'is_me' }], { me: '' }), []);
});

test('rules combine with AND', async () => {
  const env = dbEnv();
  assert.deepStrictEqual(await ids(env, [
    { field: 'pipeline', op: 'in', value: ['repair'] },
    { field: 'status', op: 'in', value: ['new'] },
    { field: 'has_phone', op: 'is', value: true }
  ]), [3, 6]);
});

test('a sort is whitelisted and puts blanks last', async () => {
  const env = dbEnv();
  const order = compileOrder({ key: 'quoted_cents', dir: 'desc' });
  const got = sqlite(env._file, `SELECT id FROM leads WHERE archived_at IS NULL ${order}`).map((r) => r.id);
  assert.deepStrictEqual(got, [3, 2, 4, 6, 1]);
  assert.match(compileOrder({ key: 'nope' }), /CASE status WHEN 'new'/);
});

// ------------------------------------------------------- the seed

const seedOf = (sql) => sql.slice(sql.indexOf('INSERT INTO views (created_at, owner, name, config, sort, kind)'));

test('a fresh database starts with Tuning, Repair and Pneumatic, in that order', async () => {
  const file = freshDbFile();
  const env = { DB: fakeDb(file) };
  const tables = await listTables(env);
  assert.deepStrictEqual(tables.map((t) => t.name), ['Tuning', 'Repair', 'Pneumatic']);
  for (const t of tables) assert.strictEqual(t.broken, '', `${t.name} is a valid table`);
  // The stored config is exactly what cleanTable would write.
  const rows = sqlite(file, "SELECT name, config FROM views WHERE kind = 'table'");
  for (const r of rows) {
    assert.deepStrictEqual(cleanTable({ name: r.name, config: JSON.parse(r.config) }).config, JSON.parse(r.config));
  }
});

test('schema.sql and the migration seed the same three tables', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(ROOT, 'db/2026-10-23-custom-tables-seed.sql'), 'utf8');
  assert.strictEqual(seedOf(schema).trim(), seedOf(seed).trim());
  // The pre-deploy file must not seed: the old code would show the tables
  // as saved-view chips on every tab (review finding 9).
  const mig = fs.readFileSync(path.join(ROOT, 'db/2026-10-23-custom-tables.sql'), 'utf8');
  assert.ok(!/INSERT INTO views/.test(mig), 'the pre-deploy migration inserts no views');
});

function oldDb() {
  // The database as it was before this change: main's schema.sql.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-premig-'));
  const file = path.join(dir, 't.db');
  const old = execFileSync('git', ['show', '43ba200:db/schema.sql'], { cwd: ROOT, encoding: 'utf8' });
  execFileSync('sqlite3', [file], { input: old });
  return file;
}
const runFile = (file, rel) => execFileSync('sqlite3', ['-bail', file], {
  input: fs.readFileSync(path.join(ROOT, rel), 'utf8'), stdio: ['pipe', 'pipe', 'pipe'] });
const seed = (file) => runFile(file, 'db/2026-10-23-custom-tables-seed.sql');
// Both steps, as the owner runs them either side of the deploy.
const migrate = (file) => { runFile(file, 'db/2026-10-23-custom-tables.sql'); seed(file); };

test('the migration keeps saved views, seeds once, and fails safe when re-run', async () => {
  const file = oldDb();
  sqlite(file, `INSERT INTO views (created_at, owner, name, config, sort)
    VALUES ('2026-10-01T00:00:00Z', NULL, 'Unbilled', '{"q":"is:unbilled","tab":"referrals"}', 10)`);
  migrate(file);
  const env = { DB: fakeDb(file) };
  const views = await listViews(env);
  assert.deepStrictEqual(views.map((v) => [v.name, v.config.q, v.config.tab]), [['Unbilled', 'is:unbilled', 'referrals']]);
  assert.deepStrictEqual((await listTables(env)).map((t) => t.name), ['Tuning', 'Repair', 'Pneumatic']);
  // A second run stops at the ALTER and adds nothing; the seed adds nothing.
  assert.throws(() => runFile(file, 'db/2026-10-23-custom-tables.sql'), /duplicate column name/);
  seed(file);
  assert.strictEqual(sqlite(file, "SELECT COUNT(*) AS n FROM views WHERE kind = 'table'")[0].n, 3);
});

test('the seed is skipped when the owner already has a table', () => {
  const file = oldDb();
  execFileSync('sqlite3', [file, "ALTER TABLE views ADD COLUMN kind TEXT NOT NULL DEFAULT 'view'"]);
  sqlite(file, `INSERT INTO views (created_at, name, config, sort, kind) VALUES ('x', 'Mine', '{"rules":[]}', 10, 'table')`);
  seed(file);
  assert.deepStrictEqual(sqlite(file, "SELECT name FROM views WHERE kind = 'table'").map((r) => r.name), ['Mine']);
});

test('after the migration, every live repair lead is in exactly one of Repair and Pneumatic', async () => {
  const file = oldDb();
  const rows = [
    ['repair', 'Player Repair', 'Ampico grand', 'rolls stick', '/antique-player-piano'],
    ['repair', 'Player Repair', 'Disklavier', 'dead', '/disklavier-power-supply-repair'],
    ['repair', 'Player Repair', '', '', 'Airtable: Website'],
    ['repair', 'Player Repair', 'Ampico with a Disklavier add-on', '', '/'],
    ['repair', 'Piano Detailing', '', 'humidity damage', '/piano-cleaning #detailing-form'],
    ['tuning', 'Piano Tuning', '', '', '/tuning #tuning-booking-form']
  ];
  for (const [p, s, sys, m, src] of rows) {
    sqlite(file, `INSERT INTO leads (created_at, pipeline, status, service, system, message, source)
      VALUES ('2026-10-01T00:00:00Z', ${lit(p)}, 'new', ${lit(s)}, ${lit(sys)}, ${lit(m)}, ${lit(src)})`);
  }
  migrate(file);
  const env = { DB: fakeDb(file) };
  const tables = await listTables(env);
  const members = {};
  for (const t of tables) {
    const c = compileRules(t.config.rules, { now: NOW });
    members[t.name] = sqlite(file, `SELECT id FROM leads WHERE ${c.sql.replace(/\?/g, () => lit(c.params.shift()))}`).map((r) => r.id);
  }
  assert.deepStrictEqual(members, { Tuning: [6], Repair: [2, 3, 4, 5], Pneumatic: [1] });
  assert.deepStrictEqual(sqlite(file, 'SELECT id, category FROM leads ORDER BY id').map((r) => r.category),
    ['pneumatic', 'electronic', null, null, 'acoustic', 'tuning']);
});

test('imported Airtable leads are still never purged after the migration', async () => {
  const file = oldDb();
  sqlite(file, `INSERT INTO leads (created_at, pipeline, status, source, archived_at) VALUES
    ('2025-01-01T00:00:00Z', 'repair', 'completed', 'Airtable: Website', '2025-02-01T00:00:00Z'),
    ('2025-01-01T00:00:00Z', 'repair', 'closed', '/player-repair #diagnosis-intake', '2025-02-01T00:00:00Z')`);
  migrate(file);
  assert.strictEqual(await purgeExpired({ DB: fakeDb(file) }, '2026-01-01T00:00:00Z'), 1);
  assert.deepStrictEqual(sqlite(file, 'SELECT source FROM leads').map((r) => r.source), ['Airtable: Website']);
});

// ------------------------------------------------------- the tabs, by role

test('every role sees the table tabs, and only the owner can manage them', async () => {
  const e = roleEnv();
  for (const email of [OWNER, ...Object.values(PEOPLE)]) {
    const page = await get(e, email, '?p=all');
    assert.strictEqual(page.status, 200, email);
    for (const n of ['Tuning', 'Repair', 'Pneumatic']) assert.match(page.text, new RegExp(`data-table="\\d+">[^<]*(<span[^>]*>[^<]*</span>)?${n}</a>`), `${email} sees ${n}`);
    const d = payload(page.text);
    assert.strictEqual(!!d.tableSchema, email === OWNER, `${email} gets the editor vocabulary`);
    assert.strictEqual(/id="tablesbtn"/.test(page.text), email === OWNER, `${email} gets + Tables`);
  }
});

test('a table tab shows what its filter selects, for every role', async () => {
  const e = roleEnv();
  const tables = await listTables(e);
  const id = (n) => tables.find((t) => t.name === n).id;
  for (const email of [OWNER, ...Object.values(PEOPLE)]) {
    for (const [n, want] of [['Tuning', [1]], ['Repair', [2, 4, 6]], ['Pneumatic', [3]]]) {
      const page = await get(e, email, `?t=${id(n)}`);
      assert.strictEqual(page.status, 200);
      const d = payload(page.text);
      assert.strictEqual(d.view, 'table');
      assert.strictEqual(d.table.name, n);
      assert.deepStrictEqual(d.rows.map((r) => r.id).sort((a, b) => a - b), want, `${email} on ${n}`);
    }
  }
});

test('the quoted amount is money: a tech or viewer never receives it', async () => {
  const e = roleEnv();
  const pid = (await listTables(e)).find((t) => t.name === 'Pneumatic').id;
  const owner = payload((await get(e, OWNER, `?t=${pid}`)).text);
  assert.strictEqual(owner.rows[0].quoted_cents, 800000);
  for (const email of [PEOPLE.tech, PEOPLE.viewer]) {
    const d = payload((await get(e, email, `?t=${pid}`)).text);
    assert.ok(!('quoted_cents' in d.rows[0]), `${email} got the quote`);
  }
  // Nor in a CSV, where a viewer cannot export anyway and a manager can.
  const ctx = context(await asUser(PEOPLE.manager, { path: `/leads?t=${pid}&export=csv` }), e);
  const csv = await (await onRequestGet(ctx)).text();
  assert.match(csv.split('\r\n')[0], /quoted_cents/);
});

test('an unknown table id is a 404 page, not every lead', async () => {
  const e = roleEnv();
  for (const q of ['?t=9999', '?t=abc', '?t=1%20OR%201=1', '?t=']) {
    const page = await get(e, OWNER, q);
    assert.strictEqual(page.status, 404, q);
    assert.ok(!page.text.includes('Dana Tune'), q);
  }
});

test('only the owner may create, edit, duplicate, reorder or delete a table', async () => {
  const e = roleEnv();
  const t = (await listTables(e))[0];
  const bodies = [
    { action: 'tableSave', name: 'Mine', config: { rules: [] } },
    { action: 'tableSave', tableId: t.id, name: 'Renamed', config: t.config },
    { action: 'tableDuplicate', tableId: t.id },
    { action: 'tableOrder', order: [t.id] },
    { action: 'tableDelete', tableId: t.id }
  ];
  for (const email of Object.values(PEOPLE)) {
    for (const b of bodies) {
      const r = await post(e, email, b);
      assert.strictEqual(r.status, 403, `${email} ${b.action}`);
      assert.strictEqual(r.body.permission, 'settings.write');
    }
  }
  assert.deepStrictEqual((await listTables(e)).map((x) => x.name), ['Tuning', 'Repair', 'Pneumatic'], 'nothing changed');
});

test('the owner makes, renames, edits, duplicates, reorders and deletes tables', async () => {
  const e = roleEnv();
  const made = await post(e, OWNER, { action: 'tableSave', name: 'Big quotes',
    config: { rules: [{ field: 'quoted', op: 'gte', value: 1000 }], columns: ['quoted_cents', 'city'],
      sort: { key: 'quoted_cents', dir: 'desc' }, color: 'green', icon: '$' } });
  assert.strictEqual(made.status, 200, JSON.stringify(made.body));
  const id = made.body.table.id;
  let d = payload((await get(e, OWNER, `?t=${id}`)).text);
  assert.deepStrictEqual(d.rows.map((r) => r.id), [3, 2]);
  assert.deepStrictEqual(d.table.config.columns, ['quoted_cents', 'city']);

  const renamed = await post(e, OWNER, { action: 'tableSave', tableId: id, name: 'Quotes over $5k',
    config: { rules: [{ field: 'quoted', op: 'gt', value: 5000 }] } });
  assert.strictEqual(renamed.status, 200);
  d = payload((await get(e, OWNER, `?t=${id}`)).text);
  assert.strictEqual(d.table.name, 'Quotes over $5k');
  assert.deepStrictEqual(d.rows.map((r) => r.id), [3]);

  const dup = await post(e, OWNER, { action: 'tableDuplicate', tableId: id });
  assert.strictEqual(dup.body.table.name, 'Copy of Quotes over $5k');
  assert.deepStrictEqual(dup.body.table.config.rules, renamed.body.table.config.rules);

  const all = (await listTables(e)).map((x) => x.id);
  const reversed = [...all].reverse();
  const ord = await post(e, OWNER, { action: 'tableOrder', order: reversed });
  assert.strictEqual(ord.status, 200);
  assert.deepStrictEqual((await listTables(e)).map((x) => x.id), reversed);
  // A stale page's order (a table missing) is refused rather than half-applied.
  assert.strictEqual((await post(e, OWNER, { action: 'tableOrder', order: reversed.slice(1) })).status, 400);
  assert.strictEqual((await post(e, OWNER, { action: 'tableOrder', order: [all[0], all[0]] })).status, 400);

  assert.strictEqual((await post(e, OWNER, { action: 'tableDelete', tableId: id })).status, 200);
  assert.strictEqual((await post(e, OWNER, { action: 'tableDelete', tableId: id })).status, 400);
  assert.strictEqual((await get(e, OWNER, `?t=${id}`)).status, 404);
});

test('an unknown field or operator from the browser is a 400, and nothing is saved', async () => {
  const e = roleEnv();
  const cases = [
    { rules: [{ field: 'password', op: 'is', value: 'x' }] },
    { rules: [{ field: 'service', op: 'regex', value: '.*' }] },
    { rules: [{ field: 'status', op: 'in', value: ['not_a_status'] }] },
    { rules: [], columns: ['secret'] }
  ];
  for (const config of cases) {
    const r = await post(e, OWNER, { action: 'tableSave', name: 'Bad', config });
    assert.strictEqual(r.status, 400, JSON.stringify(config));
    assert.ok(r.body.error && !/try again/.test(r.body.error), r.body.error);
  }
  assert.strictEqual((await listTables(e)).length, 3);
});

test('saved views and tables do not touch each other', async () => {
  const e = roleEnv();
  const t = (await listTables(e))[0];
  const v = await post(e, OWNER, { action: 'viewSave', name: 'New ones', config: { q: 'is:new', tab: `t${t.id}` } });
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.body.view.config.tab, `t${t.id}`, 'a view can be filed under a table');
  // Neither delete reaches the other kind.
  assert.strictEqual((await post(e, OWNER, { action: 'viewDelete', viewId: t.id })).status, 400);
  assert.strictEqual((await post(e, OWNER, { action: 'tableDelete', tableId: v.body.view.id })).status, 400);
  assert.deepStrictEqual((await listViews(e)).map((x) => x.name), ['New ones']);
  assert.strictEqual((await listTables(e)).length, 3);
});

test('a table row that no longer checks out shows nothing, with the reason', async () => {
  const e = roleEnv();
  sqlite(e._file, `INSERT INTO views (created_at, name, config, sort, kind)
    VALUES ('x', 'Hand edited', '{"rules":[{"field":"fields","op":"contains","value":"x"}]}', 99, 'table')`);
  const t = (await listTables(e)).find((x) => x.name === 'Hand edited');
  assert.match(t.broken, /not a field/);
  const page = await get(e, OWNER, `?t=${t.id}`);
  assert.strictEqual(page.status, 200);
  assert.deepStrictEqual(payload(page.text).rows, []);
  assert.match(page.text, /no longer checks out/);
});

// ------------------------------------------------------- client and server agree

test('the client column catalog is the server whitelist', () => {
  const src = fs.readFileSync(path.join(ROOT, 'crm/columns.js'), 'utf8');
  const block = src.slice(src.indexOf('export const CATALOG = {'), src.indexOf('};', src.indexOf('export const CATALOG = {')));
  const keys = [...block.matchAll(/^\s{2}([a-z_]+): \{k:'([a-z_]+)'/gm)].map((m) => {
    assert.strictEqual(m[1], m[2], `CATALOG.${m[1]} has k '${m[2]}'`);
    return m[1];
  });
  assert.deepStrictEqual([...keys].sort(), [...TABLE_COLUMNS].sort());
});

// ------------------------------------------------------- review round 1

test('a table built on the quoted amount is closed to roles without invoices', async () => {
  const e = roleEnv();
  const byRule = (await post(e, OWNER, { action: 'tableSave', name: 'Big quotes',
    config: { rules: [{ field: 'quoted', op: 'gt', value: 1000 }] } })).body.table.id;
  const bySort = (await post(e, OWNER, { action: 'tableSave', name: 'By price',
    config: { rules: [], sort: { key: 'quoted_cents', dir: 'desc' } } })).body.table.id;
  for (const email of [PEOPLE.tech, PEOPLE.viewer]) {
    for (const id of [byRule, bySort]) {
      const page = await get(e, email, `?t=${id}`);
      assert.strictEqual(page.status, 403, `${email} on table ${id}`);
      assert.ok(!page.text.includes('Ada Ampico'));
    }
    const home = await get(e, email, '?p=all');
    const d = payload(home.text);
    assert.ok(!home.text.includes('"field":"quoted"'), `${email}'s page names a quoted rule`);
    assert.deepStrictEqual(d.tables.map((t) => t.name), ['Tuning', 'Repair', 'Pneumatic']);
    // No role but the owner is sent any table's rules at all.
    for (const t of d.tables) assert.ok(!('rules' in t.config), `${email} got ${t.name}'s rules`);
    assert.ok(!home.text.includes('Big quotes') && !home.text.includes('By price'), `${email} sees a money tab`);
  }
  // The manager has invoices.read: they may open both, and get no rules.
  const m = await get(e, PEOPLE.manager, `?t=${byRule}`);
  assert.strictEqual(m.status, 200);
  assert.ok(!('rules' in payload(m.text).table.config));
  // The CSV is closed the same way.
  const ctx = context(await asUser(PEOPLE.viewer, { path: `/leads?t=${byRule}&export=csv` }), e);
  assert.strictEqual((await onRequestGet(ctx)).status, 403);
});

test('a filter that would bind more parameters than D1 allows is refused', () => {
  const search = { field: 'text', op: 'contains', value: 'x' };
  assert.strictEqual(paramCount(cleanRules([search])), 9);
  assert.throws(() => cleanRules(Array.from({ length: 11 }, () => search)), FilterError);
  const many = { field: 'status', op: 'in', value: Array.from({ length: 20 }, (_, i) => 's' + String.fromCharCode(97 + i)) };
  assert.throws(() => cleanRules(Array.from({ length: 5 }, () => many)), FilterError);
  // The count matches what compileRules actually binds, for every shape.
  const rules = cleanRules([search, many,
    { field: 'created_at', op: 'between', value: ['2026-01-01', '2026-02-01'] },
    { field: 'quoted', op: 'between', value: [1, 2] }, { field: 'city', op: 'is', value: 'x' },
    { field: 'has_phone', op: 'is', value: true }, { field: 'category', op: 'is_empty' },
    { field: 'assigned_to', op: 'is_me' }]);
  assert.strictEqual(compileRules(rules, { me: 'a@b.c' }).params.length, paramCount(rules));
  assert.ok(paramCount(rules) <= LIMITS.params);
});

test('saved views still save, edit and delete on a database not yet migrated', async () => {
  const file = oldDb();
  const env = { DB: fakeDb(file) };
  const made = await saveView(env, { name: 'Mine', config: { q: 'is:new' }, owner: 'o@x' }, 'now');
  assert.ok(made.view, JSON.stringify(made));
  const edited = await saveView(env, { id: made.view.id, name: 'Renamed', config: { q: 'is:new' } }, 'now');
  assert.strictEqual(edited.view.name, 'Renamed');
  assert.deepStrictEqual((await listViews(env)).map((v) => v.name), ['Renamed']);
  assert.deepStrictEqual(await deleteView(env, made.view.id), { deleted: made.view.id });
  assert.deepStrictEqual(await listTables(env), []);
});

test('the Category column appears as soon as the migration lands, without a restart', async () => {
  const e = roleEnv();
  const cols = sqlite(e._file, "SELECT name FROM pragma_table_info('leads')").map((r) => r.name).filter((n) => n !== 'category');
  sqlite(e._file, `CREATE TABLE l2 AS SELECT ${cols.join(', ')} FROM leads; DROP TABLE leads; ALTER TABLE l2 RENAME TO leads;`);
  const before = payload((await get(e, OWNER, '?p=all')).text);
  assert.ok(before.rows.length > 0);
  assert.ok(!('category' in before.rows[0]));
  sqlite(e._file, 'ALTER TABLE leads ADD COLUMN category TEXT');
  const after = payload((await get(e, OWNER, '?p=all')).text);
  assert.ok('category' in after.rows[0], 'the same env.DB now gets the column');
});
