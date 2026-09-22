// Private lead CRM at /leads. Replaced Airtable.
//
// Shared code lives in ./_lib/. Pages bundles underscore-prefixed paths as
// modules and does not route them -- verified with `wrangler pages functions
// build`, which emits routes only for real endpoints. An earlier version of
// this file assumed otherwise and grew to 1,600 lines as a result.
//
// Cloudflare Pages -> pianoplayertech -> Settings:
//   Bindings:   DB (D1) -> pianoplayertech-leads
//   Secrets:    ADMIN_PASSWORD     password login, used until Access is set up
//   Variables:  ACCESS_TEAM_DOMAIN e.g. pianoplayertech.cloudflareaccess.com
//               ACCESS_AUD         the Access application's "Application Audience (AUD) Tag"
//               ACCESS_EMAILS      who may open the dashboard, comma-separated;
//                                  "@pianoplayertech.com" allows a whole domain
//               With the first two set, sign-in is Cloudflare Access (Google /
//               email code) and the password is no longer used. ACCESS_EMAILS
//               must then be set too — an empty list lets nobody in.
//   Secrets:    STRIPE_SECRET_KEY  turns on invoicing (a restricted key with
//                                  Customers, Invoices and Invoice Items write)
//   Variables:  WORLDCLASS_EMAIL   optional; turns on emailing referrals
//               RESEND_API_KEY, LEAD_FROM_EMAIL, LEAD_NOTIFY_EMAIL (shared
//               with functions/api/lead.js)
//
// Fails closed: with no ADMIN_PASSWORD set, nobody gets in. That is
// deliberate — this page holds customer names, numbers and addresses, so a
// half-finished setup must never leave it open.

import { escape_, page, privateHeaders, newNonce, json } from './_lib/html.js';

const SESSION_HOURS = 12;
const COOKIE = 'ppt_admin';
const VIEWS = { repair: 'Repair & Pneumatic', tuning: 'Tuning', referrals: 'Referrals', all: 'All', invoices: 'Invoices' };
const STATUSES = ['new', 'called', 'referred', 'booked', 'closed'];

// What a person may pick in the Status dropdown. 'referred' is missing on
// purpose: it is set only by the refer flow, which also stamps referred_at.
// Choosing it by hand used to set the status and nothing else, so the lead
// never reached the Referrals tab, the stats, or a World Class invoice.
const SET_STATUSES = STATUSES.filter((s) => s !== 'referred');

const PIPELINES = ['repair', 'tuning'];

// World Class pays per referral they actually book — not per referral sent.
const REFERRAL_FEE = 25;
const REFERRAL_STATUSES = ['sent', 'booked', 'no_booking'];

// Grid cells a person may edit, with the longest value each one accepts.
// Anything not listed here (message, source, fields) is what the customer
// submitted and stays exactly as they sent it.
const EDITABLE = {
  name: 200, phone: 50, email: 200, address: 300, city: 100,
  system: 200, service: 200, notes: 4000, status: 0, pipeline: 0, referral_status: 0
};

const COLUMNS = [
  'id', 'created_at', 'updated_at', 'pipeline', 'status', 'name', 'phone', 'email',
  'address', 'city', 'system', 'service', 'message', 'notes', 'source',
  'referred_at', 'referral_status', 'referral_paid_at', 'referral_invoice_id', 'fields'
];

const INVOICE_COLUMNS = [
  'id', 'created_at', 'kind', 'lead_id', 'bill_to', 'email', 'description', 'amount_cents',
  'status', 'number', 'due_date', 'paid_at', 'hosted_url', 'stripe_id', 'lines'
];

// Pinned so a Stripe API upgrade can never change what these calls mean.
const STRIPE_VERSION = '2024-06-20';
const MAX_LINES = 25;
const MAX_LINE_CENTS = 5000000; // $50,000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ------------------------------------------------------------------ auth

const enc = new TextEncoder();

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Length-independent comparison, so timing never leaks how much was right.
function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function mintToken(secret) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

async function tokenValid(secret, token) {
  if (!token || token.indexOf('.') < 0) return false;
  const [exp, sig] = token.split('.');
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(secret, exp));
}

function cookieValue(request, name) {
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

function accessMode(env) {
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
async function accessIdentity(request, env) {
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
function emailAllowed(env, email) {
  const list = String(env.ACCESS_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const e = String(email || '').toLowerCase();
  if (!e.includes('@')) return false;
  const domain = e.slice(e.indexOf('@'));
  return list.some((x) => x === e || (x.startsWith('@') && x === domain));
}

// The one gate every read and write goes through. Returns who is signed in
// (an email under Access, 'admin' under the password), or '' for nobody.
async function signedIn(request, env) {
  if (accessMode(env)) {
    const email = await accessIdentity(request, env);
    return email && emailAllowed(env, email) ? email : '';
  }
  if (!env.ADMIN_PASSWORD) return '';
  return (await tokenValid(env.ADMIN_PASSWORD, cookieValue(request, COOKIE))) ? 'admin' : '';
}

async function authed(request, env) {
  return !!(await signedIn(request, env));
}

// The SameSite=Strict cookie already stops cross-site posts; this is the
// belt to go with those braces.
function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

// Never cached, never indexed, never framed. The page renders text customers
// typed, so scripts are locked to the one inline block carrying this nonce.



// ----------------------------------------------------------------- routes

export async function onRequestGet(context) {
  const { request, env } = context;
  const nonce = newNonce();
  const headers = privateHeaders(nonce);

  let who = '';
  if (accessMode(env)) {
    who = await accessIdentity(request, env);
    if (!who) {
      return new Response(page('Sign in required', `
        <div class="card narrow"><h1>Sign in required</h1>
        <p class="muted">Open <a href="https://pianoplayertech.com/leads" style="color:var(--gold)">pianoplayertech.com/leads</a>
        to sign in with your email.</p></div>`), { status: 403, headers });
    }
    if (!emailAllowed(env, who)) {
      const none = !String(env.ACCESS_EMAILS || '').trim();
      return new Response(page('Not on the list', `
        <div class="card narrow"><h1>Not on the list</h1>
        <p class="muted">You're signed in as <strong>${escape_(who)}</strong>, but that email isn't allowed to open the CRM.</p>
        <p class="muted">${none
          ? 'No one is allowed yet: add an <code>ACCESS_EMAILS</code> variable in Cloudflare Pages &rarr; Settings &rarr; Variables and secrets, then redeploy.'
          : 'Add it to the <code>ACCESS_EMAILS</code> variable in Cloudflare Pages settings and redeploy, or sign in with a different account.'}</p>
        <form method="post"><input type="hidden" name="action" value="logout">
        <button class="go full" type="submit">Use a different account</button></form></div>`), { status: 403, headers });
    }
  } else if (!env.ADMIN_PASSWORD) {
    return new Response(page('Not set up yet', `
      <div class="card narrow"><h1>Dashboard not configured</h1>
      <p class="muted">Add an <code>ADMIN_PASSWORD</code> secret in Cloudflare Pages
      &rarr; Settings &rarr; Variables and secrets, then redeploy. Until then nobody
      can open this page, including you.</p></div>`), { status: 503, headers });
  }

  if (!who) {
    who = await signedIn(request, env);
    if (!who) {
      const bad = new URL(request.url).searchParams.get('e') === '1';
      return new Response(loginPage(bad), { status: bad ? 401 : 200, headers });
    }
  }

  if (!env.DB) {
    return new Response(page('Leads', `
      <div class="card narrow"><h1>No database connected</h1>
      <p class="muted">Bind a D1 database named <code>DB</code> in Cloudflare Pages
      &rarr; Settings &rarr; Bindings, then redeploy. New leads are still being
      emailed to you in the meantime &mdash; nothing is being lost.</p></div>`),
      { headers });
  }

  const url = new URL(request.url);
  const view = Object.prototype.hasOwnProperty.call(VIEWS, url.searchParams.get('p'))
    ? url.searchParams.get('p') : 'repair';

  let rows;
  let counts = { repair: 0, tuning: 0 };
  let ref = { sent: 0, booked: 0, lost: 0, paid: 0 };
  const extra = { stripeReady: !!env.STRIPE_SECRET_KEY, invoices: [], lastWcEmail: '' };
  try {
    // Catch up on anything paid since last time.
    if (extra.stripeReady && (view === 'invoices' || view === 'referrals')) await syncInvoices(env);

    if (view === 'invoices') {
      extra.invoices = (await env.DB.prepare(
        `SELECT ${INVOICE_COLUMNS.join(', ')} FROM invoices WHERE status != 'creating' ORDER BY id DESC LIMIT 2000`
      ).all()).results || [];
      if (url.searchParams.get('export') === 'csv') {
        const day = new Date().toISOString().slice(0, 10);
        return new Response(toCsv(extra.invoices, INVOICE_COLUMNS), {
          headers: {
            ...privateHeaders(nonce, 'text/csv; charset=utf-8'),
            'Content-Disposition': `attachment; filename="ppt-invoices-${day}.csv"`
          }
        });
      }
    } else if (view === 'referrals') {
      extra.invoices = (await env.DB.prepare(
        `SELECT id, number, status, hosted_url FROM invoices WHERE kind = 'referral' AND status != 'creating'`
      ).all()).results || [];
    }
    const last = await env.DB.prepare(
      `SELECT email FROM invoices WHERE kind = 'referral' AND status != 'creating' ORDER BY id DESC LIMIT 1`
    ).first();
    extra.lastWcEmail = (last && last.email) || '';

    const where = view === 'all' || view === 'invoices' ? ''
      : view === 'referrals' ? 'WHERE referred_at IS NOT NULL'
      : 'WHERE pipeline = ?';
    const order = view === 'referrals'
      ? 'ORDER BY referred_at DESC'
      : `ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, created_at DESC`;
    let stmt = env.DB.prepare(`SELECT ${COLUMNS.join(', ')} FROM leads ${where} ${order} LIMIT 5000`);
    if (view === 'repair' || view === 'tuning') stmt = stmt.bind(view);
    rows = (await stmt.all()).results || [];

    if (url.searchParams.get('export') === 'csv') {
      const day = new Date().toISOString().slice(0, 10);
      return new Response(toCsv(rows, COLUMNS), {
        headers: {
          ...privateHeaders(nonce, 'text/csv; charset=utf-8'),
          'Content-Disposition': `attachment; filename="ppt-${view}-${day}.csv"`
        }
      });
    }

    const c = await env.DB.prepare(
      `SELECT pipeline, SUM(status = 'new') AS n FROM leads GROUP BY pipeline`
    ).all();
    for (const r of (c.results || [])) {
      if (r.pipeline in counts) counts[r.pipeline] = r.n || 0;
    }

    const s = await env.DB.prepare(
      `SELECT COUNT(referred_at) AS sent,
              SUM(referral_status = 'booked') AS booked,
              SUM(referral_status = 'no_booking') AS lost,
              SUM(referral_status = 'booked' AND referral_paid_at IS NOT NULL) AS paid
         FROM leads WHERE referred_at IS NOT NULL`
    ).first();
    if (s) ref = { sent: s.sent || 0, booked: s.booked || 0, lost: s.lost || 0, paid: s.paid || 0 };
  } catch (err) {
    return new Response(page('Leads', `
      <div class="card narrow"><h1>Could not read the database</h1>
      <p class="muted">${escape_(err && err.message)}</p>
      <p class="muted">"no such table" or "no such column" means <code>db/schema.sql</code>
      hasn't been applied to this database yet.</p></div>`),
      { status: 500, headers });
  }

  extra.wcReady = !!(env.WORLDCLASS_EMAIL && env.RESEND_API_KEY);
  extra.who = accessMode(env) ? who : '';
  return new Response(dashboard(view, rows, counts, ref, extra, nonce), { headers });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const type = request.headers.get('Content-Type') || '';

  // Login / logout arrive as a normal form post.
  if (type.includes('form')) {
    const form = await request.formData();
    const action = form.get('action');

    if (action === 'logout') {
      return new Response(null, {
        status: 303,
        headers: {
          Location: accessMode(env) ? '/cdn-cgi/access/logout' : '/leads',
          'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
        }
      });
    }

    // Under Access there is no password to try.
    if (accessMode(env)) return new Response('forbidden', { status: 403 });
    if (!env.ADMIN_PASSWORD) return new Response('not configured', { status: 503 });

    if (safeEqual(form.get('password') || '', env.ADMIN_PASSWORD)) {
      const token = await mintToken(env.ADMIN_PASSWORD);
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/leads',
          'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; Secure; SameSite=Strict`
        }
      });
    }
    // Slow down guessing without making a real typo feel broken.
    await new Promise((r) => setTimeout(r, 1000));
    return new Response(null, { status: 303, headers: { Location: '/leads?e=1' } });
  }

  // Everything else is a dashboard action and needs a valid session.
  if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
  if (!(await authed(request, env))) return json({ error: 'Signed out — reload and sign in again.' }, 401);
  if (!env.DB) return json({ error: 'No database connected.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }

  if (body.action === 'invoice' || body.action === 'void') {
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe is not connected. Add a STRIPE_SECRET_KEY secret in Cloudflare, then redeploy.' }, 503);
    try {
      return body.action === 'invoice'
        ? await createInvoice(env, body, new Date().toISOString())
        : await voidInvoice(env, parseInt(body.id, 10));
    } catch (err) {
      console.error('invoice action failed', body.action, err && err.message);
      return json({ error: err && err.stripe ? `Stripe said: ${err.message}` : 'Could not complete that — try again.' }, 502);
    }
  }

  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id)) return json({ error: 'bad id' }, 400);

  const now = new Date().toISOString();
  try {
    if (body.action === 'update') {
      const field = body.field;
      if (!Object.prototype.hasOwnProperty.call(EDITABLE, field)) return json({ error: 'That column is read-only.' }, 400);
      let value = String(body.value == null ? '' : body.value).trim();
      if (field === 'status' && value === 'referred') {
        return json({ error: 'Use the Refer button so the referral is recorded and can be billed.' }, 400);
      }
      if (field === 'status' && !SET_STATUSES.includes(value)) return json({ error: 'bad status' }, 400);
      if (field === 'pipeline' && !PIPELINES.includes(value)) return json({ error: 'bad pipeline' }, 400);
      if (field === 'referral_status' && !REFERRAL_STATUSES.includes(value)) return json({ error: 'bad referral status' }, 400);
      if (EDITABLE[field]) value = value.slice(0, EDITABLE[field]);

      // A referral nobody booked cannot have been paid for.
      const extra = field === 'referral_status' && value !== 'booked' ? ', referral_paid_at = NULL' : '';
      // `field` is safe to interpolate: it matched a key of EDITABLE above.
      await env.DB.prepare(`UPDATE leads SET ${field} = ?, updated_at = ?${extra} WHERE id = ?`)
        .bind(value, now, id).run();
      return json({ ok: true, value });
    }

    if (body.action === 'paid') {
      // Paid implies booked — World Class only pays on booked jobs.
      const r = body.paid
        ? await env.DB.prepare(
            `UPDATE leads SET referral_paid_at = ?, referral_status = 'booked', updated_at = ?
              WHERE id = ? AND referred_at IS NOT NULL`).bind(now, now, id).run()
        : await env.DB.prepare(
            'UPDATE leads SET referral_paid_at = NULL, updated_at = ? WHERE id = ?').bind(now, id).run();
      if (body.paid && !(r.meta && r.meta.changes)) return json({ error: 'Send or mark this as a referral first.' }, 400);
      return json({ ok: true, value: body.paid ? now : null });
    }

    if (body.action === 'refer') return await refer(env, id, body, now);

    return json({ error: 'unknown action' }, 400);
  } catch (err) {
    console.error('dashboard action failed', body.action, err && err.message);
    return json({ error: 'Could not save — try again.' }, 500);
  }
}

// --------------------------------------------------------------- referral

// Records a tuning lead as referred to World Class Piano Tuners. The usual
// path is `manual`: the owner hands it over by phone or text and this logs
// it for payout tracking. Without `manual` it also emails World Class, which
// needs WORLDCLASS_EMAIL.
async function refer(env, id, body, now) {
  const lead = await env.DB.prepare(`SELECT ${COLUMNS.join(', ')} FROM leads WHERE id = ?`).bind(id).first();
  if (!lead) return json({ error: 'Lead not found.' }, 404);

  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const address = clip(body.address, 300) || lead.address || '';
  const system = clip(body.system, 200) || lead.system || '';
  const times = clip(body.times, 300);
  const note = clip(body.note, 2000);
  const refNo = `PPT-${lead.id}`;

  if (!body.manual) {
    if (!env.WORLDCLASS_EMAIL || !env.RESEND_API_KEY) {
      return json({ error: 'Add a WORLDCLASS_EMAIL variable in Cloudflare Pages settings, then redeploy.' }, 503);
    }
    if (!lead.phone && !lead.email) return json({ error: 'This lead has no phone or email for World Class to use.' }, 400);

    const sent = await sendEmail(env, worldClassEmail(env, lead, { address, system, times, note, refNo }));
    if (!sent) return json({ error: 'The email to World Class did not go out. Nothing was marked as sent — try again.' }, 502);
  }

  const stamp = now.slice(0, 10);
  const how = body.manual ? 'Referred to World Class' : 'Emailed to World Class';
  const line = `[${stamp}] ${how} (${refNo})${note ? `: ${note}` : ''}`;

  await env.DB.prepare(
    `UPDATE leads SET address = ?, system = ?, status = 'referred',
            referred_at = COALESCE(referred_at, ?),
            referral_status = COALESCE(referral_status, 'sent'),
            notes = TRIM(COALESCE(notes, '') || char(10) || ?),
            updated_at = ?
      WHERE id = ?`
  ).bind(address, system, now, line, now, id).run();

  // The customer is about to get a call from a company they've never heard
  // of. One line from us first makes that call get answered.
  if (body.tellCustomer && lead.email) {
    await sendEmail(env, customerHandoffEmail(env, lead));
  }

  const row = await env.DB.prepare(`SELECT ${COLUMNS.join(', ')} FROM leads WHERE id = ?`).bind(id).first();
  return json({ ok: true, row });
}

function worldClassEmail(env, lead, r) {
  const fields = parseFields(lead.fields);
  const rows = [
    ['Customer', lead.name || '—'],
    ['Phone', lead.phone || '—'],
    ['Email', lead.email || '—'],
    ['Address', r.address || lead.city || 'Not given — ask when you call'],
    ['Piano', r.system || '—'],
    ['Number of pianos', fields.pianos || '—'],
    ['Preferred times', r.times || fields.preferred_dates || '—'],
    ['What they told us', lead.message || '—'],
    ['Note from PianoPlayerTech', r.note || '—'],
    ['Referral #', r.refNo]
  ];

  const who = [lead.name || 'New customer', lead.city].filter(Boolean).join(', ');
  const html = `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:15px;line-height:1.6;color:#241d16;max-width:560px">
  <p style="margin:0 0 .3rem;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#96742a;font-weight:600">Tuning referral &middot; ${escape_(r.refNo)}</p>
  <h2 style="margin:0 0 .6rem;font-size:20px">${escape_(lead.name || 'New customer')}</h2>
  <p style="margin:0 0 1.1rem">They're expecting a call to schedule their tuning. Please reach out as soon as you can.</p>
  <table style="border-collapse:collapse;font-size:14px;width:100%">${rows.map(([k, v]) =>
    `<tr><td style="padding:5px 14px 5px 0;color:#7a6c5d;vertical-align:top;white-space:nowrap">${escape_(k)}</td>
         <td style="padding:5px 0">${escape_(v).replace(/\n/g, '<br>')}</td></tr>`).join('')}</table>
  <p style="margin:1.4rem 0 0;padding-top:.9rem;border-top:1px solid #ded3c0;font-size:13px;color:#7a6c5d">
    Referred by PianoPlayerTech &middot; (470) 758-9572 &middot; info@pianoplayertech.com<br>
    Please quote <strong>${escape_(r.refNo)}</strong> when settling referrals. Reply to this email with any questions.
  </p>
</div>`;

  const text = [
    `TUNING REFERRAL ${r.refNo}`,
    '',
    "They're expecting a call to schedule their tuning. Please reach out as soon as you can.",
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'Referred by PianoPlayerTech · (470) 758-9572 · info@pianoplayertech.com',
    `Please quote ${r.refNo} when settling referrals.`
  ].join('\n');

  const us = env.LEAD_NOTIFY_EMAIL || 'info@pianoplayertech.com';
  return {
    from: env.LEAD_FROM_EMAIL || 'PianoPlayerTech <info@pianoplayertech.com>',
    to: [env.WORLDCLASS_EMAIL],
    // Our copy is the paper trail for what we're owed.
    cc: [us],
    reply_to: us,
    subject: `Tuning referral ${r.refNo} — ${who}`,
    text, html
  };
}

function customerHandoffEmail(env, lead) {
  const name = (lead.name || '').split(' ')[0] || 'there';
  const text = [
    `Hi ${name},`,
    '',
    'Thanks for talking with us. Your tuning will be done by our partner, World Class Piano Tuners — they\'ll call you shortly to set a time, so please pick up if you see a number you don\'t recognize.',
    '',
    'Questions in the meantime? Call us at (470) 758-9572.',
    '',
    '— PianoPlayerTech'
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:15px;line-height:1.65;color:#241d16;max-width:520px">
  <p>Hi ${escape_(name)},</p>
  <p>Thanks for talking with us. Your tuning will be done by our partner, <strong>World Class Piano Tuners</strong> &mdash; they&rsquo;ll call you shortly to set a time, so please pick up if you see a number you don&rsquo;t recognize.</p>
  <p>Questions in the meantime? Call us at <a href="tel:4707589572" style="color:#96742a">(470)&nbsp;758-9572</a>.</p>
  <p style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #ded3c0;font-size:13px;color:#5c5045"><strong>PianoPlayerTech</strong><br>Metro Atlanta &amp; North Georgia</p>
</div>`;
  return {
    from: env.LEAD_FROM_EMAIL || 'PianoPlayerTech <info@pianoplayertech.com>',
    to: [lead.email],
    reply_to: env.LEAD_NOTIFY_EMAIL || 'info@pianoplayertech.com',
    subject: 'World Class Piano Tuners will call you to schedule',
    text, html
  };
}

async function sendEmail(env, payload) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) console.error('resend referral failed', r.status, await r.text().catch(() => ''));
    return r.ok;
  } catch (err) {
    console.error('resend referral threw', err && err.message);
    return false;
  }
}

// ---------------------------------------------------------------- stripe

async function stripe(env, method, path, params, idempotencyKey) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') form.append(k, String(v));
  }
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': STRIPE_VERSION };
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const qs = !hasBody && [...form].length ? `?${form}` : '';
  const r = await fetch(`https://api.stripe.com/v1/${path}${qs}`, { method, headers, body: hasBody ? form.toString() : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j.error && j.error.message) || `Stripe error ${r.status}`);
    e.stripe = true;
    throw e;
  }
  return j;
}

function releaseReferrals(env, invoiceId) {
  return env.DB.prepare('UPDATE leads SET referral_invoice_id = NULL WHERE referral_invoice_id = ?').bind(invoiceId).run();
}

// Builds, finalizes and emails a Stripe invoice. Referral invoices are
// priced here from the referrals themselves — the browser only says which
// ones — and each referral is claimed first so it can never be billed twice.
async function createInvoice(env, body, now) {
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const billTo = clip(body.billTo, 200);
  const email = clip(body.email, 200).toLowerCase();
  const memo = clip(body.memo, 500);
  const days = Math.min(Math.max(parseInt(body.days, 10) || 14, 1), 90);
  const leadId = Number.isInteger(parseInt(body.leadId, 10)) ? parseInt(body.leadId, 10) : null;
  if (!billTo) return json({ error: 'Who is this invoice for?' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Enter a valid email — Stripe sends the invoice there.' }, 400);

  let kind = 'custom';
  let lines;
  let referralIds = [];
  if (Array.isArray(body.referralIds) && body.referralIds.length) {
    kind = 'referral';
    referralIds = [...new Set(body.referralIds.map((n) => parseInt(n, 10)).filter(Number.isInteger))].slice(0, 200);
    const ph = referralIds.map(() => '?').join(',');
    const refs = (await env.DB.prepare(
      `SELECT id, name FROM leads WHERE id IN (${ph}) AND referral_status = 'booked'
          AND referral_paid_at IS NULL AND referral_invoice_id IS NULL ORDER BY id`
    ).bind(...referralIds).all()).results || [];
    if (refs.length !== referralIds.length) {
      return json({ error: 'Some of those referrals were already billed or paid. Reload and try again.' }, 409);
    }
    lines = refs.map((r) => ({ description: `Tuning referral PPT-${r.id}${r.name ? ` — ${r.name}` : ''}`, cents: REFERRAL_FEE * 100 }));
  } else {
    lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, MAX_LINES)
      .map((l) => ({ description: clip(l && l.description, 300), cents: Math.round(Number(l && l.amount) * 100) }))
      .filter((l) => l.description || l.cents);
    if (!lines.length) return json({ error: 'Add at least one line.' }, 400);
    if (lines.some((l) => !l.description || !Number.isInteger(l.cents) || l.cents < 50 || l.cents > MAX_LINE_CENTS)) {
      return json({ error: 'Each line needs a description and an amount between $0.50 and $50,000.' }, 400);
    }
  }
  const total = lines.reduce((a, l) => a + l.cents, 0);

  const local = await env.DB.prepare(
    `INSERT INTO invoices (created_at, kind, lead_id, bill_to, email, description, amount_cents, status, lines)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'creating', ?) RETURNING id`
  ).bind(now, kind, leadId, billTo, email, memo, total, JSON.stringify(lines)).first();
  const invId = local.id;

  const abandon = async () => {
    await releaseReferrals(env, invId);
    await env.DB.prepare('DELETE FROM invoices WHERE id = ?').bind(invId).run();
  };

  if (kind === 'referral') {
    const ph = referralIds.map(() => '?').join(',');
    const claim = await env.DB.prepare(
      `UPDATE leads SET referral_invoice_id = ? WHERE id IN (${ph}) AND referral_invoice_id IS NULL`
    ).bind(invId, ...referralIds).run();
    if (!claim.meta || claim.meta.changes !== referralIds.length) {
      await abandon();
      return json({ error: 'Some of those referrals were just billed. Reload and try again.' }, 409);
    }
  }

  const key = `ppt-inv-${invId}`;
  let draft = null;
  let finalized = null;
  try {
    const found = await stripe(env, 'GET', 'customers', { email, limit: 1 });
    const customer = (found.data && found.data[0]) ||
      await stripe(env, 'POST', 'customers', { name: billTo, email }, `${key}-customer`);

    draft = await stripe(env, 'POST', 'invoices', {
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: days,
      auto_advance: 'false',
      pending_invoice_items_behavior: 'exclude',
      description: memo,
      footer: 'PianoPlayerTech · (470) 758-9572 · info@pianoplayertech.com',
      'metadata[ppt_invoice]': invId,
      'metadata[kind]': kind
    }, key);

    for (let i = 0; i < lines.length; i++) {
      await stripe(env, 'POST', 'invoiceitems', {
        customer: customer.id, invoice: draft.id, currency: 'usd',
        amount: lines[i].cents, description: lines[i].description
      }, `${key}-item-${i}`);
    }

    finalized = await stripe(env, 'POST', `invoices/${draft.id}/finalize`, { auto_advance: 'false' }, `${key}-finalize`);
  } catch (err) {
    // Never leave a half-built invoice behind: delete the Stripe draft and
    // give the referrals back so they can be billed again.
    if (draft && !finalized) { try { await stripe(env, 'DELETE', `invoices/${draft.id}`); } catch { /* best effort */ } }
    await abandon();
    throw err;
  }

  // From here the invoice is real. If Stripe can't email it, keep it and
  // say so — the pay link still works.
  let sent = finalized;
  let warning = '';
  try {
    sent = await stripe(env, 'POST', `invoices/${finalized.id}/send`, null, `${key}-send`);
  } catch (err) {
    warning = `The invoice was created but Stripe couldn't email it (${err.message}). Copy the pay link and send it yourself.`;
  }

  await env.DB.prepare(
    `UPDATE invoices SET stripe_id = ?, number = ?, status = ?, hosted_url = ?, due_date = ? WHERE id = ?`
  ).bind(
    sent.id, sent.number || null, sent.status || 'open', sent.hosted_invoice_url || null,
    sent.due_date ? new Date(sent.due_date * 1000).toISOString() : null, invId
  ).run();

  const invoice = await env.DB.prepare(`SELECT ${INVOICE_COLUMNS.join(', ')} FROM invoices WHERE id = ?`).bind(invId).first();
  return json({ ok: true, invoice, warning });
}

async function voidInvoice(env, id) {
  if (!Number.isInteger(id)) return json({ error: 'bad id' }, 400);
  const inv = await env.DB.prepare('SELECT id, stripe_id, status FROM invoices WHERE id = ?').bind(id).first();
  if (!inv || inv.status !== 'open' || !inv.stripe_id) return json({ error: 'Only unpaid invoices can be voided.' }, 400);
  const s = await stripe(env, 'POST', `invoices/${inv.stripe_id}/void`, null, `ppt-void-${inv.id}`);
  await applyStripeStatus(env, inv.id, s);
  const invoice = await env.DB.prepare(`SELECT ${INVOICE_COLUMNS.join(', ')} FROM invoices WHERE id = ?`).bind(id).first();
  return json({ ok: true, invoice });
}

// Mirrors Stripe's view of an invoice into D1. A paid referral invoice marks
// its referrals paid; a voided one frees them to be billed again.
async function applyStripeStatus(env, id, s) {
  const paidAt = s.status === 'paid'
    ? new Date(((s.status_transitions && s.status_transitions.paid_at) || Date.now() / 1000) * 1000).toISOString()
    : null;
  await env.DB.prepare(
    'UPDATE invoices SET status = ?, paid_at = COALESCE(paid_at, ?), hosted_url = COALESCE(?, hosted_url) WHERE id = ?'
  ).bind(s.status, paidAt, s.hosted_invoice_url || null, id).run();
  if (s.status === 'paid') {
    await env.DB.prepare(
      `UPDATE leads SET referral_paid_at = COALESCE(referral_paid_at, ?), referral_status = 'booked'
        WHERE referral_invoice_id = ?`
    ).bind(paidAt, id).run();
  } else if (s.status === 'void') {
    await releaseReferrals(env, id);
  }
}

// No webhook to configure: open invoices are checked against Stripe when
// the Invoices or Referrals tab loads. A small business has a handful open
// at a time, and they're checked in parallel.
async function syncInvoices(env) {
  let open = [];
  try {
    open = (await env.DB.prepare(
      `SELECT id, stripe_id FROM invoices WHERE status = 'open' AND stripe_id IS NOT NULL ORDER BY id DESC LIMIT 25`
    ).all()).results || [];
  } catch { return; }
  await Promise.allSettled(open.map(async (row) => {
    const s = await stripe(env, 'GET', `invoices/${encodeURIComponent(row.stripe_id)}`);
    if (s.status && s.status !== 'open') await applyStripeStatus(env, row.id, s);
  }));
}

// -------------------------------------------------------------------- csv

// Opens cleanly in Excel and Google Sheets. Cells that a spreadsheet would
// run as a formula get a leading apostrophe — the data came from a public
// form. Phone numbers like "+1 770…" are left alone.
function toCsv(rows, columns) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=@\t\r]/.test(s) || /^[+-](?![\d\s().-]*$)/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))];
  return '﻿' + lines.join('\r\n');
}

// ------------------------------------------------------------------ views


function parseFields(raw) {
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}



function loginPage(bad) {
  return page('Leads', `
    <div class="card narrow" style="max-width:340px">
      <h1>Leads</h1>
      <p class="muted">PianoPlayerTech</p>
      <form method="post">
        <input type="hidden" name="action" value="login">
        <input type="password" name="password" placeholder="Password" autofocus required
               autocomplete="current-password">
        ${bad ? '<p class="err">Wrong password.</p>' : ''}
        <button class="go full" type="submit">Open</button>
      </form>
    </div>`);
}

function dashboard(view, rows, counts, ref, extra, nonce) {
  const tab = (key) => {
    const n = counts[key] || 0;
    return `<a class="tab${key === view ? ' on' : ''}" href="/leads?p=${key}">${VIEWS[key]}${
      n ? `<span class="pill">${n}</span>` : ''}</a>`;
  };

  // Everything the grid needs, handed to the script as data. `<` is escaped
  // so no value a customer typed can close this script tag.
  const data = JSON.stringify({
    view, rows, statuses: STATUSES, setStatuses: SET_STATUSES,
    refStatuses: REFERRAL_STATUSES, fee: REFERRAL_FEE, ref, ...extra
  }).replace(/</g, '\\u003c');

  return page(VIEWS[view], `
    <div class="top">
      <h1>Leads</h1>
      <form method="post">${extra.who ? `<span class="muted">${escape_(extra.who)} &nbsp;</span>` : ''}
        <input type="hidden" name="action" value="logout">
        <button class="linkbtn" type="submit">Sign out</button></form>
    </div>
    <nav class="tabs">${Object.keys(VIEWS).map(tab).join('')}</nav>
    <div class="stats" id="stats" ${view === 'repair' ? 'hidden' : ''}></div>
    <div class="banner" id="banner" hidden></div>
    <div class="tools" id="tools">
      <input type="search" id="q" placeholder="Search name, phone, address, piano, notes…" aria-label="Search">
      <select id="sf" aria-label="Filter"></select>
      <span class="muted" id="shown"></span>
      <a href="/leads?p=${view}&amp;export=csv">Export CSV</a>
    </div>
    <div class="gridwrap"><table><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table>
      <div class="empty" id="empty" hidden>Nothing here yet.</div></div>
    <dialog id="dlg"><div class="dlg" id="dlgbody"></div></dialog>
    <script type="application/json" id="data">${data}</script>`, GRID_JS, nonce);
}

// Client side. Every customer-supplied value goes into the page through
// textContent or .value — never innerHTML — so nothing a form submits can
// run as markup.
const GRID_JS = `
(function(){
  var D = JSON.parse(document.getElementById('data').textContent);
  var rows = D.rows, view = D.view;
  var REF_LABEL = {sent:'Sent — waiting', booked:'Booked', no_booking:"Didn't book"};

  var COLS = [
    {k:'name', label:'Name', type:'name', w:240},
    {k:'phone', label:'Phone', type:'phone', w:170},
    {k:'status', label:'Status', type:'select', opts:D.setStatuses, w:110}
  ];
  if (view === 'referrals') {
    COLS.push(
      {k:'id', label:'Referral #', type:'ref', w:95},
      {k:'referred_at', label:'Sent', type:'date', w:120},
      {k:'referral_status', label:'Outcome', type:'select', opts:D.refStatuses, labels:REF_LABEL, w:140},
      {k:'referral_paid_at', label:'$' + D.fee + ' paid', type:'paid', w:80},
      {k:'referral_invoice_id', label:'Invoice', type:'inv', w:150},
      {k:'address', label:'Address', type:'text', w:220},
      {k:'system', label:'Piano', type:'text', w:170},
      {k:'notes', label:'Notes', type:'text', w:280}
    );
  } else {
    COLS.push(
      {k:'created_at', label:'Received', type:'date', w:120},
      {k:'system', label:'Piano / system', type:'text', w:170},
      {k:'service', label:'Service', type:'text', w:150},
      {k:'city', label:'City', type:'text', w:120},
      {k:'address', label:'Address', type:'text', w:210},
      {k:'email', label:'Email', type:'text', w:210},
      {k:'message', label:'What they said', type:'long', w:260},
      {k:'notes', label:'Notes', type:'text', w:260}
    );
    if (view !== 'repair') {
      COLS.push(
        {k:'referral_status', label:'Referral', type:'refer', opts:D.refStatuses, labels:REF_LABEL, blank:true, w:140},
        {k:'referral_paid_at', label:'$' + D.fee + ' paid', type:'paid', w:80}
      );
    }
    COLS.push({k:'pipeline', label:'Pipeline', type:'select', opts:['repair','tuning'], w:100});
  }

  var head = document.getElementById('head'), body = document.getElementById('body');
  var q = document.getElementById('q'), sf = document.getElementById('sf');
  var shown = document.getElementById('shown'), empty = document.getElementById('empty');
  var dlg = document.getElementById('dlg'), dlgbody = document.getElementById('dlgbody');
  var sortKey = null, sortDir = 1;

  function el(tag, props, kids){
    var n = document.createElement(tag);
    if (props) for (var p in props) {
      if (p === 'text') n.textContent = props[p];
      else if (p === 'on') for (var ev in props.on) n.addEventListener(ev, props.on[ev]);
      else if (p in n) n[p] = props[p]; else n.setAttribute(p, props[p]);
    }
    (kids || []).forEach(function(k){ if (k) n.appendChild(k); });
    return n;
  }
  function fmt(ts){
    if (!ts) return '';
    var d = new Date(ts); if (isNaN(d)) return ts;
    return d.toLocaleDateString([], {month:'short', day:'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : '2-digit'});
  }
  function fmtLong(ts){ var d = new Date(ts); return isNaN(d) ? '' : d.toLocaleString(); }
  function tel(p){ return String(p || '').replace(/[^0-9+]/g, ''); }
  function money(c){ return '$' + (Number(c || 0) / 100).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); }
  var INV_LABEL = {open:'Unpaid', paid:'Paid', void:'Void', uncollectible:'Uncollectible', draft:'Draft'};
  function invById(id){
    for (var i = 0; i < D.invoices.length; i++) if (D.invoices[i].id === id) return D.invoices[i];
    return null;
  }
  function showDlg(){ if (!dlg.open) dlg.showModal(); }
  function fields(r){ try { return JSON.parse(r.fields || '{}') || {}; } catch(e){ return {}; } }

  function post(payload){
    return fetch('/leads', {method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})
    .then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(j){
        if (!res.ok) throw new Error(j.error || ('Error ' + res.status));
        return j;
      });
    });
  }
  function flash(td, ok){
    td.classList.remove('ok','bad'); void td.offsetWidth;
    td.classList.add(ok ? 'ok' : 'bad');
  }

  // ---- stats (tuning, referrals, all)
  function renderStats(){
    var box = document.getElementById('stats');
    if (box.hidden) return;
    var r = D.ref, owed = (r.booked - r.paid) * D.fee;
    // "Didn't book" and a raw paid count live in the filter; five boxes keep
    // the grid above the fold on a phone.
    var items = [
      [r.sent, 'Referred'], [r.sent - r.booked - r.lost, 'Waiting to hear'], [r.booked, 'Booked'],
      ['$' + owed, 'Owed to you', 'owed'], ['$' + (r.paid * D.fee), 'Earned']
    ];
    box.textContent = '';
    items.forEach(function(it){
      box.appendChild(el('div', {className:'stat' + (it[2] ? ' ' + it[2] : '')},
        [el('b', {text:String(it[0])}), el('span', {text:it[1]})]));
    });
  }
  // Recount after a change, from rows we can see plus the server's totals.
  function bumpRef(before, after){
    function add(r, s){
      if (!r.referred_at) return;
      D.ref.sent += s;
      if (r.referral_status === 'booked') D.ref.booked += s;
      if (r.referral_status === 'no_booking') D.ref.lost += s;
      if (r.referral_status === 'booked' && r.referral_paid_at) D.ref.paid += s;
    }
    add(before, -1); add(after, 1); renderStats();
  }

  // ---- filter options
  var FILTERS = view === 'referrals'
    ? [['', 'All referrals'], ['ref:sent', 'Waiting to hear'], ['ref:booked', 'Booked'],
       ['ref:unpaid', 'Booked, not paid'], ['ref:paid', 'Paid'], ['ref:no_booking', "Didn't book"]]
    : [['', 'Every status'], ['open', 'Not closed']].concat(D.statuses.map(function(s){ return [s, s]; }));
  FILTERS.forEach(function(f){ sf.appendChild(el('option', {value:f[0], text:f[1]})); });

  function passes(r){
    var f = sf.value;
    if (f === 'open' && r.status === 'closed') return false;
    if (f && f.indexOf('ref:') === 0) {
      var want = f.slice(4);
      if (want === 'unpaid') { if (r.referral_status !== 'booked' || r.referral_paid_at) return false; }
      else if (want === 'paid') { if (!r.referral_paid_at) return false; }
      else if (r.referral_status !== want) return false;
    } else if (f && f !== 'open' && r.status !== f) return false;
    var s = q.value.trim().toLowerCase();
    if (!s) return true;
    return ['name','phone','email','city','address','system','service','message','notes','id']
      .some(function(k){ return String(r[k] == null ? '' : r[k]).toLowerCase().indexOf(s) >= 0; });
  }

  // ---- grid
  function renderHead(){
    head.textContent = '';
    COLS.forEach(function(c, i){
      var th = el('th', {text: c.label + (sortKey === c.k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''),
        className: (i === 0 ? 'sticky ' : '') + (sortKey === c.k ? 'sorted' : ''),
        on:{click:function(){ if (sortKey === c.k) sortDir = -sortDir; else { sortKey = c.k; sortDir = 1; } render(); }}});
      th.style.minWidth = c.w + 'px';
      head.appendChild(th);
    });
  }

  function cellSelect(r, c, td){
    var v = r[c.k] == null ? '' : r[c.k];
    var sel = el('select', {'aria-label':c.label});
    if (c.blank || !v) sel.appendChild(el('option', {value:'', text:'—'}));
    // A stored value nobody may choose any more — 'referred' — still has to
    // show on the leads that already carry it. Added disabled, so it displays
    // without being something you could pick for yourself.
    if (v && c.opts.indexOf(String(v)) < 0) {
      sel.appendChild(el('option', {value:String(v), disabled:true,
        text:(c.labels && c.labels[v]) || String(v)}));
    }
    c.opts.forEach(function(o){ sel.appendChild(el('option', {value:o, text:(c.labels && c.labels[o]) || o})); });
    sel.value = String(v);
    if (c.k === 'referral_status' && !r.referred_at) sel.disabled = true;
    sel.addEventListener('change', function(){
      if (!sel.value) { sel.value = String(r[c.k] || ''); return; }
      save(r, c.k, sel.value, td);
    });
    return sel;
  }

  function cell(r, c, i){
    var td = el('td', {className: i === 0 ? 'sticky' : ''});
    td.style.minWidth = c.w + 'px'; td.style.maxWidth = (c.w + 80) + 'px';
    var v = r[c.k] == null ? '' : r[c.k];

    function input(){
      var inp = el('input', {value:String(v), 'aria-label':c.label});
      inp.addEventListener('change', function(){ save(r, c.k, inp.value, td); });
      return inp;
    }

    if (c.type === 'name') {
      td.appendChild(el('div', {className:'namecell'}, [
        el('button', {className:'open', text:'Open', title:'Open the whole lead', type:'button',
          on:{click:function(){ openLead(r); }}}),
        input()
      ]));
    } else if (c.type === 'phone') {
      td.appendChild(el('div', {className:'phonecell'}, [
        input(), tel(v) ? el('a', {href:'tel:' + tel(v), text:'call', title:'Call'}) : null
      ]));
    } else if (c.type === 'text') {
      td.appendChild(input());
    } else if (c.type === 'refer') {
      // Before a referral exists this column used to be a disabled dropdown —
      // the one control named "Referral", greyed out on exactly the leads you
      // want to refer. It is now the button that starts the referral.
      if (r.referred_at) {
        td.appendChild(cellSelect(r, c, td));
      } else if (r.pipeline === 'tuning') {
        td.appendChild(el('button', {className:'refergo', type:'button', text:'Refer →',
          title:'Send this lead to World Class',
          on:{click:function(){ openRefer(r); }}}));
      }
      // A repair lead gets nothing here: World Class takes tuning work. The
      // All tab mixes both pipelines, so this column would otherwise put a
      // prominent button on jobs that should never be handed over.
    } else if (c.type === 'select') {
      td.appendChild(cellSelect(r, c, td));
    } else if (c.type === 'paid') {
      var cb = el('input', {type:'checkbox', checked:!!v, 'aria-label':'Paid',
        title: r.referred_at ? (v ? 'Paid ' + fmtLong(v) : 'Mark as paid') : 'Not referred yet'});
      cb.disabled = !r.referred_at;
      cb.addEventListener('change', function(){
        var before = Object.assign({}, r);
        post({action:'paid', id:r.id, paid:cb.checked}).then(function(j){
          r.referral_paid_at = j.value;
          if (j.value) r.referral_status = 'booked';
          bumpRef(before, r); flash(td, true);
          if (j.value) render();
        }, function(e){ cb.checked = !cb.checked; flash(td, false); alert(e.message); });
      });
      td.appendChild(cb);
    } else if (c.type === 'inv') {
      var inv = v ? invById(v) : null;
      var billed = inv ? (inv.number || 'Invoice') + ' · ' + (INV_LABEL[inv.status] || inv.status)
        : (r.referral_status === 'booked' && !r.referral_paid_at ? 'Not billed yet' : '');
      td.appendChild(el('div', {className:'ro', text:billed, title:billed}));
    } else if (c.type === 'ref') {
      td.appendChild(el('div', {className:'ro', text:'PPT-' + r.id}));
    } else if (c.type === 'date') {
      td.appendChild(el('div', {className:'ro', text:fmt(v), title:fmtLong(v)}));
    } else {
      td.appendChild(el('div', {className:'ro', text:String(v), title:String(v)}));
    }
    return td;
  }

  function rowEl(r){
    var tr = el('tr', {className: r.status === 'new' ? 'is-new' : r.status === 'closed' ? 'done' : ''});
    COLS.forEach(function(c, i){ tr.appendChild(cell(r, c, i)); });
    return tr;
  }

  function render(){
    renderHead();
    var list = rows.filter(passes);
    if (sortKey) {
      list.sort(function(a, b){
        var x = a[sortKey] == null ? '' : String(a[sortKey]), y = b[sortKey] == null ? '' : String(b[sortKey]);
        if (!x && y) return 1; if (x && !y) return -1;
        return x.localeCompare(y, undefined, {numeric:true, sensitivity:'base'}) * sortDir;
      });
    }
    body.textContent = '';
    var frag = document.createDocumentFragment();
    list.forEach(function(r){ frag.appendChild(rowEl(r)); });
    body.appendChild(frag);
    empty.hidden = list.length > 0;
    renderBanner();
    shown.textContent = list.length === rows.length
      ? rows.length + (rows.length === 1 ? ' row' : ' rows') : list.length + ' of ' + rows.length;
  }

  function save(r, field, value, td){
    var before = Object.assign({}, r);
    post({action:'update', id:r.id, field:field, value:value}).then(function(j){
      r[field] = j.value;
      if (field === 'referral_status' && j.value !== 'booked') r.referral_paid_at = null;
      if (field === 'referral_status') bumpRef(before, r);
      flash(td, true);
      // Moved to the other pipeline: it no longer belongs on this tab.
      if (field === 'pipeline' && (view === 'repair' || view === 'tuning') && j.value !== view) {
        rows = rows.filter(function(x){ return x !== r; });
      }
      if (field === 'status' || field === 'pipeline' || field === 'referral_status') render();
    }, function(e){ flash(td, false); alert(e.message); });
  }

  // ---- lead detail + World Class referral

  // Straight from the grid's Refer button: just the referral form, no detour
  // through the full lead record.
  function openRefer(r){
    dlgbody.textContent = '';
    dlgHeader('Refer ' + (r.name || 'this lead'),
      [r.phone, r.city].filter(Boolean).join(' · ') || ('PPT-' + r.id));
    if (r.message) dlgbody.appendChild(el('div', {className:'msg', text:r.message}));
    dlgbody.appendChild(referBox(r, fields(r)));
    dlgbody.appendChild(el('p', null, [
      el('button', {className:'linkbtn', type:'button', text:'See the whole lead instead',
        on:{click:function(){ openLead(r); }}})
    ]));
    showDlg();
  }

  function openLead(r){
    dlgbody.textContent = '';
    var f = fields(r);
    var meta = [r.service, r.system, r.city].filter(Boolean).join(' · ');

    dlgbody.appendChild(el('div', {className:'hd'}, [
      el('div', null, [
        el('h2', {text: r.name || 'No name given'}),
        el('div', {className:'muted', text:'Received ' + fmtLong(r.created_at) + ' · PPT-' + r.id})
      ]),
      el('button', {className:'x', type:'button', text:'×', 'aria-label':'Close', on:{click:function(){ dlg.close(); }}})
    ]));
    if (meta) dlgbody.appendChild(el('div', {className:'meta', text:meta}));

    var contact = el('div', {className:'contact'});
    if (tel(r.phone)) contact.appendChild(el('a', {href:'tel:' + tel(r.phone), text:r.phone}));
    if (r.email) contact.appendChild(el('a', {href:'mailto:' + r.email, text:r.email}));
    if (r.address) contact.appendChild(el('a', {href:'https://maps.google.com/?q=' + encodeURIComponent(r.address),
      target:'_blank', rel:'noopener', text:'Map'}));
    dlgbody.appendChild(contact);

    if (r.message) dlgbody.appendChild(el('div', {className:'msg', text:r.message}));

    var keys = Object.keys(f);
    if (keys.length) {
      var dl = el('dl');
      keys.forEach(function(k){
        dl.appendChild(el('dt', {text:k.replace(/[_-]+/g, ' ')}));
        dl.appendChild(el('dd', {text:String(f[k])}));
      });
      dlgbody.appendChild(el('details', null, [el('summary', {text:'Everything they submitted'}), dl]));
    }
    if (r.notes) dlgbody.appendChild(el('div', {className:'msg', text:r.notes}));

    dlgbody.appendChild(referBox(r, f));
    dlgbody.appendChild(el('div', {className:'refer'}, [
      el('h3', {text:'Invoice'}),
      el('button', {className:'ghost', type:'button', text:'Create an invoice for ' + (r.name || 'this customer'),
        on:{click:function(){ invoiceDialog({billTo:r.name, email:r.email, leadId:r.id}); }}})
    ]));
    showDlg();
  }

  // ---- invoicing (Stripe)
  function dlgHeader(title, sub){
    dlgbody.appendChild(el('div', {className:'hd'}, [
      el('div', null, [el('h2', {text:title}), sub ? el('div', {className:'muted', text:sub}) : null]),
      el('button', {className:'x', type:'button', text:'×', 'aria-label':'Close', on:{click:function(){ dlg.close(); }}})
    ]));
  }

  // The monthly World Class bill on the Referrals tab.
  function renderBanner(){
    var b = document.getElementById('banner');
    if (view !== 'referrals') return;
    var due = rows.filter(function(r){ return r.referral_status === 'booked' && !r.referral_paid_at && !r.referral_invoice_id; });
    b.textContent = '';
    b.hidden = !due.length;
    if (!due.length) return;
    b.appendChild(el('span', {text: due.length + (due.length === 1 ? ' booked referral' : ' booked referrals') +
      ' not billed yet · ' + money(due.length * D.fee * 100)}));
    b.appendChild(el('button', {className:'go', type:'button', text:'Invoice World Class', on:{click:function(){
      invoiceDialog({title:'Invoice World Class', billTo:'World Class Piano Tuners', email:D.lastWcEmail, referrals:due,
        memo:'Tuning referral fees — ' + new Date().toLocaleDateString([], {month:'long', year:'numeric'})});
    }}}));
  }

  function invoiceDialog(pre){
    dlgbody.textContent = '';
    dlgHeader(pre.title || 'New invoice', 'Stripe emails it with a link to pay by card or bank.');
    if (!D.stripeReady) {
      dlgbody.appendChild(el('p', {className:'warn',
        text:"Stripe isn't connected yet. Add a STRIPE_SECRET_KEY secret in Cloudflare Pages settings, then redeploy."}));
      showDlg(); return;
    }
    var box = el('div', {className:'refer'});
    var billTo = el('input', {type:'text', value: pre.billTo || '', placeholder:'Name or company'});
    var email = el('input', {type:'email', value: pre.email || '', placeholder:'billing@example.com'});
    var days = el('input', {type:'number', value:'14', min:'1', max:'90'});
    var memo = el('textarea', {value: pre.memo || '', placeholder:'Shown on the invoice (optional)'});
    var totalEl = el('div', {className:'total'});
    var msg = el('p', {className:'warn'});
    var btn = el('button', {className:'go full', type:'button', text:'Create & send invoice'});
    var lineBox = el('div');
    var getLines, addLine;

    if (pre.referrals) {
      // Only which referrals — the server prices them.
      var checks = pre.referrals.map(function(r){
        var cb = el('input', {type:'checkbox', checked:true});
        cb.addEventListener('change', update);
        lineBox.appendChild(el('label', {className:'chk'}, [cb,
          document.createTextNode('PPT-' + r.id + (r.name ? ' — ' + r.name : '') + ' · ' + money(D.fee * 100))]));
        return {cb:cb, r:r};
      });
      getLines = function(){
        return checks.filter(function(c){ return c.cb.checked; }).map(function(c){ return {id:c.r.id, cents:D.fee * 100}; });
      };
    } else {
      var items = [];
      addLine = function(desc){
        var d = el('input', {type:'text', value: desc || '', placeholder:'Description'});
        var a = el('input', {type:'number', step:'0.01', min:'0', placeholder:'0.00', className:'amt', 'aria-label':'Amount'});
        var row = el('div', {className:'line'}, [d, a]);
        var item = {d:d, a:a};
        row.appendChild(el('button', {className:'x', type:'button', text:'×', title:'Remove line', on:{click:function(){
          if (items.length === 1) { d.value = ''; a.value = ''; update(); return; }
          items.splice(items.indexOf(item), 1); row.remove(); update();
        }}}));
        [d, a].forEach(function(i){ i.addEventListener('input', update); });
        items.push(item); lineBox.appendChild(row);
        return item;
      };
      addLine('');
      getLines = function(){
        return items.map(function(it){
          return {description: it.d.value.trim(), amount: it.a.value, cents: Math.round(parseFloat(it.a.value || '0') * 100) || 0};
        }).filter(function(l){ return l.description || l.cents; });
      };
    }
    function update(){
      var t = getLines().reduce(function(sum, l){ return sum + l.cents; }, 0);
      totalEl.textContent = 'Total ' + money(t);
      btn.disabled = t <= 0;
    }

    box.appendChild(el('label', {text:'Bill to'})); box.appendChild(billTo);
    box.appendChild(el('label', {text:'Email'})); box.appendChild(email);
    box.appendChild(el('label', {text: pre.referrals ? 'Referrals on this invoice' : 'Line items'})); box.appendChild(lineBox);
    if (!pre.referrals) box.appendChild(el('button', {className:'linkbtn', type:'button', text:'+ Add line',
      on:{click:function(){ addLine('').d.focus(); }}}));
    box.appendChild(el('label', {text:'Due in (days)'})); box.appendChild(days);
    box.appendChild(el('label', {text:'Memo'})); box.appendChild(memo);
    box.appendChild(totalEl); box.appendChild(btn); box.appendChild(msg);
    dlgbody.appendChild(box);
    update();

    btn.addEventListener('click', function(){
      var lines = getLines();
      var t = lines.reduce(function(sum, l){ return sum + l.cents; }, 0);
      if (!confirm('Email a ' + money(t) + ' invoice to ' + email.value.trim() + '?')) return;
      btn.disabled = true; btn.textContent = 'Creating…'; msg.textContent = '';
      var payload = {action:'invoice', billTo:billTo.value, email:email.value, days:days.value, memo:memo.value, leadId:pre.leadId || null};
      if (pre.referrals) payload.referralIds = lines.map(function(l){ return l.id; });
      else payload.lines = lines.map(function(l){ return {description:l.description, amount:l.amount}; });
      post(payload).then(function(j){
        var inv = j.invoice;
        D.invoices.unshift(inv);
        if (pre.referrals) {
          D.lastWcEmail = inv.email;
          rows.forEach(function(r){ if (payload.referralIds.indexOf(r.id) >= 0) r.referral_invoice_id = inv.id; });
        }
        if (view === 'invoices') renderInvoices(); else render();
        dlgbody.textContent = '';
        dlgHeader('Invoice ' + (inv.number || '') + ' sent', money(inv.amount_cents) + ' to ' + inv.email);
        if (j.warning) dlgbody.appendChild(el('p', {className:'warn', text:j.warning}));
        if (inv.hosted_url) dlgbody.appendChild(el('p', null, [
          el('a', {href:inv.hosted_url, target:'_blank', rel:'noopener', className:'go', text:'View invoice'})]));
      }, function(e){ btn.disabled = false; btn.textContent = 'Create & send invoice'; msg.textContent = e.message; });
    });
    showDlg();
  }

  // ---- Invoices tab
  function renderInvoices(){
    var f = sf.value, s = q.value.trim().toLowerCase(), now = new Date();
    var list = D.invoices.filter(function(i){
      if (f && i.status !== f) return false;
      if (!s) return true;
      return [i.bill_to, i.email, i.description, i.number, i.lines]
        .some(function(v){ return String(v || '').toLowerCase().indexOf(s) >= 0; });
    });
    head.textContent = '';
    ['Date', 'Invoice #', 'Bill to', 'Email', 'For', 'Amount', 'Status', 'Due', ''].forEach(function(h, i){
      head.appendChild(el('th', {text:h, className: i === 0 ? 'sticky' : ''}));
    });
    body.textContent = '';
    list.forEach(function(inv){
      var lines = []; try { lines = JSON.parse(inv.lines || '[]'); } catch(e){}
      var what = inv.description || lines.map(function(l){ return l.description; }).join('; ');
      var overdue = inv.status === 'open' && inv.due_date && new Date(inv.due_date) < now;
      function ro(t, cls){
        var td = el('td', {className: cls || ''});
        td.appendChild(el('div', {className:'ro', text:t, title:t}));
        return td;
      }
      var tr = el('tr', {className: inv.status === 'void' ? 'done' : ''});
      tr.appendChild(ro(fmt(inv.created_at), 'sticky'));
      tr.appendChild(ro(inv.number || '—'));
      tr.appendChild(ro(inv.bill_to || ''));
      tr.appendChild(ro(inv.email || ''));
      tr.appendChild(ro(what));
      tr.appendChild(ro(money(inv.amount_cents)));
      var st = ro(overdue ? 'Overdue' : (INV_LABEL[inv.status] || inv.status));
      st.firstChild.className += ' st-' + (overdue ? 'overdue' : inv.status);
      tr.appendChild(st);
      tr.appendChild(ro(inv.status === 'paid' ? 'Paid ' + fmt(inv.paid_at) : fmt(inv.due_date)));
      var acts = el('div', {className:'acts'});
      if (inv.hosted_url) {
        acts.appendChild(el('a', {href:inv.hosted_url, target:'_blank', rel:'noopener', text:'View'}));
        acts.appendChild(el('button', {className:'linkbtn', type:'button', text:'Copy link', on:{click:function(e){
          var b = e.target;
          navigator.clipboard.writeText(inv.hosted_url).then(function(){ b.textContent = 'Copied ✓'; },
            function(){ prompt('Copy this link:', inv.hosted_url); });
        }}}));
      }
      if (inv.status === 'open') acts.appendChild(el('button', {className:'linkbtn', type:'button', text:'Void', on:{click:function(){
        if (!confirm('Void invoice ' + (inv.number || '') + ' for ' + money(inv.amount_cents) + '? It can no longer be paid.')) return;
        post({action:'void', id:inv.id}).then(function(j){ Object.assign(inv, j.invoice); renderInvoices(); },
          function(e){ alert(e.message); });
      }}}));
      tr.appendChild(el('td', null, [acts]));
      body.appendChild(tr);
    });
    empty.hidden = list.length > 0;
    empty.textContent = D.stripeReady ? 'No invoices yet.'
      : "Stripe isn't connected yet. Add a STRIPE_SECRET_KEY secret in Cloudflare Pages settings, then redeploy.";
    shown.textContent = list.length + (list.length === 1 ? ' invoice' : ' invoices');

    var unpaid = 0, late = 0, paid = 0;
    D.invoices.forEach(function(i){
      if (i.status === 'open') { unpaid += i.amount_cents; if (i.due_date && new Date(i.due_date) < now) late += i.amount_cents; }
      if (i.status === 'paid') paid += i.amount_cents;
    });
    var box = document.getElementById('stats');
    box.textContent = '';
    [[money(unpaid), 'Unpaid', 'owed'], [money(late), 'Overdue'], [money(paid), 'Collected']].forEach(function(it){
      box.appendChild(el('div', {className:'stat' + (it[2] ? ' ' + it[2] : '')}, [el('b', {text:it[0]}), el('span', {text:it[1]})]));
    });
  }

  function initInvoices(){
    sf.textContent = '';
    [['', 'All invoices'], ['open', 'Unpaid'], ['paid', 'Paid'], ['void', 'Void']].forEach(function(f){
      sf.appendChild(el('option', {value:f[0], text:f[1]}));
    });
    var tools = document.getElementById('tools');
    tools.insertBefore(el('button', {className:'go', type:'button', text:'New invoice',
      on:{click:function(){ invoiceDialog({}); }}}), tools.firstChild);
    q.placeholder = 'Search name, email, invoice #…';
    q.addEventListener('input', renderInvoices);
    sf.addEventListener('change', renderInvoices);
    renderInvoices();
  }

  function referBox(r, f){
    var box = el('div', {className:'refer'});
    box.appendChild(el('h3', {text:'World Class referral'}));

    if (r.referred_at) {
      box.appendChild(el('div', {className:'sent',
        text:'Referred ' + fmtLong(r.referred_at) + ' as PPT-' + r.id + ' — ' +
          (REF_LABEL[r.referral_status] || 'sent') + (r.referral_paid_at ? ', paid ' + fmt(r.referral_paid_at) : '') +
          '. Track the outcome in the Referral column.'}));
      return box;
    }

    var addr = el('input', {type:'text', value: r.address || '', placeholder:'Street, city, ZIP'});
    var piano = el('input', {type:'text', value: r.system || (f.pianos ? f.pianos + ' piano(s)' : ''), placeholder:'e.g. Yamaha U1 upright'});
    var times = el('input', {type:'text', value: f.preferred_dates || '', placeholder:'e.g. weekday mornings'});
    var note = el('textarea', {placeholder:'Anything World Class should know — gate code, pitch raise likely, etc.'});
    var tell = el('input', {type:'checkbox', disabled: !r.email});
    var mark = el('button', {className:'go full', type:'button', text:'Mark as referred'});
    var texter = el('a', {className:'ghost', text:'Text details'});
    var copier = el('button', {className:'ghost', type:'button', text:'Copy details'});
    var emailer = D.wcReady ? el('button', {className:'linkbtn', type:'button', text:'Or email it to World Class instead'}) : null;
    var msg = el('p', {className:'warn'});

    // Referrals go to a person by phone, so the details are laid out to
    // paste into a text. The contact is picked in Messages.
    function details(){
      return ['Tuning referral PPT-' + r.id, r.name, r.phone, r.email, addr.value.trim(),
        piano.value.trim() && 'Piano: ' + piano.value.trim(),
        times.value.trim() && 'Best times: ' + times.value.trim(),
        note.value.trim() && 'Note: ' + note.value.trim(),
        r.message && 'They said: ' + r.message
      ].filter(Boolean).join('\\n');
    }
    function refreshText(){ texter.href = 'sms:?&body=' + encodeURIComponent(details()); }
    [addr, piano, times, note].forEach(function(i){ i.addEventListener('input', refreshText); });
    refreshText();
    copier.addEventListener('click', function(){
      navigator.clipboard.writeText(details()).then(function(){
        copier.textContent = 'Copied ✓'; setTimeout(function(){ copier.textContent = 'Copy details'; }, 1500);
      }, function(){ alert('Could not copy on this device — use Text details instead.'); });
    });

    function go(isManual){
      if (!isManual && !addr.value.trim() && !confirm('No address yet — send anyway? World Class will have to ask for it.')) return;
      var b = isManual ? mark : emailer, label = b.textContent;
      b.disabled = true; b.textContent = isManual ? 'Saving…' : 'Sending…'; msg.textContent = '';
      var before = Object.assign({}, r);
      post({action:'refer', id:r.id, manual:isManual, address:addr.value, system:piano.value,
            times:times.value, note:note.value, tellCustomer:tell.checked})
      .then(function(j){
        Object.assign(r, j.row);
        bumpRef(before, r); render(); openLead(r);
      }, function(e){ b.disabled = false; b.textContent = label; msg.textContent = e.message; });
    }
    mark.addEventListener('click', function(){ go(true); });
    if (emailer) emailer.addEventListener('click', function(){ go(false); });

    [['Address', addr], ['Piano', piano], ['Preferred times', times], ['Note for World Class', note]]
      .forEach(function(p){ box.appendChild(el('label', {text:p[0]})); box.appendChild(p[1]); });
    box.appendChild(el('div', {className:'pair'}, [texter, copier]));
    box.appendChild(el('label', {className:'chk'}, [tell,
      document.createTextNode(r.email ? 'Email ' + r.email + ' that World Class will call them' : 'No customer email on file')]));
    box.appendChild(mark);
    box.appendChild(msg);
    if (emailer) box.appendChild(el('p', null, [emailer]));
    return box;
  }

  dlg.addEventListener('click', function(e){ if (e.target === dlg) dlg.close(); });
  if (view === 'invoices') {
    initInvoices();
  } else {
    q.addEventListener('input', render);
    sf.addEventListener('change', render);
    renderStats();
    render();
  }
})();
`;
