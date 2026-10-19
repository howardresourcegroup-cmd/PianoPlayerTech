// Who gets in, as what, and the rules that stop anyone being locked out.
//
// Real Access tokens (signed with a key made up for the run), a real SQLite
// database built from db/schema.sql. Tested by behaviour, end to end through
// identify(), because that is the one gate every request goes through.

// Node 18+ globals; the lint config only lists the older ones.
/* global Request */

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identify, mintToken, COOKIE } from '../functions/_lib/auth.js';
import { createUser, updateUser, listUsers, getUser, touchIfStale, userActivity } from '../functions/_lib/users.js';
import {
  ROOT, sqlite, accessEnv, addUser, asUser, installFetch, accessToken, TEAM, AUD
} from './fixtures/harness.mjs';

const NOW = '2026-10-18T12:00:00.000Z';

test.before(installFetch);

// ------------------------------------------------------------ bootstrap

test('an ACCESS_EMAILS address is an active owner with no users row at all', async () => {
  const env = accessEnv();
  const who = await identify(await asUser('boss@ppt.test'), env);
  assert.strictEqual(who.ok, true);
  assert.strictEqual(who.user.role, 'owner');
  assert.strictEqual(who.user.bootstrap, true);
});

test('ACCESS_EMAILS still works before the users table exists', async () => {
  // The migration not yet applied must not lock the owner out.
  const env = accessEnv();
  sqlite(env._file, 'DROP TABLE users');
  const who = await identify(await asUser('Boss@PPT.test'), env);
  assert.strictEqual(who.ok, true);
  assert.strictEqual(who.user.role, 'owner');
});

test('a users row can rename an ACCESS_EMAILS owner but never demote or disable them', async () => {
  const env = accessEnv();
  addUser(env, 'boss@ppt.test', 'viewer', 0, 'The Boss');
  const who = await identify(await asUser('boss@ppt.test'), env);
  assert.strictEqual(who.ok, true);
  assert.strictEqual(who.user.role, 'owner');
  assert.strictEqual(who.user.name, 'The Boss');

  const out = await updateUser(env, 'boss@ppt.test', { role: 'tech' }, 'boss@ppt.test', NOW);
  assert.strictEqual(out.status, 409);
  const off = await updateUser(env, 'boss@ppt.test', { active: false }, 'boss@ppt.test', NOW);
  assert.strictEqual(off.status, 409);
  const renamed = await updateUser(env, 'boss@ppt.test', { name: 'Ethan' }, 'boss@ppt.test', NOW);
  assert.strictEqual(renamed.user.name, 'Ethan');
});

test('the ADMIN_PASSWORD session acts as owner', async () => {
  const env = { ADMIN_PASSWORD: 'correct horse' };
  const token = await mintToken(env.ADMIN_PASSWORD);
  const req = new Request('https://pianoplayertech.com/leads', { headers: { Cookie: `${COOKIE}=${token}` } });
  const who = await identify(req, env);
  assert.strictEqual(who.ok, true);
  assert.strictEqual(who.user.role, 'owner');
  assert.strictEqual(who.user.mode, 'password');

  const wrong = await identify(new Request('https://pianoplayertech.com/leads',
    { headers: { Cookie: `${COOKIE}=${await mintToken('something else')}` } }), env);
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(wrong.reason, 'password');
});

test('with no ADMIN_PASSWORD and no Access, nobody gets in', async () => {
  const who = await identify(new Request('https://pianoplayertech.com/leads'), {});
  assert.strictEqual(who.ok, false);
  assert.strictEqual(who.reason, 'unconfigured');
});

// ------------------------------------------------------------- refusals

test('an email Access let through but this app does not know is refused', async () => {
  const env = accessEnv();
  const who = await identify(await asUser('stranger@example.com'), env);
  assert.strictEqual(who.ok, false);
  assert.strictEqual(who.reason, 'unknown');
});

test('a deactivated user is refused on their next request', async () => {
  const env = accessEnv();
  addUser(env, 'tech@ppt.test', 'tech');
  assert.strictEqual((await identify(await asUser('tech@ppt.test'), env)).ok, true);
  await updateUser(env, 'tech@ppt.test', { active: false }, 'boss@ppt.test', NOW);
  const who = await identify(await asUser('tech@ppt.test'), env);
  assert.strictEqual(who.ok, false);
  assert.strictEqual(who.reason, 'inactive');
});

test('an active users row gets its own role', async () => {
  const env = accessEnv();
  addUser(env, 'm@ppt.test', 'manager', 1, 'Morgan');
  const who = await identify(await asUser('M@PPT.test'), env);
  assert.deepStrictEqual([who.ok, who.user.role, who.user.name, who.user.bootstrap], [true, 'manager', 'Morgan', false]);
});

test('no valid Access token is no identity, users row or not', async () => {
  const env = accessEnv();
  addUser(env, 'tech@ppt.test', 'tech');
  const expired = await accessToken('tech@ppt.test', { exp: Math.floor(Date.now() / 1000) - 10 });
  const wrongAud = await accessToken('tech@ppt.test', { aud: ['someone-else'] });
  for (const t of [expired, wrongAud, 'not.a.jwt']) {
    const who = await identify(new Request('https://pianoplayertech.com/leads',
      { headers: { 'Cf-Access-Jwt-Assertion': t } }), env);
    assert.strictEqual(who.ok, false);
    assert.strictEqual(who.reason, 'signin');
  }
  assert.ok(TEAM && AUD);
});

test('an empty ACCESS_EMAILS and an empty users table admit nobody', async () => {
  const env = accessEnv({ ACCESS_EMAILS: '' });
  assert.strictEqual((await identify(await asUser('boss@ppt.test'), env)).ok, false);
});

// ------------------------------------------------------- the users store

test('adding a user lowercases the address and refuses a duplicate in any case', async () => {
  const env = accessEnv();
  const out = await createUser(env, { email: '  Pat@Example.COM ', name: 'Pat', role: 'tech' }, 'boss@ppt.test', NOW);
  assert.strictEqual(out.user.email, 'pat@example.com');
  assert.strictEqual(out.user.createdBy, 'boss@ppt.test');
  const dup = await createUser(env, { email: 'PAT@example.com', role: 'viewer' }, 'boss@ppt.test', NOW);
  assert.strictEqual(dup.status, 409);
});

test('adding a user refuses a bad address or an unknown role', async () => {
  const env = accessEnv();
  assert.strictEqual((await createUser(env, { email: 'nope', role: 'tech' }, 'x', NOW)).status, 400);
  assert.strictEqual((await createUser(env, { email: 'a@b.co', role: 'admin' }, 'x', NOW)).status, 400);
});

test('the table itself refuses a mixed-case address or an unknown role', () => {
  const env = accessEnv();
  assert.throws(() => addUser(env, 'Mixed@Case.com', 'tech'), /CHECK constraint/);
  assert.throws(() => addUser(env, 'a@b.co', 'superuser'), /CHECK constraint/);
});

test('a role change leaves active alone, and active leaves the role alone', async () => {
  const env = accessEnv();
  addUser(env, 't@ppt.test', 'tech', 0);
  await updateUser(env, 't@ppt.test', { role: 'viewer' }, 'boss@ppt.test', NOW);
  assert.deepStrictEqual([(await getUser(env, 't@ppt.test')).role, (await getUser(env, 't@ppt.test')).active], ['viewer', false]);
  await updateUser(env, 't@ppt.test', { active: true }, 'boss@ppt.test', NOW);
  assert.deepStrictEqual([(await getUser(env, 't@ppt.test')).role, (await getUser(env, 't@ppt.test')).active], ['viewer', true]);
});

test('the Users list includes ACCESS_EMAILS owners that have no row', async () => {
  const env = accessEnv({ ACCESS_EMAILS: 'boss@ppt.test, @ppt.test' });
  addUser(env, 'tech@ppt.test', 'tech');
  const list = await listUsers(env);
  const boss = list.find((u) => u.email === 'boss@ppt.test');
  assert.ok(boss && boss.bootstrap && boss.role === 'owner');
  // A domain entry names nobody, so it is not listed as a person...
  assert.ok(!list.some((u) => u.email === '@ppt.test'));
  // ...but the domain still admits as owner, as it always has.
  assert.strictEqual(list.find((u) => u.email === 'tech@ppt.test').role, 'owner');
});

// --------------------------------------------------- the last-owner guard

test('the last active owner cannot be demoted or deactivated', async () => {
  const env = accessEnv({ ACCESS_EMAILS: '' });
  addUser(env, 'only@ppt.test', 'owner');
  const demote = await updateUser(env, 'only@ppt.test', { role: 'manager' }, 'only@ppt.test', NOW);
  assert.strictEqual(demote.status, 409);
  assert.match(demote.error, /nobody as an active owner/);
  const off = await updateUser(env, 'only@ppt.test', { active: false }, 'only@ppt.test', NOW);
  assert.strictEqual(off.status, 409);
  const row = await getUser(env, 'only@ppt.test');
  assert.deepStrictEqual([row.role, row.active], ['owner', true]);
});

test('with a second active owner, one of them can step down', async () => {
  const env = accessEnv({ ACCESS_EMAILS: '' });
  addUser(env, 'a@ppt.test', 'owner');
  addUser(env, 'b@ppt.test', 'owner');
  assert.ok((await updateUser(env, 'a@ppt.test', { role: 'manager' }, 'b@ppt.test', NOW)).user);
  // ...and now b is the last one.
  assert.strictEqual((await updateUser(env, 'b@ppt.test', { role: 'tech' }, 'b@ppt.test', NOW)).status, 409);
});

test('a deactivated owner does not count as the other owner', async () => {
  const env = accessEnv({ ACCESS_EMAILS: '' });
  addUser(env, 'a@ppt.test', 'owner');
  addUser(env, 'gone@ppt.test', 'owner', 0);
  assert.strictEqual((await updateUser(env, 'a@ppt.test', { active: false }, 'a@ppt.test', NOW)).status, 409);
});

test('an ACCESS_EMAILS owner counts as another owner', async () => {
  const env = accessEnv({ ACCESS_EMAILS: 'boss@ppt.test' });
  addUser(env, 'a@ppt.test', 'owner');
  assert.ok((await updateUser(env, 'a@ppt.test', { role: 'viewer' }, 'boss@ppt.test', NOW)).user);
});

// ------------------------------------------------------------ the trail

test('adds and changes are written to the activity log, against no lead', async () => {
  const env = accessEnv();
  await createUser(env, { email: 'pat@ppt.test', role: 'tech' }, 'boss@ppt.test', NOW);
  await updateUser(env, 'pat@ppt.test', { role: 'manager' }, 'boss@ppt.test', NOW);
  await updateUser(env, 'pat@ppt.test', { active: false }, 'boss@ppt.test', NOW);
  const rows = sqlite(env._file, 'SELECT * FROM activities ORDER BY id');
  assert.deepStrictEqual(rows.map((r) => r.subject), [
    'User added: pat@ppt.test as Tech',
    'User pat@ppt.test: Tech → Manager',
    'User pat@ppt.test: deactivated'
  ]);
  for (const r of rows) {
    assert.strictEqual(r.lead_id, null);
    assert.strictEqual(r.actor, 'boss@ppt.test');
    assert.strictEqual(JSON.parse(r.meta).area, 'users');
  }
  assert.strictEqual((await userActivity(env)).length, 3);
});

test('a refused change writes nothing to the log', async () => {
  const env = accessEnv({ ACCESS_EMAILS: '' });
  addUser(env, 'only@ppt.test', 'owner');
  await updateUser(env, 'only@ppt.test', { role: 'viewer' }, 'only@ppt.test', NOW);
  assert.strictEqual(sqlite(env._file, 'SELECT COUNT(*) AS n FROM activities')[0].n, 0);
});

test('last_seen_at is written at most every five minutes', async () => {
  const env = accessEnv();
  addUser(env, 't@ppt.test', 'tech');
  await touchIfStale(env, await getUser(env, 't@ppt.test'), NOW);
  assert.strictEqual((await getUser(env, 't@ppt.test')).lastSeenAt, NOW);
  const soon = '2026-10-18T12:03:00.000Z';
  await touchIfStale(env, { email: 't@ppt.test', lastSeenAt: null }, soon);
  assert.strictEqual((await getUser(env, 't@ppt.test')).lastSeenAt, NOW, 'the statement checks the age too');
  const later = '2026-10-18T12:06:00.000Z';
  await touchIfStale(env, await getUser(env, 't@ppt.test'), later);
  assert.strictEqual((await getUser(env, 't@ppt.test')).lastSeenAt, later);
});

// ------------------------------------------------------------ migration

test('the users migration applies to an existing database, twice, and touches nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-users-mig-'));
  const db = path.join(dir, 'old.db');
  const before = fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8')
    .replace(/CREATE TABLE IF NOT EXISTS users[\s\S]*?\);\n/, '');
  execFileSync('sqlite3', [db], { input: before });
  execFileSync('sqlite3', [db, "INSERT INTO people (created_at, name, kind) VALUES ('x', 'Christian', 'contractor')"]);
  const mig = fs.readFileSync(path.join(ROOT, 'db/2026-10-18-users.sql'), 'utf8');
  execFileSync('sqlite3', [db], { input: mig });
  execFileSync('sqlite3', [db], { input: mig });
  const cols = sqlite(db, "SELECT name FROM pragma_table_info('users')").map((r) => r.name);
  assert.deepStrictEqual(cols, ['email', 'name', 'role', 'active', 'created_at', 'last_seen_at', 'created_by']);
  assert.strictEqual(sqlite(db, 'SELECT name FROM people')[0].name, 'Christian');
});

test('schema.sql and the migration define the same users table', () => {
  const pick = (s) => s.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/)[1]
    .split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean).join(' ');
  assert.strictEqual(
    pick(fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8')),
    pick(fs.readFileSync(path.join(ROOT, 'db/2026-10-18-users.sql'), 'utf8')));
});

// ------------------------------------------------- fix round 1 (review)

test('active must be a real boolean: "false" is refused, not read as true', async () => {
  const env = accessEnv();
  addUser(env, 't@ppt.test', 'tech', 0);
  for (const active of ['false', '0', 0, 1, 'true', [], {}]) {
    const out = await updateUser(env, 't@ppt.test', { active }, 'boss@ppt.test', NOW);
    assert.strictEqual(out.status, 400, JSON.stringify(active));
  }
  assert.strictEqual((await getUser(env, 't@ppt.test')).active, false);
  for (const role of [['owner'], { toString: () => 'owner' }, 1]) {
    assert.strictEqual((await updateUser(env, 't@ppt.test', { role }, 'boss@ppt.test', NOW)).status, 400);
    assert.strictEqual((await createUser(env, { email: 'n@ppt.test', role }, 'boss@ppt.test', NOW)).status, 400);
  }
});

test('a user change and its log line land together or not at all', async () => {
  const env = accessEnv();
  addUser(env, 't@ppt.test', 'tech');
  // A log that cannot be written must take the change down with it.
  sqlite(env._file, 'ALTER TABLE activities RENAME TO activities_gone');
  await assert.rejects(updateUser(env, 't@ppt.test', { role: 'manager' }, 'boss@ppt.test', NOW));
  await assert.rejects(createUser(env, { email: 'n@ppt.test', role: 'viewer' }, 'boss@ppt.test', NOW));
  sqlite(env._file, 'ALTER TABLE activities_gone RENAME TO activities');
  assert.strictEqual((await getUser(env, 't@ppt.test')).role, 'tech');
  assert.strictEqual(await getUser(env, 'n@ppt.test'), null);
});

test('a refused duplicate add writes no log line', async () => {
  const env = accessEnv();
  await createUser(env, { email: 'pat@ppt.test', role: 'tech' }, 'boss@ppt.test', NOW);
  await createUser(env, { email: 'pat@ppt.test', role: 'viewer' }, 'boss@ppt.test', NOW);
  assert.strictEqual(sqlite(env._file, 'SELECT COUNT(*) AS n FROM activities')[0].n, 1);
});

test('a @domain entry does not count as another owner for the last-owner rule', async () => {
  const env = accessEnv({ ACCESS_EMAILS: '@ppt.test' });
  addUser(env, 'only@other.test', 'owner');
  assert.strictEqual((await updateUser(env, 'only@other.test', { role: 'tech' }, 'only@other.test', NOW)).status, 409);
});

test('tokens that are not genuinely from our Access team are no identity', async () => {
  const env = accessEnv();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const good = await accessToken('boss@ppt.test');
  const [h, c, sig] = good.split('.');
  const now = Math.floor(Date.now() / 1000);
  const forged = b64({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 3600, email: 'boss@ppt.test', admin: true });
  const tokens = {
    'wrong iss': await accessToken('boss@ppt.test', { iss: 'https://evil.cloudflareaccess.com' }),
    'bad signature': `${h}.${forged}.${sig}`,
    'truncated signature': `${h}.${c}.${sig.slice(0, -8)}`,
    'unknown kid': await accessToken('boss@ppt.test', {}, { kid: 'not-a-key' }),
    'alg none': `${b64({ alg: 'none', kid: 'test-key-1' })}.${c}.`,
    'HS256': `${b64({ alg: 'HS256', kid: 'test-key-1' })}.${c}.${sig}`,
    'no exp': await accessToken('boss@ppt.test', { exp: undefined }),
    'not yet valid': await accessToken('boss@ppt.test', { nbf: now + 3600 })
  };
  for (const [what, t] of Object.entries(tokens)) {
    const who = await identify(new Request('https://pianoplayertech.com/leads',
      { headers: { 'Cf-Access-Jwt-Assertion': t } }), env);
    assert.strictEqual(who.ok, false, what);
    assert.strictEqual(who.reason, 'signin', what);
  }
  assert.strictEqual((await identify(await asUser('boss@ppt.test'), env)).ok, true, 'the genuine token still works');
});
