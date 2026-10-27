// Lead capture -> D1, then two emails: one to us, one to the customer.
//
// This replaced the Airtable pipeline. D1 is the system of record and the
// /leads dashboard reads from it.
//
// Cloudflare Pages -> pianoplayertech -> Settings:
//   Bindings:
//     DB           (D1)  -> pianoplayertech-leads
//     RATE_LIMIT   (KV)  -> RATE_LIMIT          (optional; abuse control)
//   Environment variables / secrets:
//     RESEND_API_KEY     (secret) transactional email
//     LEAD_FROM_EMAIL    sender, e.g. "PianoPlayerTech <info@pianoplayertech.com>"
//     LEAD_NOTIFY_EMAIL  where new-lead alerts go (default info@pianoplayertech.com)
//
// Every step degrades independently: no DB binding still sends the emails, a
// Resend outage still stores the lead. A submission has to fail all of it to
// be lost.

import { classifyCategory, CATEGORY_LABELS } from '../_lib/category.js';
import { normEmail, normPhone, namesCompatible } from '../_lib/dedupe.js';

const ALLOWED_HOSTS = new Set(['pianoplayertech.com', 'www.pianoplayertech.com']);

// The same form, word for word, from the same page this soon after is a
// double click or a resubmit, not a second enquiry. It is stored once and
// emailed about once.
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const MAX_BODY_BYTES = 16 * 1024;
const MAX_FIELDS = 40;
const MAX_VALUE_CHARS = 2000;

const RATE_MAX = 5;
const RATE_WINDOW_S = 600;

// Two pipelines, because the work and the money are nothing alike: a tuning
// is a $25 referral we hand to World Class, a repair is a ~$1,500 job we do.
// Player-system words win outright — "my Disklavier needs tuning" is a repair
// lead, not a tuning lead, and misfiling it costs real money.
const PLAYER_RE = /disklavier|pianodisc|pianomation|qrs|spirio|player|pneumatic|solenoid|stack|power supply|bellow|valve|nickelodeon|ampico|duo-?art|welte/;
const TUNING_RE = /tuning|tune|pitch raise|temperament|voicing|teacher|studio/;

function classifyPipeline(source, serviceType) {
  const hay = ((serviceType || '') + ' ' + (source || '')).toLowerCase();
  if (PLAYER_RE.test(hay)) return 'repair';
  if (TUNING_RE.test(hay)) return 'tuning';
  return 'repair'; // unknown goes to the line that pays; it gets looked at
}

// sendBeacon and fetch both send Origin on POST; Referer is the fallback.
// If NEITHER is present we allow it through on purpose: a browser quirk must
// never silently kill lead capture. Size and shape limits still apply.
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

  if (!originAllowed(request)) return new Response('forbidden', { status: 403 });
  if (await rateLimited(env, request)) return new Response('too many requests', { status: 429 });

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return new Response('payload too large', { status: 413 });
    body = JSON.parse(raw);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  if (!body || typeof body !== 'object') return new Response('bad request', { status: 400 });

  // The honeypot. Every lead form has a hidden `_gotcha` box a person never
  // sees; ppt-tracking.js reports it as `hp`. A bot that fills it in gets the
  // same 204 a person gets, so it learns nothing, and no email goes out. The
  // row is still kept, already archived, so a real person caught by
  // autofill can be found in the Archive tab and restored; the archive purge
  // clears the rest after 30 days. A direct POST that carries the field
  // itself is treated the same.
  const submittedRaw = (body.fields && typeof body.fields === 'object') ? body.fields : {};
  const trapped = !!(body.hp || String(submittedRaw._gotcha || '').trim());

  // Clamp field count and value length before anything is stored or emailed.
  // Underscore names are form plumbing (_subject, _next, _gotcha), not answers.
  const submitted = submittedRaw;
  const fields = {};
  for (const key of Object.keys(submitted).filter((k) => k.charAt(0) !== '_').slice(0, MAX_FIELDS)) {
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

  const source = String(body.source || body.page || '').slice(0, 500);
  const service = pick('service_type', 'lead_type', 'form_type', 'service_level', 'recommended');

  const lead = {
    created_at: new Date().toISOString(),
    pipeline: classifyPipeline(source, service),
    status: 'new',
    name: pick('name', 'full_name'),
    email: pick('email'),
    phone: pick('phone', 'tel'),
    service,
    system: pick('system', 'piano', 'make', 'model'),
    city: pick('city', 'location', 'area'),
    address: pick('address', 'street', 'service_address'),
    message: pick('message', 'notes', 'issue', 'details', 'quiz_summary', 'description'),
    source,
    fields: JSON.stringify(fields)
  };
  // What kind of work, from what they wrote (every answer, so a quiz summary
  // or a mail-in "location" counts) and the page they were on.
  lead.category = classifyCategory(lead, Object.values(fields).join(' \n '));

  if (trapped) {
    // A count in the logs, so a spike of real people being caught shows up.
    console.log('lead honeypot hit', lead.source);
    lead.status = 'closed';
    lead.archived_at = lead.created_at;
    lead.notes = 'Caught by the spam trap (the hidden box was filled in). No emails were sent. ' +
      'If this is a real enquiry, restore it and call them.';
  }

  // Store first. The record has to be safe before we spend time on email.
  let stored = false;
  let duplicate = false;
  if (env.DB) {
    // Linking a bot's submission to a real customer would be worse than useless.
    const contactId = trapped ? null : await matchContact(env, lead);
    const cols = ['created_at', 'pipeline', 'status', 'name', 'email', 'phone', 'service', 'system',
      'city', 'address', 'message', 'source', 'fields', 'archived_at', 'notes', 'contact_id', 'category'];
    const vals = [lead.created_at, lead.pipeline, lead.status, lead.name, lead.email,
      lead.phone, lead.service, lead.system, lead.city, lead.address, lead.message,
      lead.source, lead.fields, lead.archived_at || null, lead.notes || null, contactId, lead.category];
    // A double submit is the same lead, so it gets no second row and no
    // second pair of emails. Only an exact repeat counts: if they changed a
    // word, it is new information and is kept. The check and the insert are
    // one statement, so two submits arriving together cannot both store.
    const since = new Date(Date.parse(lead.created_at) - DUPLICATE_WINDOW_MS).toISOString();
    // The last two columns are newer than some databases. A missing column
    // must cost the category, never the lead.
    for (const n of [cols.length, cols.length - 2]) {
      try {
        const r = await env.DB.prepare(
          `INSERT INTO leads (${cols.slice(0, n).join(', ')})
           SELECT ${cols.slice(0, n).map(() => '?').join(', ')}
            WHERE NOT EXISTS (SELECT 1 FROM leads WHERE source = ? AND fields = ? AND created_at >= ?)`
        ).bind(...vals.slice(0, n), lead.source, lead.fields, since).run();
        if (r.meta && r.meta.changes === 0) duplicate = true; else stored = true;
        break;
      } catch (err) {
        // Log and keep going. An unstored lead we email about is recoverable;
        // a lead we drop entirely is not.
        console.error('d1 insert failed', err && err.message);
        if (!/no such column|has no column/i.test(String(err && err.message))) break;
      }
    }
  }
  if (duplicate || trapped) return new Response(null, { status: 204 });

  // Both emails, in parallel, neither able to break the other or the response.
  context.waitUntil(Promise.allSettled([
    notifyUs(env, lead, fields, stored),
    confirmCustomer(env, lead)
  ]));

  return new Response(null, { status: 204 });
}

// The person this lead belongs to, if they are already a contact. The same
// rules as functions/_lib/dedupe.js, made stricter for a public form: link
// only on strong evidence (the same email or phone, and a name on both
// sides that agrees), only
// when exactly one contact fits, and never create or change a contact here.
// Merging two people is the mistake that is hard to undo; leaving a lead
// unlinked costs one click later.
async function matchContact(env, lead) {
  const email = normEmail(lead.email);
  const phone = normPhone(lead.phone);
  if (!email && !phone) return null;
  try {
    const r = await env.DB.prepare(
      `SELECT id, name, email_norm, phone_norm FROM contacts
        WHERE (email_norm = ? AND ? != '') OR (phone_norm = ? AND ? != '') LIMIT 5`
    ).bind(email, email, phone, phone).all();
    // Web input is unauthenticated: anyone can type a customer's email or
    // phone. So every match also needs a name on both sides that agrees
    // (namesCompatible alone would accept a blank one).
    const named = (c) => String(c.name || '').trim() && String(lead.name || '').trim() &&
      namesCompatible(c.name, lead.name);
    const fits = (r.results || []).filter((c) =>
      ((email && c.email_norm === email) || (phone && c.phone_norm === phone)) && named(c));
    return fits.length === 1 ? fits[0].id : null;
  } catch (err) {
    // No contacts table yet, or a hiccup: an unlinked lead is fine.
    console.error('contact match failed', err && err.message);
    return null;
  }
}

// ---------------------------------------------------------------- emails

// Internal alert. Subject carries enough to triage from a phone lock screen
// without opening anything: what kind of work, who, and on what.
async function notifyUs(env, lead, fields, stored) {
  if (!env.RESEND_API_KEY) return;

  const to = env.LEAD_NOTIFY_EMAIL || 'info@pianoplayertech.com';
  const from = env.LEAD_FROM_EMAIL || 'PianoPlayerTech <info@pianoplayertech.com>';
  const kind = lead.pipeline === 'tuning' ? 'TUNING' : 'REPAIR';

  const bits = [lead.name || 'No name', lead.system, lead.city].filter(Boolean);
  // "NEW REPAIR (Pneumatic player)": which list it landed on, from the lock screen.
  const cat = lead.category && lead.category !== 'tuning' ? ` (${CATEGORY_LABELS[lead.category]})` : '';
  const subject = `NEW ${kind}${cat} — ${bits.join(' · ')}`;

  // Every field, in submission order, so the specifics each form collects
  // survive into the inbox rather than only into the database.
  const rows = Object.keys(fields).map((k) =>
    `<tr><td style="padding:5px 14px 5px 0;color:#7a6c5d;vertical-align:top;white-space:nowrap">${esc(label(k))}</td>
         <td style="padding:5px 0;color:#241d16">${esc(fields[k]).replace(/\n/g, '<br>')}</td></tr>`
  ).join('');

  const warn = stored ? '' :
    `<p style="background:#fdf0e4;border-left:3px solid #b5651d;padding:.7rem .9rem;border-radius:0 5px 5px 0;font-size:13px;color:#7a4a15;margin:0 0 1rem">
       Heads up: this lead is <strong>not</strong> in the dashboard &mdash; the database write failed.
       Everything you need is in this email. Save it.</p>`;

  const html = `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:15px;line-height:1.6;color:#241d16;max-width:560px">
  ${warn}
  <p style="margin:0 0 .3rem;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#96742a;font-weight:600">New ${esc(kind.toLowerCase())} lead</p>
  <h2 style="margin:0 0 1rem;font-size:20px">${esc(lead.name || 'No name given')}</h2>
  <p style="margin:0 0 1.2rem">
    ${lead.phone ? `<a href="tel:${esc(lead.phone.replace(/[^0-9+]/g, ''))}" style="color:#96742a;font-weight:600;font-size:17px">${esc(lead.phone)}</a>` : '<em>no phone given</em>'}
    ${lead.email ? ` &nbsp;·&nbsp; <a href="mailto:${esc(lead.email)}" style="color:#96742a">${esc(lead.email)}</a>` : ''}
  </p>
  <table style="border-collapse:collapse;font-size:14px;width:100%">${rows}</table>
  <p style="margin:1.4rem 0 0;padding-top:.9rem;border-top:1px solid #ded3c0;font-size:13px;color:#7a6c5d">
    From ${esc(lead.source || 'unknown page')} &nbsp;·&nbsp;
    <a href="https://pianoplayertech.com/leads" style="color:#96742a">Open the dashboard &rarr;</a><br>
    You told them someone would call within 30 minutes to an hour.
  </p>
</div>`;

  const text = [
    `NEW ${kind} LEAD`,
    '',
    lead.name || 'No name given',
    lead.phone || '(no phone)',
    lead.email || '(no email)',
    '',
    ...Object.keys(fields).map((k) => `${label(k)}: ${fields[k]}`),
    '',
    `From ${lead.source || 'unknown page'}`,
    stored ? '' : 'WARNING: not saved to the dashboard — keep this email.',
    'You told them someone would call within 30 minutes to an hour.',
    'https://pianoplayertech.com/leads'
  ].join('\n');

  await send(env, {
    from, to: [to], subject, text, html,
    // Hitting reply in the inbox writes to the customer, not to ourselves.
    reply_to: lead.email || undefined
  }, 'notify');
}

// What the confirmation says they got in touch about. Every repair lead used
// to read "your player piano", including a cleaning quote and a general
// question from the home page.
function aboutLine(lead) {
  if (/referral partner/i.test(lead.service || '')) return 'referring your students';
  if (lead.pipeline === 'tuning') return 'tuning your piano';
  if (lead.category === 'pneumatic' || lead.category === 'electronic') return 'your player piano';
  return 'your piano';
}

// Customer-facing. No scheduling links, no payment — booking is a phone call.
async function confirmCustomer(env, lead) {
  if (!env.RESEND_API_KEY || !lead.email) return;

  const from = env.LEAD_FROM_EMAIL || 'PianoPlayerTech <info@pianoplayertech.com>';
  const name = (lead.name || '').split(' ')[0] || 'there';
  const about = aboutLine(lead);

  const text = [
    `Hi ${name},`,
    '',
    `Thanks for getting in touch about ${about}. We've got your details and someone will call you within 30 minutes to an hour to schedule.`,
    '',
    "There's nothing else you need to do right now — no payment, no forms. If you'd rather reach us first, call (470) 758-9572.",
    '',
    '— PianoPlayerTech',
    'Player piano repair, pneumatic restoration & tuning',
    'Metro Atlanta & North Georgia · (470) 758-9572'
  ].join('\n');

  const html = `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:15px;line-height:1.65;color:#241d16;max-width:520px">
  <p>Hi ${esc(name)},</p>
  <p>Thanks for getting in touch about ${esc(about)}. We&rsquo;ve got your details and <strong>someone will call you within 30 minutes to an hour to schedule</strong>.</p>
  <p>There&rsquo;s nothing else you need to do right now &mdash; no payment, no forms. If you&rsquo;d rather reach us first, call <a href="tel:4707589572" style="color:#96742a">(470)&nbsp;758-9572</a>.</p>
  <p style="margin-top:1.5rem;padding-top:1rem;border-top:1px solid #ded3c0;font-size:13px;color:#5c5045">
    <strong>PianoPlayerTech</strong><br>
    Player piano repair, pneumatic restoration &amp; tuning<br>
    Metro Atlanta &amp; North Georgia &middot; (470) 758-9572
  </p>
</div>`;

  await send(env, {
    from, to: [lead.email],
    subject: 'We got your message — PianoPlayerTech',
    text, html
  }, 'confirm');
}

async function send(env, payload, tag) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) console.error(`resend ${tag} failed`, r.status, await r.text().catch(() => ''));
  } catch (err) {
    console.error(`resend ${tag} threw`, err && err.message);
  }
}

// "preferred_dates" -> "Preferred dates". Form field names are developer
// shorthand; the inbox should read like English.
function label(k) {
  const s = String(k).replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
