/**
 * Cloudflare Pages Function — Stripe PaymentIntent for embedded Payment Element
 * POST /checkout  { priceId, customerEmail? }  -> { clientSecret }   (pi_..._secret_...)
 */

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const apiKey = env.STRIPE_SECRET_KEY;
  if (!apiKey) return json({ error: 'Stripe not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { priceId, customerEmail } = body;
  if (!priceId) return json({ error: 'No price ID' }, 400);

  // Look up the price so the amount stays in sync with the Stripe dashboard.
  const priceRes = await fetch(`https://api.stripe.com/v1/prices/${priceId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const price = await priceRes.json();
  if (!priceRes.ok || !price.unit_amount) {
    return json({ error: price.error?.message || 'Could not load price' }, 400);
  }

  // June 2026 promo — standard tuning drops to $150. Auto-reverts July 1 (UTC) with no action needed.
  const STANDARD_TUNING = 'price_1TjTApBmP21fsanuIfmJ93d9';
  const now = new Date();
  const isJune2026 = now.getUTCFullYear() === 2026 && now.getUTCMonth() === 5; // month 5 = June
  const promoApplied = isJune2026 && priceId === STANDARD_TUNING;
  const amount = promoApplied ? 15000 : price.unit_amount;

  const payload = {
    amount: amount,
    currency: price.currency,
    'automatic_payment_methods[enabled]': 'true',
    'metadata[priceId]': priceId,
    ...(promoApplied ? { 'metadata[promo]': 'june2026-150' } : {}),
    ...(customerEmail ? { receipt_email: customerEmail } : {}),
  };

  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encode(payload),
  });

  const data = await res.json();
  if (!res.ok) return json({ error: data.error?.message || 'Stripe error' }, res.status);
  return json({ clientSecret: data.client_secret });
}

function encode(obj) {
  return Object.keys(obj)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k])}`)
    .join('&');
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}
