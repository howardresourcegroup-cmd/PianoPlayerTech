// Lead capture -> Airtable (PPT base).
//
// Receives a small JSON beacon from any site form (see ppt-tracking.js) and
// writes one record to Airtable. The Airtable token lives server-side as a
// Cloudflare secret, so it is never exposed in the browser.
//
// Configure in Cloudflare Pages -> your project -> Settings ->
// Environment variables (Production, and Preview if you use it):
//   AIRTABLE_TOKEN    (secret) Personal Access Token with the
//                     data.records:write scope, granted access to the PPT base.
//                     Create one at https://airtable.com/create/tokens
//   AIRTABLE_BASE_ID  the PPT base id, looks like appXXXXXXXXXXXXXX.
//                     Find it at https://airtable.com/api (open the PPT base).
//   AIRTABLE_TABLE    (optional) table name; defaults to "Leads".
//
// Recommended "Leads" table fields (extras on the form are preserved in
// Details, so this list never has to change as forms evolve):
//   Name (single line text), Email (email), Phone (phone number),
//   Message (long text), Source (single line text), Details (long text)
//
// Until the env vars are set the endpoint no-ops with 204, so shipping this
// never affects the live forms.

// Map a submission to one of the "Type" single-select options in the Leads
// table: Tuning | Player Repair | Detailing | Diagnosis | Unknown. All five
// strings below match existing options exactly, so writing them never creates
// new options (even with typecast on). Driven mainly by the form's
// service_type value, with the source path as a fallback signal.
function classifyType(source, serviceType) {
  const hay = ((serviceType || '') + ' ' + (source || '')).toLowerCase();
  // Player-piano systems are the most specific, so check them first.
  if (/disklavier|pianodisc|qrs|pianomation|spirio/.test(hay)) return 'Player Repair';
  if (/detail|clean/.test(hay)) return 'Detailing';
  if (/tuning|tune/.test(hay)) return 'Tuning';
  if (/diagnos|repair/.test(hay)) return 'Diagnosis';
  return 'Unknown';
}

// Hosts allowed to write leads. Anything else is abuse or a scraper replaying
// the endpoint, not a customer.
const ALLOWED_HOSTS = new Set(['pianoplayertech.com', 'www.pianoplayertech.com']);

// The beacon is a few hundred bytes. Anything past these ceilings is abuse,
// and letting it through would mean unbounded writes into Airtable.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELDS = 40;
const MAX_VALUE_CHARS = 2000;

// sendBeacon and fetch both send Origin on POST; Referer is the fallback.
// If NEITHER header is present we allow the request through on purpose: a
// browser quirk must never silently kill lead capture. The size and shape
// limits below still apply in that case.
function originAllowed(request) {
  const candidates = [request.headers.get('Origin'), request.headers.get('Referer')];
  let sawOne = false;
  for (const c of candidates) {
    if (!c) continue;
    sawOne = true;
    try {
      const host = new URL(c).hostname;
      if (ALLOWED_HOSTS.has(host) || host.endsWith('.pages.dev')) return true;
    } catch { /* malformed header: does not count as a match */ }
  }
  return !sawOne;
}

// Submissions allowed from one IP inside RATE_WINDOW_S. Generous for a human
// filling in a form twice; restrictive for anything automated.
const RATE_MAX = 5;
const RATE_WINDOW_S = 600;

// Pages Functions are stateless, so this needs a KV namespace bound as
// RATE_LIMIT. Until that binding exists the check is a deliberate no-op —
// shipping it inert is better than shipping nothing, and it means enabling
// rate limiting later is a binding away rather than a code change.
async function rateLimited(env, request) {
  if (!env.RATE_LIMIT) return false;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return false;
  const key = `lead:${ip}`;
  try {
    const n = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
    if (n >= RATE_MAX) return true;
    await env.RATE_LIMIT.put(key, String(n + 1), { expirationTtl: RATE_WINDOW_S });
    return false;
  } catch (err) {
    // A KV problem must never cost a real lead.
    console.error('rate limit check failed', err && err.message);
    return false;
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!originAllowed(request)) {
    return new Response('forbidden', { status: 403 });
  }

  if (await rateLimited(env, request)) {
    return new Response('too many requests', { status: 429 });
  }

  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID) {
    return new Response(null, { status: 204 }); // not configured yet
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return new Response('payload too large', { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // Clamp field count and value length before anything reaches Airtable.
  const submitted = (body && body.fields) || {};
  const fields = {};
  for (const key of Object.keys(submitted).slice(0, MAX_FIELDS)) {
    fields[key] = String(submitted[key]).slice(0, MAX_VALUE_CHARS);
  }

  // Case-insensitive lookup across whatever the form happened to name things.
  const pick = (...keys) => {
    for (const key of keys) {
      for (const name of Object.keys(fields)) {
        if (name.toLowerCase() === key && String(fields[name]).trim()) {
          return String(fields[name]).trim();
        }
      }
    }
    return '';
  };

  // Full, human-readable dump of every submitted field, so nothing is lost.
  const details = Object.keys(fields)
    .map((k) => `${k}: ${fields[k]}`)
    .join('\n');

  const source = String(body.source || body.page || '').slice(0, 500);
  const record = {
    fields: {
      Name: pick('name', 'full_name'),
      Email: pick('email'),
      Phone: pick('phone', 'tel'),
      Message: pick('message', 'notes', 'issue', 'details'),
      Type: classifyType(source, pick('service_type', 'lead_type', 'form_type')),
      // "piano" (tuning/repair/detailing) or "system" (player pages) — whichever
      // the form collected — describes the instrument. Free-text column.
      'Type of Piano': pick('piano', 'system', 'make', 'model'),
      Source: source,
      Details: details
    }
  };

  // Drop blanks so typed Airtable columns (email/phone) never reject the write.
  for (const key of Object.keys(record.fields)) {
    if (record.fields[key] === '') delete record.fields[key];
  }

  const table = encodeURIComponent(env.AIRTABLE_TABLE || 'Leads');
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${table}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ records: [record], typecast: true })
  });

  if (!res.ok) {
    // Log server-side only. Echoing Airtable's error back to the caller would
    // leak base/table/field structure to anyone who can POST here.
    const detail = await res.text().catch(() => '');
    console.error('airtable write failed', res.status, detail);
    return new Response(null, { status: 502 });
  }

  // Confirmation email. Deliberately after the Airtable write and wrapped so a
  // Resend outage can never cost us a captured lead — the record is already safe.
  await sendConfirmation(env, record.fields);

  return new Response(null, { status: 204 });
}

// Tell the customer we got it and that a human will call. No scheduling links,
// no payment — booking happens on the phone.
async function sendConfirmation(env, fields) {
  if (!env.RESEND_API_KEY || !fields.Email) return;

  const from = env.LEAD_FROM_EMAIL || 'PianoPlayerTech <info@pianoplayertech.com>';
  const name = (fields.Name || '').split(' ')[0] || 'there';
  const service = fields.Type && fields.Type !== 'Unknown' ? fields.Type.toLowerCase() : 'your piano';

  const text = [
    `Hi ${name},`,
    '',
    `Thanks for getting in touch about ${service}. We've got your details and someone will call you within 30 minutes to an hour to schedule.`,
    '',
    "There's nothing else you need to do right now — no payment, no forms. If you'd rather reach us first, call (470) 758-9572.",
    '',
    '— PianoPlayerTech',
    'Player piano repair, pneumatic restoration & tuning',
    'Metro Atlanta & North Georgia · (470) 758-9572'
  ].join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:15px;line-height:1.65;color:#241d16;max-width:520px">
  <p>Hi ${esc(name)},</p>
  <p>Thanks for getting in touch about ${esc(service)}. We&rsquo;ve got your details and <strong>someone will call you within 30 minutes to an hour to schedule</strong>.</p>
  <p>There&rsquo;s nothing else you need to do right now &mdash; no payment, no forms. If you&rsquo;d rather reach us first, call <a href="tel:4707589572" style="color:#96742a">(470)&nbsp;758-9572</a>.</p>
  <p style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #ded3c0;font-size:13px;color:#5c5045">
    <strong>PianoPlayerTech</strong><br>
    Player piano repair, pneumatic restoration &amp; tuning<br>
    Metro Atlanta &amp; North Georgia &middot; (470) 758-9572
  </p>
</div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [fields.Email],
        subject: 'We got your message — PianoPlayerTech',
        text,
        html
      })
    });
    if (!r.ok) {
      console.error('resend failed', r.status, await r.text().catch(() => ''));
    }
  } catch (err) {
    console.error('resend threw', err && err.message);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
