// Stripe invoicing: the monthly referral bill and one-off invoices to anyone.
//
// Stripe is the source of truth for payment; the invoices table mirrors it so
// the dashboard can list and total without calling Stripe for every row.
// The API version is pinned so an upgrade can never change what these calls
// mean.

import { json } from './html.js';
import { REFERRAL_FEE } from './db.js';

export const INVOICE_COLUMNS = [
  'id', 'created_at', 'kind', 'lead_id', 'bill_to', 'email', 'description', 'amount_cents',
  'status', 'number', 'due_date', 'paid_at', 'hosted_url', 'stripe_id', 'lines'
];

// Pinned so a Stripe API upgrade can never change what these calls mean.
export const STRIPE_VERSION = '2024-06-20';

export const MAX_LINES = 25;

export const MAX_LINE_CENTS = 5000000; // $50,000

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function releaseReferrals(env, invoiceId) {
  return env.DB.prepare('UPDATE leads SET referral_invoice_id = NULL WHERE referral_invoice_id = ?').bind(invoiceId).run();
}

// Builds, finalizes and emails a Stripe invoice. Referral invoices are
// priced here from the referrals themselves — the browser only says which
// ones — and each referral is claimed first so it can never be billed twice.
export async function createInvoice(env, body, now) {
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

export async function voidInvoice(env, id) {
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
export async function applyStripeStatus(env, id, s) {
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
export async function syncInvoices(env) {
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
