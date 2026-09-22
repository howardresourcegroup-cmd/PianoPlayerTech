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

// The one gate every read and write goes through. Returns who is signed in
// (an email under Access, 'admin' under the password), or '' for nobody.
export async function signedIn(request, env) {
  if (accessMode(env)) {
    const email = await accessIdentity(request, env);
    return email && emailAllowed(env, email) ? email : '';
  }
  if (!env.ADMIN_PASSWORD) return '';
  return (await tokenValid(env.ADMIN_PASSWORD, cookieValue(request, COOKIE))) ? 'admin' : '';
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
