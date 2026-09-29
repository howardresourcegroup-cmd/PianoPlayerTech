// Automated emails.
//
// The ways this turns bad: someone gets an email they should not have --
// after unsubscribing, twice, from a lead closed years ago, mid-conversation
// -- or the owner is told an email went when it did not. Most of these tests
// are about who does NOT get written to.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KINDS, DEFAULT_CONFIG, DAILY_CAP, cleanConfig, saveConfig, loadConfig, normEmail, fill, dueFor,
  unsubToken, unsubValid, unsubUrl, unsubscribe, isUnsubscribed,
  renderEmail, draftDue, sendOne, skipOne, runOutreach, loadQueue
} from '../functions/_lib/outreach.js';
import { onRequestGet as unsubGet, onRequestPost as unsubPost } from '../functions/unsubscribe.js';

const { Request, FormData } = globalThis;
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

const NOW = '2026-10-10T12:00:00.000Z';
const ago = (days) => new Date(Date.parse(NOW) - days * 86400000).toISOString();
const ORIGIN = 'https://pianoplayertech.com';
const ADDRESS = 'PO Box 1, Testville, GA 30000';

function freshEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-outreach-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  return { DB: fakeDb(file), _file: file, RESEND_API_KEY: 'test-key', ...extra };
}

let nextId = 1;
function addLead(env, over = {}) {
  const l = { id: nextId++, created_at: ago(40), updated_at: ago(40), pipeline: 'repair', status: 'new',
    name: 'Dana Reyes', email: 'dana@example.com', system: 'Disklavier Mark III', ...over };
  const keys = Object.keys(l);
  sqlite(env._file, `INSERT INTO leads (${keys.join(',')}) VALUES (${keys.map((k) => lit(l[k])).join(',')})`);
  return l;
}
function addActivity(env, leadId, type, at, meta) {
  sqlite(env._file, `INSERT INTO activities (created_at, lead_id, type, meta) VALUES (${lit(at)}, ${leadId}, ${lit(type)}, ${lit(meta ? JSON.stringify(meta) : null)})`);
}
const became = (env, leadId, status, at) => addActivity(env, leadId, 'status', at, { field: 'status', to: status });
const rows = (env) => sqlite(env._file, 'SELECT * FROM outreach ORDER BY id');

async function withResend(respond, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return respond(); };
  try { return { out: await fn(), calls }; } finally { globalThis.fetch = real; }
}
const OK = () => new Response('{}', { status: 200 });

const cfg = (over = {}) => cleanConfig({ ...DEFAULT_CONFIG, address: ADDRESS, ...over });
const facts = (statusAt = {}, lastTouchAt = '') => ({ statusAt, lastTouchAt });

// ------------------------------------------------------------------ config
test('every kind starts by asking first, and with no address', () => {
  const c = cleanConfig(DEFAULT_CONFIG);
  assert.strictEqual(c.address, '');
  for (const k of KINDS) assert.strictEqual(c.kinds[k].mode, 'ask');
});

test('a config from the browser keeps only what we know, within limits', () => {
  const c = cleanConfig({
    address: '  1 Main St  ', evil: '<script>', sender: '',
    kinds: { quote_checkin: { mode: 'always', delay: 9999, subject: 'a\nb', body: '' }, bogus: { mode: 'auto' } }
  });
  assert.strictEqual(c.address, '1 Main St');
  assert.strictEqual(c.evil, undefined);
  assert.strictEqual(c.sender, 'PianoPlayerTech');
  assert.strictEqual(c.kinds.quote_checkin.mode, 'ask');
  assert.strictEqual(c.kinds.quote_checkin.delay, 30);
  assert.strictEqual(c.kinds.quote_checkin.subject, 'a b');
  assert.strictEqual(c.kinds.quote_checkin.body, DEFAULT_CONFIG.kinds.quote_checkin.body);
  assert.deepStrictEqual(Object.keys(c.kinds), KINDS);
});

test('a saved config comes back as saved, and junk in storage falls back to defaults', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg({ sender: 'Ethan' }), NOW);
  assert.strictEqual((await loadConfig(env)).sender, 'Ethan');
  sqlite(env._file, `UPDATE settings SET value = '{not json' WHERE key = 'outreach_config'`);
  assert.strictEqual((await loadConfig(env)).address, '');
});

// ------------------------------------------------------------------ addresses and wording
test('an address with markup, spaces or a second address in it is not an address', () => {
  assert.strictEqual(normEmail(' Dana@Example.COM '), 'dana@example.com');
  for (const bad of ['', 'dana', 'a@b', 'a b@x.com', '<a@x.com>', 'a@x.com, b@y.com', 'a@x.com\nBcc: b@y.com']) {
    assert.strictEqual(normEmail(bad), '', JSON.stringify(bad));
  }
});

test('wording is filled from the lead, with sensible words when the lead is bare', () => {
  const c = cfg({ sender: 'Ethan' });
  assert.strictEqual(fill('Hi {first_name}, your {instrument}. {sender}', { name: 'Dana Reyes', system: 'Ampico' }, c),
    'Hi Dana, your Ampico. Ethan');
  assert.strictEqual(fill('Hi {first_name}, your {instrument}.', { pipeline: 'tuning' }, c), 'Hi there, your piano.');
  assert.strictEqual(fill('{instrument}', { pipeline: 'repair', piano_make: 'Yamaha', piano_model: 'C3' }, c), 'Yamaha C3');
  assert.strictEqual(fill('{unknown} {first_name}', { name: 'Dana' }, c), '{unknown} Dana');
});

// ------------------------------------------------------------------ quote check-in
const quoted = (over = {}) => ({ id: 1, status: 'quoted', pipeline: 'repair', email: 'dana@example.com', updated_at: ago(5), ...over });

test('a quote that has been quiet for four days is due a check-in', () => {
  assert.deepStrictEqual(dueFor(quoted(), facts({ quoted: ago(5) }), cfg(), NOW), [{ kind: 'quote_checkin', cycle: '' }]);
});

test('a quote sent yesterday is not due yet', () => {
  assert.deepStrictEqual(dueFor(quoted(), facts({ quoted: ago(1) }), cfg(), NOW), []);
});

test('a conversation since the quote cancels the check-in', () => {
  assert.deepStrictEqual(dueFor(quoted(), facts({ quoted: ago(5) }, ago(2)), cfg(), NOW), []);
});

test('a conversation before the quote does not', () => {
  assert.strictEqual(dueFor(quoted(), facts({ quoted: ago(5) }, ago(9)), cfg(), NOW).length, 1);
});

test('a lead that has moved on from quoted gets no check-in', () => {
  assert.deepStrictEqual(dueFor(quoted({ status: 'lost' }), facts({ quoted: ago(5) }), cfg(), NOW), []);
});

test('a quote from long ago is left alone', () => {
  assert.deepStrictEqual(dueFor(quoted(), facts({ quoted: ago(60) }), cfg(), NOW), []);
});

// ------------------------------------------------------------------ review request
test('a job finished two days ago is due a review request, and one finished months ago is not', () => {
  const done = { id: 2, status: 'completed', pipeline: 'repair', email: 'dana@example.com', updated_at: ago(2) };
  assert.deepStrictEqual(dueFor(done, facts({ completed: ago(2) }), cfg(), NOW), [{ kind: 'review_request', cycle: '' }]);
  assert.deepStrictEqual(dueFor(done, facts({ completed: ago(90) }), cfg(), NOW), []);
});

test('being marked paid later does not restart the clock on a review request', () => {
  const paid = { id: 3, status: 'paid', pipeline: 'repair', email: 'dana@example.com', updated_at: ago(1) };
  // Completed 90 days ago, paid yesterday: the moment to ask has passed.
  assert.deepStrictEqual(dueFor(paid, facts({ completed: ago(90), paid: ago(1) }), cfg(), NOW), []);
});

// ------------------------------------------------------------------ tuning reminder
const tuned = (over = {}) => ({ id: 4, status: 'booked', pipeline: 'tuning', referral_status: 'booked',
  email: 'dana@example.com', updated_at: ago(370), ...over });

test('a tuning a year ago is due a reminder, in its first cycle', () => {
  assert.deepStrictEqual(dueFor(tuned({ referred_at: ago(370) }), facts(), cfg(), NOW), [{ kind: 'tuning_reminder', cycle: '1' }]);
});

test('two years on it is a second cycle, so it can be sent again', () => {
  assert.deepStrictEqual(dueFor(tuned({ referred_at: ago(735) }), facts(), cfg(), NOW), [{ kind: 'tuning_reminder', cycle: '2' }]);
});

test('a tuning six months ago, or eighteen, is not due', () => {
  assert.deepStrictEqual(dueFor(tuned({ referred_at: ago(180) }), facts(), cfg(), NOW), []);
  assert.deepStrictEqual(dueFor(tuned({ referred_at: ago(540) }), facts(), cfg(), NOW), []);
});

test('a referral that was never booked gets no reminder', () => {
  assert.deepStrictEqual(dueFor(tuned({ referral_status: 'no_booking', referred_at: ago(370) }), facts(), cfg(), NOW), []);
});

test('a repair lead gets no tuning reminder', () => {
  const r = tuned({ pipeline: 'repair', status: 'paid', referred_at: ago(370) });
  assert.ok(!dueFor(r, facts({ completed: ago(370) }), cfg(), NOW).some((d) => d.kind === 'tuning_reminder'));
});

// ------------------------------------------------------------------ who is never written to
test('an archived lead, a lead with no usable address, and a switched-off kind are all skipped', () => {
  const f = facts({ quoted: ago(5) });
  assert.deepStrictEqual(dueFor(quoted({ archived_at: ago(1) }), f, cfg(), NOW), []);
  assert.deepStrictEqual(dueFor(quoted({ email: '' }), f, cfg(), NOW), []);
  assert.deepStrictEqual(dueFor(quoted({ email: 'not an address' }), f, cfg(), NOW), []);
  const off = cfg(); off.kinds.quote_checkin.mode = 'off';
  assert.deepStrictEqual(dueFor(quoted(), f, off, NOW), []);
});

// ------------------------------------------------------------------ unsubscribe
test('the token fits its own address and no other', async () => {
  const env = freshEnv();
  const t = await unsubToken(env, 'Dana@Example.com');
  assert.ok(t.length > 20);
  assert.strictEqual(await unsubValid(env, 'dana@example.com', t), true);
  assert.strictEqual(await unsubValid(env, 'sam@example.com', t), false);
  assert.strictEqual(await unsubValid(env, 'dana@example.com', t.slice(0, -1) + 'x'), false);
  assert.strictEqual(await unsubValid(env, 'dana@example.com', ''), false);
});

test('a token made by one installation does not work on another', async () => {
  const a = freshEnv(); const b = freshEnv();
  assert.strictEqual(await unsubValid(b, 'dana@example.com', await unsubToken(a, 'dana@example.com')), false);
});

test('opening the link changes nothing; pressing the button unsubscribes', async () => {
  const env = freshEnv();
  const url = await unsubUrl(env, ORIGIN, 'dana@example.com');
  const got = await unsubGet({ request: new Request(url), env });
  assert.strictEqual(got.status, 200);
  assert.match(await got.text(), /Yes, unsubscribe me/);
  assert.strictEqual(await isUnsubscribed(env, 'dana@example.com'), false);

  const u = new URL(url);
  const form = new FormData(); form.append('e', u.searchParams.get('e')); form.append('t', u.searchParams.get('t'));
  const posted = await unsubPost({ request: new Request(`${ORIGIN}/unsubscribe`, { method: 'POST', body: form }), env });
  assert.strictEqual(posted.status, 200);
  assert.strictEqual(await isUnsubscribed(env, 'DANA@example.com'), true);
});

test("a mail client's one-click unsubscribe works with the link alone", async () => {
  const env = freshEnv();
  const url = await unsubUrl(env, ORIGIN, 'dana@example.com');
  const res = await unsubPost({ request: new Request(url, { method: 'POST', body: 'List-Unsubscribe=One-Click',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await isUnsubscribed(env, 'dana@example.com'), true);
});

test('a forged or mangled link unsubscribes nobody', async () => {
  const env = freshEnv();
  for (const q of ['?e=dana@example.com&t=guess', '?e=dana@example.com', '', '?e=%3Cscript%3E&t=x']) {
    const res = await unsubPost({ request: new Request(`${ORIGIN}/unsubscribe${q}`, { method: 'POST' }), env });
    assert.strictEqual(res.status, 400, q);
    const body = await res.text();
    assert.ok(!body.includes('<script>'));
  }
  assert.strictEqual(sqlite(env._file, 'SELECT COUNT(*) AS n FROM unsubscribes')[0].n, 0);
});

// ------------------------------------------------------------------ drafting
test('a due lead is drafted once, however many times the dashboard is opened', async () => {
  const env = freshEnv();
  const l = addLead(env, { status: 'quoted' });
  became(env, l.id, 'quoted', ago(5));
  assert.strictEqual(await draftDue(env, NOW), 1);
  assert.strictEqual(await draftDue(env, NOW), 0);
  const r = rows(env);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].status, 'draft');
  assert.strictEqual(r[0].email, 'dana@example.com');
  assert.match(r[0].body, /^Hi Dana,/);
  assert.match(r[0].body, /Disklavier Mark III/);
});

test('an unsubscribed address is never drafted', async () => {
  const env = freshEnv();
  const l = addLead(env, { status: 'quoted', email: 'Dana@Example.com' });
  became(env, l.id, 'quoted', ago(5));
  await unsubscribe(env, 'dana@example.com', 'test', NOW);
  assert.strictEqual(await draftDue(env, NOW), 0);
});

test('with every kind switched off nothing is drafted', async () => {
  const env = freshEnv();
  const l = addLead(env, { status: 'quoted' });
  became(env, l.id, 'quoted', ago(5));
  const c = cfg(); for (const k of KINDS) c.kinds[k].mode = 'off';
  await saveConfig(env, c, NOW);
  assert.strictEqual(await draftDue(env, NOW), 0);
});

// ------------------------------------------------------------------ sending
async function oneDraft(env) {
  const l = addLead(env, { status: 'quoted' });
  became(env, l.id, 'quoted', ago(5));
  await draftDue(env, NOW);
  return rows(env).find((r) => r.lead_id === l.id);
}

test('nothing sends until there is a postal address', async () => {
  const env = freshEnv();
  const d = await oneDraft(env);
  const { out, calls } = await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /mailing address/);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(rows(env)[0].status, 'draft');
});

test('a sent email carries the address, a working unsubscribe link, and lands on the timeline', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg(), NOW);
  const d = await oneDraft(env);
  const { out, calls } = await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.length, 1);
  const mail = calls[0].body;
  assert.deepStrictEqual(mail.to, ['dana@example.com']);
  assert.ok(mail.text.includes(ADDRESS));
  assert.ok(mail.html.includes(ADDRESS));
  const link = /Unsubscribe: (\S+)/.exec(mail.text)[1];
  assert.strictEqual(mail.headers['List-Unsubscribe'], `<${link}>`);
  const u = new URL(link);
  assert.strictEqual(await unsubValid(env, u.searchParams.get('e'), u.searchParams.get('t')), true);

  const r = rows(env)[0];
  assert.strictEqual(r.status, 'sent');
  assert.strictEqual(r.decided_by, 'ethan');
  const act = sqlite(env._file, `SELECT type, subject, meta FROM activities WHERE type = 'email'`);
  assert.strictEqual(act.length, 1);
  assert.match(act[0].subject, /^Sent: /);
});

test('an edit made before sending is what goes out', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg(), NOW);
  const d = await oneDraft(env);
  const { calls } = await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW, { subject: 'About your quote', body: 'Hi Dana,\n\nJust checking in.' }));
  assert.strictEqual(calls[0].body.subject, 'About your quote');
  assert.ok(calls[0].body.text.startsWith('Hi Dana,\n\nJust checking in.'));
});

test('what a customer typed cannot become markup in the email', async () => {
  const env = freshEnv();
  const mail = await renderEmail(env, ORIGIN, { email: 'dana@example.com', subject: 's',
    body: 'Your <img src=x onerror=alert(1)> is ready' }, cfg());
  assert.ok(!mail.html.includes('<img'));
  assert.ok(mail.html.includes('&lt;img'));
});

test('someone who unsubscribed while their email sat in the queue is not written to', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg(), NOW);
  const d = await oneDraft(env);
  await unsubscribe(env, 'dana@example.com', 'link', NOW);
  const { out, calls } = await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(rows(env)[0].status, 'skipped');
});

test('a lead archived while its email sat in the queue is not written to', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg(), NOW);
  const d = await oneDraft(env);
  sqlite(env._file, `UPDATE leads SET archived_at = ${lit(NOW)} WHERE id = ${d.lead_id}`);
  const { out, calls } = await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(rows(env)[0].status, 'skipped');
});

test('when the email service fails it is recorded as failed, and can be tried again', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg(), NOW);
  const d = await oneDraft(env);
  const bad = await withResend(() => new Response('no', { status: 500 }), () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  assert.strictEqual(bad.out.ok, false);
  assert.strictEqual(rows(env)[0].status, 'failed');
  assert.strictEqual(sqlite(env._file, `SELECT COUNT(*) AS n FROM activities WHERE type = 'email'`)[0].n, 0);
  const good = await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  assert.strictEqual(good.out.ok, true);
  assert.strictEqual(rows(env)[0].status, 'sent');
});

test('an email already sent or skipped cannot be sent again', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg(), NOW);
  const d = await oneDraft(env);
  await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  const again = await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  assert.strictEqual(again.out.ok, false);
  assert.strictEqual(again.calls.length, 0);
  assert.strictEqual((await skipOne(env, d.id, 'ethan', NOW)).ok, false);
});

test('the daily limit stops the next email and leaves it queued', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg(), NOW);
  const d = await oneDraft(env);
  for (let i = 0; i < DAILY_CAP; i++) {
    sqlite(env._file, `INSERT INTO outreach (created_at, lead_id, kind, cycle, email, subject, body, status, decided_at)
      VALUES (${lit(NOW)}, ${9000 + i}, 'review_request', '', 'x${i}@example.com', 's', 'b', 'sent', ${lit(NOW)})`);
  }
  const { out, calls } = await withResend(OK, () => sendOne(env, ORIGIN, d.id, 'ethan', NOW));
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /daily limit/);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(rows(env).find((r) => r.id === d.id).status, 'draft');
});

// ------------------------------------------------------------------ the run
test('a kind set to ask waits in the queue; a kind set to automatic sends itself', async () => {
  const env = freshEnv();
  const c = cfg(); c.kinds.review_request.mode = 'auto';
  await saveConfig(env, c, NOW);
  const q = addLead(env, { status: 'quoted', email: 'q@example.com' }); became(env, q.id, 'quoted', ago(5));
  const d = addLead(env, { status: 'completed', email: 'd@example.com' }); became(env, d.id, 'completed', ago(2));

  const { out, calls } = await withResend(OK, () => runOutreach(env, ORIGIN, NOW));
  assert.deepStrictEqual(out, { made: 2, sent: 1 });
  assert.deepStrictEqual(calls.map((x) => x.body.to[0]), ['d@example.com']);
  const queue = await loadQueue(env);
  assert.deepStrictEqual(queue.waiting.map((r) => r.kind), ['quote_checkin']);
  assert.deepStrictEqual(queue.recent.map((r) => r.kind), ['review_request']);
});

test('automatic does not mean unstoppable: with no address, nothing is attempted', async () => {
  const env = freshEnv();
  const c = cleanConfig(DEFAULT_CONFIG); c.kinds.review_request.mode = 'auto';
  await saveConfig(env, c, NOW);
  const d = addLead(env, { status: 'completed' }); became(env, d.id, 'completed', ago(2));
  const { out, calls } = await withResend(OK, () => runOutreach(env, ORIGIN, NOW));
  assert.deepStrictEqual(out, { made: 1, sent: 0 });
  assert.strictEqual(calls.length, 0);
});

test('our own email on the timeline does not count as a conversation', async () => {
  const env = freshEnv();
  await saveConfig(env, cfg(), NOW);
  const l = addLead(env, { status: 'quoted' });
  became(env, l.id, 'quoted', ago(5));
  addActivity(env, l.id, 'email', ago(1), { outreach: 'review_request', outreach_id: 1 });
  assert.strictEqual(await draftDue(env, NOW), 1);
});
