// The server enforces roles; hiding a button is only a courtesy.
//
// These drive the real /leads handlers with real Access tokens against a
// real SQLite database, one role at a time, and check that what a role may
// not do comes back 403 -- JSON for the API, a page for HTML -- and changes
// nothing.

// Node 18+ globals; the lint config only lists the older ones.
/* global Request */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  onRequestGet, onRequestPost, ACTION_PERMS, BULK_PERMS, VIEW_PERMS, permissionFor
} from '../functions/leads.js';
import { BULK_OPS } from '../functions/_lib/bulk.js';
import { VIEWS } from '../functions/_lib/grid.js';
import { PERMISSIONS } from '../functions/_lib/roles.js';
import { ROOT, sqlite, accessEnv, addUser, asUser, installFetch, context } from './fixtures/harness.mjs';

test.before(installFetch);

const OWNER = 'boss@ppt.test';
const PEOPLE = { manager: 'm@ppt.test', tech: 't@ppt.test', viewer: 'v@ppt.test' };

function env() {
  const e = accessEnv({ ACCESS_EMAILS: OWNER });
  for (const [role, email] of Object.entries(PEOPLE)) addUser(e, email, role);
  sqlite(e._file, `INSERT INTO leads (id, created_at, pipeline, status, name)
    VALUES (1, '2026-10-01T00:00:00.000Z', 'tuning', 'new', 'Dana')`);
  return e;
}

async function post(e, email, body) {
  const ctx = context(await asUser(email, { method: 'POST', body }), e);
  const res = await onRequestPost(ctx);
  await ctx.settle();
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(e, email, query = '') {
  const ctx = context(await asUser(email, { path: `/leads${query}` }), e);
  const res = await onRequestGet(ctx);
  await ctx.settle();
  return { status: res.status, type: res.headers.get('Content-Type') || '', text: await res.text() };
}

// ------------------------------------------------- every route is mapped

test('every POST action leads.js handles names a permission', () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');
  const handled = new Set([...src.matchAll(/body\.action === '([a-zA-Z]+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/\[([^\]]*)\]\.includes\(body\.action\)/g)) {
    for (const a of m[1].matchAll(/'([a-zA-Z]+)'/g)) handled.add(a[1]);
  }
  assert.ok(handled.size > 15, 'the scan found the actions');
  for (const a of handled) {
    if (a === 'bulk') continue;
    assert.ok(ACTION_PERMS[a], `action '${a}' has no entry in ACTION_PERMS`);
  }
  for (const op of BULK_OPS) assert.ok(BULK_PERMS[op], `bulk op '${op}' has no permission`);
});

test('every tab names a permission, and every permission named exists', () => {
  for (const v of Object.keys(VIEWS)) assert.ok(VIEW_PERMS[v], `tab '${v}' has no permission`);
  for (const p of [...Object.values(ACTION_PERMS), ...Object.values(BULK_PERMS), ...Object.values(VIEW_PERMS)]) {
    assert.ok(PERMISSIONS.includes(p), `${p} is not a permission`);
  }
});

test('an action nobody mapped is refused, not let through', () => {
  assert.strictEqual(permissionFor({ action: 'dropTables' }), '');
  assert.strictEqual(permissionFor({ action: 'bulk', op: 'purge' }), '');
  assert.strictEqual(permissionFor({ action: 'constructor' }), '');
  assert.strictEqual(permissionFor(null), '');
});

// ------------------------------------------------------ who gets in at all

test('an unknown email gets the no-access page, and 403 JSON from the API', async () => {
  const e = env();
  const page = await get(e, 'stranger@example.com');
  assert.strictEqual(page.status, 403);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /You don&#39;t have access|You don't have access/);
  assert.match(page.text, /Ask the owner to add you/);
  assert.ok(!page.text.includes('Dana'), 'no customer data on the refusal page');

  const api = await post(e, 'stranger@example.com', { action: 'record', id: 1 });
  assert.strictEqual(api.status, 403);
  assert.match(api.body.error, /ask the owner to add you/);
});

test('a deactivated user gets the same refusal', async () => {
  const e = env();
  sqlite(e._file, `UPDATE users SET active = 0 WHERE email = '${PEOPLE.tech}'`);
  assert.strictEqual((await get(e, PEOPLE.tech)).status, 403);
  assert.strictEqual((await post(e, PEOPLE.tech, { action: 'record', id: 1 })).status, 403);
});

test('the ACCESS_EMAILS owner opens the dashboard with no users row', async () => {
  const page = await get(env(), OWNER, '?p=tuning');
  assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes('Dana'));
  assert.match(page.text, /class="whoami/);
  assert.match(page.text, /Owner/);
});

// ------------------------------------------------------------- the tabs

test('tabs each role may not open come back as a 403 page', async () => {
  const e = env();
  const cases = [
    ['tech', '?p=invoices'], ['tech', '?p=emails'], ['tech', '?p=users'],
    ['viewer', '?p=invoices'], ['viewer', '?p=users'], ['manager', '?p=users'],
    ['tech', '?p=repair&export=csv'], ['viewer', '?p=all&export=csv']
  ];
  for (const [role, q] of cases) {
    const r = await get(e, PEOPLE[role], q);
    assert.strictEqual(r.status, 403, `${role} ${q}`);
    assert.match(r.type, /text\/html/);
    assert.match(r.text, /Not for your role/);
  }
});

test('tabs each role may open do open', async () => {
  const e = env();
  for (const [who, q] of [[PEOPLE.viewer, '?p=tuning'], [PEOPLE.tech, '?p=archive'],
    [PEOPLE.manager, '?p=invoices'], [OWNER, '?p=users']]) {
    assert.strictEqual((await get(e, who, q)).status, 200, `${who} ${q}`);
  }
});

test('the tab strip leaves out what the role cannot open', async () => {
  const e = env();
  const tech = (await get(e, PEOPLE.tech)).text;
  assert.ok(!tech.includes('href="/leads?p=invoices"'));
  assert.ok(!tech.includes('href="/leads?p=users"'));
  assert.ok(!tech.includes('id="newlead"'), 'a tech does not create leads');
  assert.ok(!tech.includes('export=csv'));
  const owner = (await get(e, OWNER)).text;
  assert.ok(owner.includes('href="/leads?p=users"'));
});

test('only a role with settings.write is shown the calendar feed address', async () => {
  const e = env();
  sqlite(e._file, "INSERT INTO settings (key, value) VALUES ('calendar_token', 'SECRET-FEED-TOKEN')");
  assert.ok(!(await get(e, PEOPLE.manager)).text.includes('SECRET-FEED-TOKEN'));
  assert.ok(!(await get(e, PEOPLE.tech)).text.includes('SECRET-FEED-TOKEN'));
});

// ------------------------------------------------------------ the API

test('representative actions return 403 per role and change nothing', async () => {
  const e = env();
  const refused = [
    ['viewer', { action: 'update', id: 1, field: 'status', value: 'waiting' }],
    ['viewer', { action: 'activity', id: 1, type: 'note', body: 'hi' }],
    ['viewer', { action: 'refer', id: 1, manual: true }],
    ['viewer', { action: 'outreachSend', id: 1 }],
    ['tech', { action: 'invoice', billTo: 'X', email: 'x@y.co' }],
    ['tech', { action: 'void', id: 1 }],
    ['tech', { action: 'paid', id: 1, paid: true }],
    ['tech', { action: 'create', pipeline: 'repair', name: 'New' }],
    ['tech', { action: 'archive', id: 1 }],
    ['tech', { action: 'bulk', op: 'archive', ids: [1] }],
    ['tech', { action: 'refer', id: 1, manual: true }],
    ['tech', { action: 'activityDelete', activityId: 1 }],
    ['tech', { action: 'userCreate', email: 'x@y.co', role: 'owner' }],
    ['manager', { action: 'userCreate', email: 'x@y.co', role: 'owner' }],
    ['manager', { action: 'userUpdate', email: PEOPLE.manager, role: 'owner' }],
    ['manager', { action: 'calendarOn' }],
    ['manager', { action: 'viewSave', name: 'Mine', config: {} }]
  ];
  const before = sqlite(e._file, 'SELECT * FROM leads');
  for (const [role, body] of refused) {
    const r = await post(e, PEOPLE[role], body);
    assert.strictEqual(r.status, 403, `${role} ${body.action}${body.op ? ' ' + body.op : ''}`);
    assert.match(r.body.error, /can't do that/);
  }
  assert.deepStrictEqual(sqlite(e._file, 'SELECT * FROM leads'), before);
  assert.strictEqual(sqlite(e._file, 'SELECT COUNT(*) AS n FROM users')[0].n, 3);
  assert.strictEqual(sqlite(e._file, 'SELECT role FROM users WHERE email = \'m@ppt.test\'')[0].role, 'manager');
});

test('what each role may do goes through', async () => {
  const e = env();
  assert.strictEqual((await post(e, PEOPLE.viewer, { action: 'record', id: 1 })).status, 200);
  assert.strictEqual((await post(e, PEOPLE.tech,
    { action: 'update', id: 1, field: 'status', value: 'waiting' })).status, 200);
  assert.strictEqual((await post(e, PEOPLE.tech,
    { action: 'activity', id: 1, type: 'note', body: 'Tuned it' })).status, 200);
  assert.strictEqual((await post(e, PEOPLE.manager,
    { action: 'create', pipeline: 'repair', name: 'Walk-in' })).status, 200);
  assert.strictEqual((await post(e, PEOPLE.manager, { action: 'archive', id: 1 })).status, 200);
  const added = await post(e, OWNER, { action: 'userCreate', email: 'New@PPT.test', name: 'New', role: 'viewer' });
  assert.strictEqual(added.status, 200);
  assert.ok(added.body.users.some((u) => u.email === 'new@ppt.test' && u.role === 'viewer'));
});

test('a viewer opening a record does not see the invoices on it', async () => {
  const e = env();
  sqlite(e._file, `INSERT INTO invoices (created_at, kind, lead_id, amount_cents, status)
    VALUES ('2026-10-02T00:00:00.000Z', 'custom', 1, 50000, 'open')`);
  assert.strictEqual((await post(e, PEOPLE.viewer, { action: 'record', id: 1 })).body.record.invoices.length, 0);
  assert.strictEqual((await post(e, PEOPLE.manager, { action: 'record', id: 1 })).body.record.invoices.length, 1);
});

test('the owner cannot demote the last owner through the API either', async () => {
  const e = accessEnv({ ACCESS_EMAILS: '' });
  addUser(e, 'only@ppt.test', 'owner');
  const r = await post(e, 'only@ppt.test', { action: 'userUpdate', email: 'only@ppt.test', role: 'manager' });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /nobody as an active owner/);
});

test('the password session is the owner on the API', async () => {
  const { mintToken, COOKIE } = await import('../functions/_lib/auth.js');
  const e = env();
  delete e.ACCESS_TEAM_DOMAIN;
  e.ADMIN_PASSWORD = 'pw-for-tests';
  const req = new Request('https://pianoplayertech.com/leads', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://pianoplayertech.com',
      Cookie: `${COOKIE}=${await mintToken('pw-for-tests')}` },
    body: JSON.stringify({ action: 'userCreate', email: 'pat@ppt.test', role: 'tech' }) });
  const ctx = context(req, e);
  const res = await onRequestPost(ctx);
  await ctx.settle();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(sqlite(e._file, "SELECT created_by FROM users WHERE email = 'pat@ppt.test'")[0].created_by, 'admin');
});

// ------------------------------------------------- fix round 1 (review)

const TABLES = ['leads', 'users', 'activities', 'settings', 'views', 'invoices', 'outreach'];
const snapshot = (e) => Object.fromEntries(TABLES.map((t) => [t, sqlite(e._file, `SELECT * FROM ${t}`)]));

test('every action, for every role without its permission, is 403 and changes nothing', async () => {
  const { can } = await import('../functions/_lib/roles.js');
  const e = env();
  sqlite(e._file, `INSERT INTO activities (created_at, lead_id, type, body) VALUES ('2026-10-02T00:00:00.000Z', 1, 'note', 'hi')`);
  sqlite(e._file, `INSERT INTO views (created_at, name, config) VALUES ('2026-10-02T00:00:00.000Z', 'Mine', '{}')`);
  const before = snapshot(e);
  const base = { id: 1, activityId: 1, viewId: 1, email: PEOPLE.viewer, role: 'owner', active: false,
    field: 'status', value: 'waiting', type: 'note', body: 'x', name: 'x', pipeline: 'repair',
    billTo: 'X', manual: true, paid: true, ids: [1], config: {}, kind: 'quote_checkin' };
  let checked = 0;
  for (const role of ['manager', 'tech', 'viewer']) {
    const bodies = [
      ...Object.keys(ACTION_PERMS).map((action) => [ACTION_PERMS[action], { ...base, action }]),
      ...Object.keys(BULK_PERMS).map((op) => [BULK_PERMS[op], { ...base, action: 'bulk', op }])
    ];
    for (const [perm, body] of bodies) {
      if (can(role, perm)) continue;
      const r = await post(e, PEOPLE[role], body);
      assert.strictEqual(r.status, 403, `${role} ${body.action}${body.action === 'bulk' ? ' ' + body.op : ''}`);
      checked++;
    }
  }
  assert.ok(checked > 40, `checked ${checked}`);
  assert.deepStrictEqual(snapshot(e), before);
});

test('nobody can delete or tick the user-change trail, owner included', async () => {
  const e = env();
  const add = await post(e, OWNER, { action: 'userCreate', email: 'pat@ppt.test', role: 'tech' });
  assert.strictEqual(add.status, 200);
  const [row] = sqlite(e._file, "SELECT id FROM activities WHERE json_extract(meta, '$.area') = 'users'");
  for (const who of [PEOPLE.manager, OWNER]) {
    assert.strictEqual((await post(e, who, { action: 'activityDelete', activityId: row.id })).status, 404);
  }
  const tick = await post(e, PEOPLE.tech, { action: 'activityDone', activityId: row.id, done: true });
  assert.strictEqual(tick.status, 404);
  assert.ok(!JSON.stringify(tick.body).includes('pat@ppt.test'), 'nothing of the row comes back');
  const after = sqlite(e._file, `SELECT * FROM activities WHERE id = ${row.id}`)[0];
  assert.ok(after, 'still there');
  assert.strictEqual(after.completed_at, null);
});

test('ticking a follow-up returns only what the client needs, and not on an archived lead', async () => {
  const e = env();
  sqlite(e._file, `INSERT INTO leads (id, created_at, pipeline, status, name, archived_at)
    VALUES (2, '2026-10-01T00:00:00.000Z', 'tuning', 'new', 'Gone', '2026-10-05T00:00:00.000Z')`);
  sqlite(e._file, `INSERT INTO activities (id, created_at, lead_id, type, body, due_at) VALUES
    (50, '2026-10-02T00:00:00.000Z', 1, 'followup', 'secret-body', '2026-10-09T00:00:00.000Z'),
    (51, '2026-10-02T00:00:00.000Z', 2, 'followup', 'old', '2026-10-09T00:00:00.000Z')`);
  const ok = await post(e, PEOPLE.tech, { action: 'activityDone', activityId: 50, done: true });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(Object.keys(ok.body.activity).sort(), ['completed_at', 'id', 'lead_id']);
  assert.strictEqual((await post(e, PEOPLE.tech, { action: 'activityDone', activityId: 51, done: true })).status, 404);
  assert.strictEqual((await post(e, OWNER, { action: 'activityDelete', activityId: 51 })).status, 404);
});

test('a tech cannot change a referral outcome or clear its paid mark', async () => {
  const e = env();
  sqlite(e._file, `UPDATE leads SET referred_at = '2026-10-01T00:00:00.000Z', referral_status = 'booked',
    referral_paid_at = '2026-10-05T00:00:00.000Z' WHERE id = 1`);
  for (const value of ['sent', 'no_booking', 'booked']) {
    const r = await post(e, PEOPLE.tech, { action: 'update', id: 1, field: 'referral_status', value });
    assert.strictEqual(r.status, 403, value);
  }
  const row = sqlite(e._file, 'SELECT referral_status, referral_paid_at FROM leads WHERE id = 1')[0];
  assert.deepStrictEqual(row, { referral_status: 'booked', referral_paid_at: '2026-10-05T00:00:00.000Z' });
  assert.strictEqual((await post(e, PEOPLE.manager,
    { action: 'update', id: 1, field: 'referral_status', value: 'sent' })).status, 200);
});

test('a POST must come from our own page, as JSON', async () => {
  const e = env();
  const token = (await asUser(PEOPLE.manager)).headers.get('Cf-Access-Jwt-Assertion');
  const send = async (headers, ct = 'application/json') => {
    const req = new Request('https://pianoplayertech.com/leads', { method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': token, 'Content-Type': ct, ...headers },
      body: JSON.stringify({ action: 'record', id: 1 }) });
    const ctx = context(req, e);
    const res = await onRequestPost(ctx);
    await ctx.settle();
    return res.status;
  };
  assert.strictEqual(await send({}), 403, 'no Origin, no Referer, no Sec-Fetch-Site');
  assert.strictEqual(await send({ Origin: 'https://evil.example' }), 403);
  assert.strictEqual(await send({ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://pianoplayertech.com' }), 403);
  assert.strictEqual(await send({ 'Sec-Fetch-Site': 'same-site' }), 403);
  assert.strictEqual(await send({ Referer: 'https://evil.example/x' }), 403);
  assert.strictEqual(await send({ Origin: 'https://pianoplayertech.com' }, 'text/plain'), 415);
  assert.strictEqual(await send({ Origin: 'https://pianoplayertech.com' }), 200);
  assert.strictEqual(await send({ Referer: 'https://pianoplayertech.com/leads' }), 200);
  assert.strictEqual(await send({ 'Sec-Fetch-Site': 'same-origin' }), 200);
});

test('a bulk op named after an Object.prototype member is unknown, not a permission', async () => {
  for (const op of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(permissionFor({ action: 'bulk', op }), '');
  }
  assert.strictEqual((await post(env(), OWNER, { action: 'bulk', op: 'constructor', ids: [1] })).status, 400);
});

function payload(html) {
  const m = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  return JSON.parse(m[1]);
}

test('without invoices.read, rows, records and stats carry no referral payment data', async () => {
  const e = env();
  sqlite(e._file, `UPDATE leads SET referred_at = '2026-10-01T00:00:00.000Z', referral_status = 'booked',
    referral_paid_at = '2026-10-05T00:00:00.000Z', referral_invoice_id = 7 WHERE id = 1`);
  for (const role of ['tech', 'viewer']) {
    const d = payload((await get(e, PEOPLE[role], '?p=referrals')).text);
    assert.strictEqual(d.rows.length, 1);
    assert.ok(!('referral_paid_at' in d.rows[0]) && !('referral_invoice_id' in d.rows[0]), role);
    assert.strictEqual(d.ref.paid, 0);
    const rec = (await post(e, PEOPLE[role], { action: 'record', id: 1 })).body.record;
    assert.ok(!('referral_paid_at' in rec.lead) && !('referral_invoice_id' in rec.lead), role);
  }
  const d = payload((await get(e, PEOPLE.manager, '?p=referrals')).text);
  assert.strictEqual(d.rows[0].referral_paid_at, '2026-10-05T00:00:00.000Z');
  assert.strictEqual(d.ref.paid, 1);
});

test('a database hiccup on the users lookup is "try again", not "ask the owner"', async () => {
  const e = env();
  const real = e.DB;
  e.DB = { batch: real.batch, prepare(sql) {
    const st = real.prepare(sql);
    if (/FROM users WHERE email = \?/.test(sql)) st.first = async () => { throw new Error('D1_ERROR: overloaded'); };
    return st;
  } };
  const page = await get(e, PEOPLE.tech);
  assert.strictEqual(page.status, 503);
  assert.match(page.text, /Try again in a moment/);
  const api = await post(e, PEOPLE.tech, { action: 'record', id: 1 });
  assert.strictEqual(api.status, 503);
  assert.match(api.body.error, /Try again/);
  // The ACCESS_EMAILS owner is not held up by it.
  assert.strictEqual((await get(e, OWNER)).status, 200);
});

test('before the migration: owners and the password get in, the Users tab says what to do, others are refused', async () => {
  const e = env();
  sqlite(e._file, 'DROP TABLE users');
  assert.strictEqual((await get(e, OWNER)).status, 200);
  assert.strictEqual((await post(e, OWNER, { action: 'record', id: 1 })).status, 200);
  const tab = await get(e, OWNER, '?p=users');
  assert.strictEqual(tab.status, 200);
  assert.match(payload(tab.text).usersError, /Apply db\/2026-10-18-users\.sql/);
  const add = await post(e, OWNER, { action: 'userCreate', email: 'pat@ppt.test', role: 'tech' });
  assert.strictEqual(add.status, 500);
  assert.match(add.body.error, /Apply db\/2026-10-18-users\.sql/);
  const stranger = await get(e, PEOPLE.tech);
  assert.strictEqual(stranger.status, 403);
  assert.match(stranger.text, /Ask the owner to add you/);

  const { mintToken, COOKIE } = await import('../functions/_lib/auth.js');
  delete e.ACCESS_TEAM_DOMAIN;
  e.ADMIN_PASSWORD = 'pw-for-tests';
  const cookie = `${COOKIE}=${await mintToken('pw-for-tests')}`;
  const g = context(new Request('https://pianoplayertech.com/leads', { headers: { Cookie: cookie } }), e);
  assert.strictEqual((await onRequestGet(g)).status, 200);
  await g.settle();
  const p = context(new Request('https://pianoplayertech.com/leads', { method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://pianoplayertech.com' },
    body: JSON.stringify({ action: 'record', id: 1 }) }), e);
  assert.strictEqual((await onRequestPost(p)).status, 200);
  await p.settle();
});
