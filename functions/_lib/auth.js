// Who may open the private dashboard.
//
// Two ways in: Cloudflare Access (Google or an email code, with ACCESS_EMAILS
// naming who is allowed), or a signed cookie minted from ADMIN_PASSWORD.
// Fails closed -- with neither configured, nobody gets in, and an empty
// ACCESS_EMAILS admits nobody rather than everybody.
//
// Moved out of leads.js verbatim. Do not simplify: safeEqual must stay
// length-safe and non-short-circuiting, and emailAllowed must keep matching
// a domain only on a full '@domain' suffix.

// Roles and the users table (2026-10-18) were added around these functions,
// not into them: identify() below is new, and the checks above it are as
// they were.

import { getUser } from './users.js';
import { isRole } from './roles.js';

export const SESSION_HOURS = 12;
export const COOKIE = 'ppt_admin';

// ------------------------------------------------------------------ auth

const enc = new TextEncoder();

export async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Length-independent comparison, so timing never leaks how much was right.
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function mintToken(secret) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

export async function tokenValid(secret, token) {
  if (!token || token.indexOf('.') < 0) return false;
  const [exp, sig] = token.split('.');
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(secret, exp));
}

export function cookieValue(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

// ----------------------------------------------------- Cloudflare Access
//
// Access sits in front of /leads and signs every request it lets through
// with a JWT. We verify that signature ourselves rather than trusting that
// Access is in the way: the same function also answers on *.pages.dev
// hostnames, which an Access rule for pianoplayertech.com does not cover.
// No valid token, no page — whichever hostname the request came in on.

export function accessMode(env) {
  return !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

function teamDomain(env) {
  return String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

let certCache = { at: 0, keys: [] };
async function accessKeys(env, forceRefresh) {
  if (!forceRefresh && certCache.keys.length && Date.now() - certCache.at < 3600 * 1000) return certCache.keys;
  const r = await fetch(`https://${teamDomain(env)}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`access certs ${r.status}`);
  const j = await r.json();
  // Two concurrent requests can both fetch and both assign here. That is
  // harmless: these are Cloudflare's public signing keys, the assignment
  // replaces the whole object rather than mutating it, and the loser of the
  // race has written an equally valid cache. The only cost is one extra
  // fetch an hour.
  // eslint-disable-next-line require-atomic-updates
  certCache = { at: Date.now(), keys: j.keys || [] };
  return certCache.keys;
}

// Returns the signed-in email, or null. Never throws.
export async function accessIdentity(request, env) {
  try {
    const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookieValue(request, 'CF_Authorization');
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
    if (header.alg !== 'RS256' || !header.kid) return null;

    let keys = await accessKeys(env, false);
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) { keys = await accessKeys(env, true); jwk = keys.find((k) => k.kid === header.kid); }
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const signed = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`)
    );
    if (!signed) return null;

    const now = Date.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (claims.iss !== `https://${teamDomain(env)}`) return null;
    if (typeof claims.exp !== 'number' || claims.exp < now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
    return String(claims.email || claims.sub || 'signed in');
  } catch (err) {
    console.error('access check failed', err && err.message);
    return null;
  }
}

// The Access policy only proves who someone is; this list decides whether
// they may see customer data. Fails closed: no list, nobody.
export function emailAllowed(env, email) {
  const list = String(env.ACCESS_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const e = String(email || '').toLowerCase();
  if (!e.includes('@')) return false;
  const domain = e.slice(e.indexOf('@'));
  return list.some((x) => x === e || (x.startsWith('@') && x === domain));
}

// ------------------------------------------------------------ identity
//
// The one gate every read and write goes through. Who is asking, and with
// which role. Ported from HRG's platform (api/internal/auth/identity.go).
//
// Under Access, an email must pass BOTH Cloudflare Access (the signed JWT
// above) AND this app: be in ACCESS_EMAILS, or have an active users row.
//   - ACCESS_EMAILS: always an active owner. A users row may give them a
//     name, never a lesser role and never a deactivation.
//   - users row, active: the row's role.
//   - users row, deactivated: refused, on their very next request.
//   - neither: refused.
// Under the password, the session is the owner.
//
// Fails closed. If the users table cannot be read, only ACCESS_EMAILS gets
// in -- which is exactly who got in before the table existed.
//
// Returns { ok: true, user: { email, name, role, mode, bootstrap, lastSeenAt } }
// or { ok: false, reason, email }, where reason is 'signin' (no valid Access
// token), 'unknown', 'inactive', 'password' (not logged in) or
// 'unconfigured'.
export async function identify(request, env) {
  if (accessMode(env)) {
    const raw = await accessIdentity(request, env);
    if (!raw) return { ok: false, reason: 'signin', email: '' };
    const email = String(raw).trim().toLowerCase();

    let row = null;
    try {
      row = await getUser(env, email);
    } catch (err) {
      // Before the migration is applied this is "no such table". Not fatal
      // for ACCESS_EMAILS; fatal for everyone else, as it should be.
      console.error('users lookup failed', err && err.message);
    }

    if (emailAllowed(env, email)) {
      return { ok: true, user: { email, name: (row && row.name) || '', role: 'owner',
        mode: 'access', bootstrap: true, lastSeenAt: row ? row.lastSeenAt : null, hasRow: !!row } };
    }
    if (row && row.active && isRole(row.role)) {
      return { ok: true, user: { email, name: row.name, role: row.role,
        mode: 'access', bootstrap: false, lastSeenAt: row.lastSeenAt, hasRow: true } };
    }
    return { ok: false, reason: row && !row.active ? 'inactive' : 'unknown', email };
  }

  if (!env.ADMIN_PASSWORD) return { ok: false, reason: 'unconfigured', email: '' };
  if (await tokenValid(env.ADMIN_PASSWORD, cookieValue(request, COOKIE))) {
    return { ok: true, user: { email: 'admin', name: 'Admin', role: 'owner',
      mode: 'password', bootstrap: true, lastSeenAt: null, hasRow: false } };
  }
  return { ok: false, reason: 'password', email: '' };
}

// Who is signed in (an email under Access, 'admin' under the password), or
// '' for nobody. Kept for callers that only need yes or no.
export async function signedIn(request, env) {
  const who = await identify(request, env);
  return who.ok ? who.user.email : '';
}

export async function authed(request, env) {
  return !!(await signedIn(request, env));
}

// The SameSite=Strict cookie already stops cross-site posts; this is the
// belt to go with those braces.
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

// Never cached, never indexed, never framed. The page renders text customers
// typed, so scripts are locked to the one inline block carrying this nonce.
