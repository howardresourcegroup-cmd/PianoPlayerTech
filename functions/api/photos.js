// Photo upload for identification -> one email to us, with the photos attached.
//
// Cloudflare Pages -> pianoplayertech -> Settings (all shared with /api/lead):
//   RATE_LIMIT        (KV, optional)  abuse control
//   RESEND_API_KEY    (secret)        without it this endpoint answers 503
//   LEAD_FROM_EMAIL, LEAD_NOTIFY_EMAIL
//
// Unlike /api/lead this endpoint tells the truth about failure. A lead that
// fails to email is still in the database; a photo that fails to email is
// gone, so the page has to know and send the customer to plain email instead.

import {
  MAX_PHOTOS, MAX_TOTAL_BYTES, MAX_NOTE_CHARS,
  validEmail, checkUpload, buildPhotoEmail
} from '../_lib/photos.js';

const ALLOWED_HOSTS = new Set(['pianoplayertech.com', 'www.pianoplayertech.com']);

const RATE_MAX = 3;
const RATE_WINDOW_S = 600;

// Multipart overhead on top of the photos themselves.
const MAX_BODY_BYTES = MAX_TOTAL_BYTES + 256 * 1024;

// Stricter than /api/lead: a request that names no origin is refused. Losing
// a lead to a browser quirk costs money; an open upload endpoint costs more.
function originAllowed(request) {
  for (const c of [request.headers.get('Origin'), request.headers.get('Referer')]) {
    if (!c) continue;
    try {
      const host = new URL(c).hostname;
      if (ALLOWED_HOSTS.has(host) || host.endsWith('.pages.dev')) return true;
    } catch { /* malformed header: not a match */ }
  }
  return false;
}

async function rateLimited(env, request) {
  if (!env.RATE_LIMIT) return false;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return false;
  const key = `photos:${ip}`;
  try {
    const n = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
    if (n >= RATE_MAX) return true;
    await env.RATE_LIMIT.put(key, String(n + 1), { expirationTtl: RATE_WINDOW_S });
    return false;
  } catch (err) {
    console.error('photo rate limit check failed', err && err.message);
    return false;
  }
}

function reply(request, status, ok, message) {
  // The page asks for JSON. A browser with scripts off posts the form
  // natively and should land somewhere readable.
  const wantsJson = (request.headers.get('Accept') || '').includes('application/json');
  if (wantsJson) {
    return new Response(JSON.stringify({ ok, message }), {
      status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  if (ok) return Response.redirect(new URL('/thank-you', request.url).toString(), 303);
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

const FALLBACK = 'Please email your photos to info@pianoplayertech.com instead.';

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!originAllowed(request)) return reply(request, 403, false, 'Forbidden.');
  if (await rateLimited(env, request)) {
    return reply(request, 429, false, 'Too many uploads from this connection. ' + FALLBACK);
  }
  if (!env.RESEND_API_KEY) return reply(request, 503, false, 'Photo upload is not available right now. ' + FALLBACK);

  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > MAX_BODY_BYTES) return reply(request, 413, false, 'Those photos are too large together. Try sending fewer.');

  let form;
  try {
    form = await request.formData();
  } catch {
    return reply(request, 400, false, 'That upload could not be read. ' + FALLBACK);
  }

  const email = validEmail(form.get('email'));
  if (!email) return reply(request, 400, false, 'Please enter your email address so we can match the photos to you.');

  const name = String(form.get('name') || '').trim().slice(0, 120);
  const note = String(form.get('note') || '').trim().slice(0, MAX_NOTE_CHARS);

  // Count before reading anything into memory.
  const entries = form.getAll('photos').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0);
  if (entries.length > MAX_PHOTOS) return reply(request, 400, false, `Please send up to ${MAX_PHOTOS} photos at a time.`);
  if (entries.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
    return reply(request, 413, false, 'Those photos are too large together. Try sending fewer.');
  }

  const files = [];
  for (const f of entries) files.push({ bytes: new Uint8Array(await f.arrayBuffer()) });

  const checked = checkUpload(files);
  if (!checked.ok) return reply(request, 400, false, checked.error);

  let sent = false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPhotoEmail(env, { email, name, note, photos: checked.photos }))
    });
    sent = r.ok;
    if (!r.ok) console.error('resend photos failed', r.status, await r.text().catch(() => ''));
  } catch (err) {
    console.error('resend photos threw', err && err.message);
  }

  if (!sent) return reply(request, 502, false, 'We could not send those photos. ' + FALLBACK);
  return reply(request, 200, true, 'Photos received. We will match them to your message.');
}
