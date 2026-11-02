// Photo upload for identification -> one email to us, with the photos attached.
//
// "Send us a photo" is how most restorations start, so an upload from someone
// we have not heard from becomes a lead in its own right. From someone with a
// recent lead it is more information on that lead.
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
import { logQuietly } from '../_lib/activity.js';
import { classifyCategory } from '../_lib/category.js';
import { cleanAttribution, leadSource } from '../_lib/attribution.js';

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

function reply(request, status, ok, message, extra) {
  // The page asks for JSON. A browser with scripts off posts the form
  // natively and should land somewhere readable.
  const wantsJson = (request.headers.get('Accept') || '').includes('application/json');
  if (wantsJson) {
    return new Response(JSON.stringify({ ok, message, ...extra }), {
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

  // The honeypot, as on the lead forms. A bot hears what a person hears.
  if (String(form.get('_gotcha') || '').trim()) return reply(request, 200, true, 'Photos received.');

  const email = validEmail(form.get('email'));
  if (!email) return reply(request, 400, false, 'Please enter your email address so we can match the photos to you.');

  const name = String(form.get('name') || '').trim().slice(0, 120);
  const phone = String(form.get('phone') || '').trim().slice(0, 40);
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

  // Asked before the email, so the email can say whether this is a new lead.
  const now = new Date().toISOString();
  const known = await recentLeads(env, email, now);
  const isNew = !!known && known.length === 0;

  let sent = false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPhotoEmail(env, { email, name, phone, note, photos: checked.photos, isNew }))
    });
    sent = r.ok;
    if (!r.ok) console.error('resend photos failed', r.status, await r.text().catch(() => ''));
  } catch (err) {
    console.error('resend photos threw', err && err.message);
  }

  if (!sent) return reply(request, 502, false, 'We could not send those photos. ' + FALLBACK);
  // The photos themselves go only to the inbox: there is no file storage
  // behind the CRM. What the lead can carry is the fact that they arrived,
  // so whoever opens it knows to look in the email before calling.
  const wrote = isNew
    ? storeLead(env, { email, name, phone, note, count: files.length, source: pageOf(request, form),
        attribution: readAttribution(form) }, now)
    : known && known.length === 1 ? notePhotos(env, known[0], files.length, now) : null;
  if (wrote && typeof context.waitUntil === 'function') context.waitUntil(wrote);
  if (isNew) return reply(request, 200, true, 'Photos received. We will take a look and get back to you.', { lead: true });
  return reply(request, 200, true, 'Photos received. We will match them to your message.');
}

// Which page it came from. The form says; a page from an old cached script
// does not, and the Referer still knows.
function pageOf(request, form) {
  const sent = String(form.get('source') || '').trim();
  if (sent.charAt(0) === '/') return sent.slice(0, 500);
  try {
    return `${new URL(request.headers.get('Referer') || '').pathname} #photo-form`;
  } catch {
    return 'website #photo-form';
  }
}

function readAttribution(form) {
  try {
    return cleanAttribution(JSON.parse(String(form.get('attribution') || 'null').slice(0, 2000)));
  } catch {
    return null;
  }
}

// Live leads from the last 30 days with this email, at most two, because all
// that matters is none, one or several. Null when it cannot be told, which
// must not read as "none": that would make a lead out of a known customer.
const PHOTO_MATCH_DAYS = 30;
async function recentLeads(env, email, now) {
  if (!env.DB) return null;
  try {
    const since = new Date(Date.parse(now) - PHOTO_MATCH_DAYS * 86400000).toISOString();
    const r = await env.DB.prepare(
      `SELECT id, contact_id FROM leads
        WHERE LOWER(TRIM(email)) = ? AND archived_at IS NULL AND created_at >= ?
        ORDER BY created_at DESC LIMIT 2`).bind(email.toLowerCase(), since).all();
    return r.results || [];
  } catch (err) {
    console.error('photo lead lookup failed', err && err.message);
    return null;
  }
}

// A first contact by photo is a repair lead, categorised the way a form is.
// Never fails the upload: the photos have already been sent, and the inbox
// has everything this row would have held.
async function storeLead(env, { email, name, phone, note, count, source, attribution }, now) {
  const service = 'Photo Identification';
  const fields = { service_type: service, email };
  if (name) fields.name = name;
  if (phone) fields.phone = phone;
  if (note) fields.note = note;
  const lead = { pipeline: 'repair', source, service, message: note };
  const notes = `${count} photo${count === 1 ? ' was' : 's were'} sent from the website. They are in the lead-alert inbox, not stored here.`;
  const cols = ['created_at', 'pipeline', 'status', 'name', 'email', 'phone', 'service', 'message',
    'source', 'fields', 'notes', 'category', 'lead_source', 'attribution'];
  const vals = [now, 'repair', 'new', name, email, phone, service, note, source, JSON.stringify(fields), notes,
    classifyCategory(lead, note), leadSource(attribution, fields), attribution ? JSON.stringify(attribution) : null];
  // As in functions/api/lead.js: a missing new column costs that column.
  for (const n of [cols.length, cols.length - 1, cols.length - 3]) {
    try {
      await env.DB.prepare(`INSERT INTO leads (${cols.slice(0, n).join(', ')})
        VALUES (${cols.slice(0, n).map(() => '?').join(', ')})`).bind(...vals.slice(0, n)).run();
      return true;
    } catch (err) {
      console.error('photo lead insert failed', err && err.message);
      if (!/no such column|has no column/i.test(String(err && err.message))) return false;
    }
  }
  return false;
}

// A line on the customer's lead, when it is unambiguous which one: exactly
// one live lead from the last 30 days has this email. The uploader's email
// is not verified, so the note says what happened rather than whose photos
// they are, and it is marked meta.auto so outreach does not count it as a
// conversation. Never fails the upload: the photos have already been sent.
async function notePhotos(env, hit, count, now) {
  try {
    return await logQuietly(env, {
      lead_id: hit.id, contact_id: hit.contact_id, type: 'note', actor: 'website',
      subject: 'Photos received',
      body: `${count} photo${count === 1 ? ' was' : 's were'} sent from the website using this lead's email address (not verified). They are in the lead-alert inbox, not stored here.`,
      meta: { auto: 'photos' }
    }, now);
  } catch (err) {
    console.error('photo note failed', err && err.message);
    return null;
  }
}
