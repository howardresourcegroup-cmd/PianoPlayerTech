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
import {
  SESSION_HOURS, COOKIE, safeEqual, mintToken,
  accessMode, accessIdentity, emailAllowed, signedIn, authed, sameOrigin
} from './_lib/auth.js';
import {
  dashboard, VIEWS, SET_STATUSES, REFERRAL_STATUSES, REFERRAL_FEE
} from './_lib/grid.js';

const PIPELINES = ['repair', 'tuning'];

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

