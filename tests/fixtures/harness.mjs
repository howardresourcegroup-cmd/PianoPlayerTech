// Test support for anything that signs in: a real SQLite database behind a
// D1-shaped wrapper, and real Cloudflare Access tokens signed with a key
// made up for the run. Nothing here talks to the network or to D1.

// Node 18+ globals; the lint config only lists the older ones.
/* global Request, crypto */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const lit = (v) => v == null ? 'NULL' : typeof v === 'number' ? String(v)
  : typeof v === 'boolean' ? (v ? '1' : '0') : `'${String(v).replace(/'/g, "''")}'`;

export function sqlite(file, sql) {
  const out = execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  return out ? JSON.parse(out) : [];
}

export function fakeDb(file) {
  return {
    // Like D1: one transaction, all or nothing, a result per statement.
    async batch(stmts) {
      const sql = ['BEGIN'];
      stmts.forEach((s, i) => sql.push(s._sql(), `SELECT changes() AS c, ${i} AS __i`));
      sql.push('COMMIT');
      const out = execFileSync('sqlite3', ['-json', '-bail', file, sql.join(';\n') + ';'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const changes = [];
      for (const m of out.matchAll(/\[\{"c":(\d+),"__i":(\d+)\}\]/g)) changes[Number(m[2])] = Number(m[1]);
      return stmts.map((_, i) => ({ meta: { changes: changes[i] || 0 } }));
    },
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

// A database built from db/schema.sql, as a fresh install would be.
export function freshDbFile(prefix = 'ppt-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  return file;
}

// ------------------------------------------------------- Cloudflare Access

export const TEAM = 'ppt-test.cloudflareaccess.com';
export const AUD = 'aud-test-123';
const KID = 'test-key-1';

const b64url = (bytes) => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let keyPair = null;
let publicJwk = null;

async function keys() {
  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']);
    publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: KID };
  }
  return keyPair;
}

// Serves the test key where auth.js looks for Cloudflare's. Anything else
// fetched during a test is a mistake, and fails loudly.
export async function installFetch() {
  await keys();
  globalThis.fetch = async (url) => {
    if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch in a test: ${url}`);
  };
}

export async function accessToken(email, over = {}, headerOver = {}) {
  const kp = await keys();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT', ...headerOver }));
  const claims = b64url(JSON.stringify({
    aud: [AUD], iss: `https://${TEAM}`, exp: now + 3600, iat: now, email, ...over
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey,
    new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
}

// An env in Access mode with a database. ACCESS_EMAILS defaults to one owner.
export function accessEnv(over = {}) {
  const file = freshDbFile();
  return { DB: fakeDb(file), _file: file, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD,
    ACCESS_EMAILS: 'boss@ppt.test', ...over };
}

export function addUser(env, email, role, active = 1, name = '') {
  sqlite(env._file, `INSERT INTO users (email, name, role, active, created_at, created_by)
    VALUES (${lit(email)}, ${lit(name)}, ${lit(role)}, ${active}, '2026-10-01T00:00:00.000Z', 'test')`);
}

// A request as a signed-in browser would send it.
export async function asUser(email, { method = 'GET', path: p = '/leads', body } = {}) {
  const headers = { 'Cf-Access-Jwt-Assertion': await accessToken(email) };
  if (body !== undefined) {
    // What the dashboard's own fetch sends.
    headers['Content-Type'] = 'application/json';
    headers.Origin = 'https://pianoplayertech.com';
    headers['Sec-Fetch-Site'] = 'same-origin';
  }
  return new Request(`https://pianoplayertech.com${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
}

// What a Pages Function is handed. waitUntil work is collected so a test
// can let it finish before the database goes away.
export function context(request, env) {
  const pending = [];
  return { request, env, waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); },
    settle: () => Promise.all(pending) };
}
