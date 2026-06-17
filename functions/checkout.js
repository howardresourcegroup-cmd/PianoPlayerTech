/**
 * Cloudflare Pages Function — Stripe Embedded Checkout
 * POST /checkout  { priceId, customerEmail? }
 * Returns { clientSecret }
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

  const payload = {
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    ui_mode: 'elements',
    return_url: 'https://pianoplayertech.com/checkout-return?session_id={CHECKOUT_SESSION_ID}',
    ...(customerEmail ? { customer_email: customerEmail } : {}),

  };

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
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

function encode(obj, prefix) {
  const parts = [];
  for (const key in obj) {
    const val = obj[key];
    const k = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      parts.push(encode(val, k));
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (typeof v === 'object') parts.push(encode(v, `${k}[${i}]`));
        else parts.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(v)}`);
      });
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
    }
  }
  return parts.join('&');
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
