// Automated emails: three moments the business kept missing.
//
//   quote_checkin    a quote went out and nothing came back
//   review_request   a job finished
//   tuning_reminder  a tuning is due again
//   needs_contact    the owner has been trying to reach them
//
// The dashboard already calls a task you owe someone a "follow-up", so this
// is "outreach" in code and "Emails" on screen, to keep the two apart.
//
// The rules are pure functions. Everything that decides whether a person
// gets an email can be tested without a database or a network, because the
// cost of getting it wrong is a customer receiving something they should not.

import { getSetting, setSetting, newToken } from './settings.js';
import { logQuietly } from './activity.js';

export const KINDS = ['quote_checkin', 'review_request', 'tuning_reminder', 'needs_contact'];
export const MODES = ['off', 'ask', 'auto'];
export const LABEL = {
  quote_checkin: 'Quote check-in',
  review_request: 'Review request',
  tuning_reminder: 'Tuning reminder',
  needs_contact: 'Tried to reach you'
};

export const CONFIG_KEY = 'outreach_config';
const SECRET_KEY = 'outreach_secret';

export const DAILY_CAP = 20;
export const LIMITS = { address: 300, sender: 80, subject: 150, body: 3000 };

const DAY = 86400000;

// How long after its trigger a lead can still be emailed. Without this,
// switching the feature on would write to every customer in the archive of
// the business's memory. Past the window the moment has gone; say nothing.
const WINDOW_DAYS = { quote_checkin: 30, review_request: 30, tuning_reminder: 60, needs_contact: 30 };

// Days for the first two, months for the reminder.
const DELAY_RANGE = { quote_checkin: [1, 30], review_request: [0, 30], tuning_reminder: [6, 24], needs_contact: [1, 30] };

const DONE = ['completed', 'invoiced', 'paid'];

// A conversation happened. A status change or our own email is not one.
const TOUCH_TYPES = ['call', 'email', 'sms', 'note', 'appointment'];

export const DEFAULT_CONFIG = {
  address: '',
  sender: 'PianoPlayerTech',
  kinds: {
    quote_checkin: {
      mode: 'ask', delay: 4,
      subject: 'Your quote from PianoPlayerTech',
      body: [
        'Hi {first_name},',
        '',
        'I sent over a quote for your {instrument} a few days ago and wanted to make sure it reached you.',
        '',
        'If you have questions about what is involved, or would like to talk it through, reply to this email or call (470) 758-9572.',
        '',
        'No pressure either way.',
        '',
        '{sender}'
      ].join('\n')
    },
    review_request: {
      mode: 'ask', delay: 1,
      subject: 'How is the {instrument}?',
      body: [
        'Hi {first_name},',
        '',
        'Thank you for trusting us with your {instrument}. I hope it is playing well.',
        '',
        'If you have two minutes, a short review helps other owners find us:',
        'https://pianoplayertech.com/review',
        '',
        'And if anything is not right, reply to this email and I will sort it out.',
        '',
        '{sender}'
      ].join('\n')
    },
    tuning_reminder: {
      mode: 'ask', delay: 12,
      subject: 'Time for a tuning?',
      body: [
        'Hi {first_name},',
        '',
        'It has been about a year since your piano was last tuned through us.',
        '',
        'If you would like to book the next one, you can do that here:',
        'https://pianoplayertech.com/tuning#contact',
        '',
        'Or reply to this email and we will set it up.',
        '',
        '{sender}'
      ].join('\n')
    },
    needs_contact: {
      mode: 'ask', delay: 2,
      subject: 'Trying to reach you about your {instrument}',
      body: [
        'Hi {first_name},',
        '',
        'I have been trying to reach you about your {instrument} and have not managed to catch you.',
        '',
        'If now is a bad time, reply with a good one. Or call (470) 758-9572 and we will pick it up from there.',
        '',
        '{sender}'
      ].join('\n')
    }
  }
};

// ------------------------------------------------------------------ config

const clip = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').slice(0, n);

// Rebuilt from known keys rather than stored as sent. The browser hands us a
// structure here; whatever else is in it does not survive.
export function cleanConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    address: clip(src.address, LIMITS.address).trim(),
    sender: clip(src.sender, LIMITS.sender).trim() || DEFAULT_CONFIG.sender,
    kinds: {}
  };
  const kinds = src.kinds && typeof src.kinds === 'object' ? src.kinds : {};
  for (const k of KINDS) {
    const d = DEFAULT_CONFIG.kinds[k];
    const s = kinds[k] && typeof kinds[k] === 'object' ? kinds[k] : {};
    const [lo, hi] = DELAY_RANGE[k];
    const n = parseInt(s.delay, 10);
    out.kinds[k] = {
      mode: MODES.includes(s.mode) ? s.mode : d.mode,
      delay: Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d.delay,
      subject: clip(s.subject, LIMITS.subject).replace(/\n/g, ' ').trim() || d.subject,
      body: clip(s.body, LIMITS.body).trim() || d.body
    };
  }
  return out;
}

export async function loadConfig(env) {
  const raw = await getSetting(env, CONFIG_KEY);
  if (!raw) return cleanConfig(DEFAULT_CONFIG);
  try { return cleanConfig(JSON.parse(raw)); } catch { return cleanConfig(DEFAULT_CONFIG); }
}

export async function saveConfig(env, raw, now) {
  const c = cleanConfig(raw);
  await setSetting(env, CONFIG_KEY, JSON.stringify(c), now);
  return c;
}

// ------------------------------------------------------------------ rules

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

export function normEmail(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : '';
}

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : NaN; };

function addMonths(t, months) {
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // The 31st plus a month is the last day of the next, not the 1st after it.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * Which emails is this lead due, right now?
 *
 * @param lead   a row from `leads`
 * @param facts  { statusAt: { [status]: iso }, lastTouchAt: iso|'' }
 * @returns      [{ kind, cycle }]
 */
export function dueFor(lead, facts, config, nowIso) {
  const out = [];
  if (!lead || lead.archived_at) return out;
  if (!normEmail(lead.email)) return out;
  const now = ms(nowIso);
  if (!Number.isFinite(now)) return out;

  const statusAt = (facts && facts.statusAt) || {};
  const since = (keys) => {
    let best = NaN;
    for (const k of keys) {
      const t = ms(statusAt[k]);
      if (Number.isFinite(t) && (!Number.isFinite(best) || t < best)) best = t;
    }
    return Number.isFinite(best) ? best : ms(lead.updated_at);
  };
  const inWindow = (dueAt, kind) =>
    Number.isFinite(dueAt) && now >= dueAt && now - dueAt <= WINDOW_DAYS[kind] * DAY;

  const q = config.kinds.quote_checkin;
  if (q.mode !== 'off' && lead.status === 'quoted') {
    const at = since(['quoted']);
    const touched = ms(facts && facts.lastTouchAt);
    // They have been spoken to since the quote. A check-in now would be
    // noise at best and, mid-negotiation, an own goal.
    const spoken = Number.isFinite(touched) && touched > at;
    if (!spoken && inWindow(at + q.delay * DAY, 'quote_checkin')) out.push({ kind: 'quote_checkin', cycle: '' });
  }

  const r = config.kinds.review_request;
  if (r.mode !== 'off' && DONE.includes(lead.status)) {
    if (inWindow(since(DONE) + r.delay * DAY, 'review_request')) out.push({ kind: 'review_request', cycle: '' });
  }

  const t = config.kinds.tuning_reminder;
  if (t.mode !== 'off' && lead.pipeline === 'tuning' &&
      (lead.referral_status === 'booked' || DONE.includes(lead.status))) {
    let anchor = ms(lead.scheduled_at);
    if (!Number.isFinite(anchor)) anchor = ms(lead.referred_at);
    if (!Number.isFinite(anchor)) anchor = since(DONE);
    if (Number.isFinite(anchor) && anchor <= now) {
      // The latest anniversary that has arrived. Earlier ones either went
      // out in their own year or are past their window.
      let k = 0;
      while (k < 50 && addMonths(anchor, t.delay * (k + 1)) <= now) k++;
      if (k >= 1 && inWindow(addMonths(anchor, t.delay * k), 'tuning_reminder')) {
        out.push({ kind: 'tuning_reminder', cycle: String(k) });
      }
    }
  }
  const n = config.kinds.needs_contact;
  if (n.mode !== 'off' && lead.status === 'needs_contact') {
    const at = since(['needs_contact']);
    const touched = ms(facts && facts.lastTouchAt);
    // They answered. Chasing someone who has just spoken to you is worse
    // than never having written.
    const spoken = Number.isFinite(touched) && touched > at;
    if (!spoken && inWindow(at + n.delay * DAY, 'needs_contact')) {
      // Keyed by the day they fell into the status, so a second spell of
      // being unreachable months later gets its own email.
      out.push({ kind: 'needs_contact', cycle: new Date(at).toISOString().slice(0, 10) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ wording

export function fill(template, lead, config) {
  const first = String((lead && lead.name) || '').trim().split(/\s+/)[0] || 'there';
  const make = [lead && lead.piano_make, lead && lead.piano_model].filter(Boolean).join(' ').trim();
  const instrument = String((lead && lead.system) || '').trim() || make ||
    (lead && lead.pipeline === 'tuning' ? 'piano' : 'player piano');
  const map = {
    first_name: first.slice(0, 60),
    instrument: instrument.slice(0, 120),
    sender: (config && config.sender) || DEFAULT_CONFIG.sender
  };
  return String(template || '').replace(/\{(first_name|instrument|sender)\}/g, (_, k) => map[k]);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ unsubscribe

async function secret(env) {
  const have = await getSetting(env, SECRET_KEY);
  if (have) return have;
  return await setSetting(env, SECRET_KEY, newToken(), new Date().toISOString());
}

const b64url = (buf) => {
  let s = '';
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function unsubToken(env, email) {
  const e = normEmail(email);
  if (!e) return '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(await secret(env)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('unsub:' + e)));
}

// Compared without an early exit, so how long it takes says nothing about
// how much of a guess was right.
export async function unsubValid(env, email, token) {
  const want = await unsubToken(env, email);
  const got = String(token || '');
  if (!want || want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export async function unsubUrl(env, origin, email) {
  const e = normEmail(email);
  return `${origin}/unsubscribe?e=${encodeURIComponent(e)}&t=${await unsubToken(env, e)}`;
}

export async function isUnsubscribed(env, email) {
  const e = normEmail(email);
  if (!e) return true;  // an address we cannot read is one we do not write to
  const r = await env.DB.prepare('SELECT 1 AS x FROM unsubscribes WHERE email_norm = ?').bind(e).first();
  return !!r;
}

export async function unsubscribe(env, email, source, now) {
  const e = normEmail(email);
  if (!e) return false;
  await env.DB.prepare(
    'INSERT OR IGNORE INTO unsubscribes (email_norm, created_at, source) VALUES (?, ?, ?)')
    .bind(e, now, String(source || '').slice(0, 40)).run();
  return true;
}

// ------------------------------------------------------------------ the email

export async function renderEmail(env, origin, row, config) {
  const link = await unsubUrl(env, origin, row.email);
  const foot = ['PianoPlayerTech', config.address].filter(Boolean).join(' · ');
  const text = [
    row.body,
    '',
    '--',
    foot,
    `Unsubscribe: ${link}`
  ].join('\n');
  const paras = String(row.body).split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 1rem">${esc(p).replace(/\n/g, '<br>')
      .replace(/(https:\/\/pianoplayertech\.com\/[^\s<]*)/g, '<a href="$1" style="color:#96742a">$1</a>')}</p>`).join('\n  ');
  const html = `<div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;font-size:15px;line-height:1.65;color:#241d16;max-width:520px">
  ${paras}
  <p style="margin:1.5rem 0 0;padding-top:1rem;border-top:1px solid #ded3c0;font-size:12px;color:#7a6c5d">
    ${esc(foot)}<br>
    <a href="${esc(link)}" style="color:#7a6c5d">Unsubscribe</a>
  </p>
</div>`;
  return {
    from: env.LEAD_FROM_EMAIL || 'PianoPlayerTech <info@pianoplayertech.com>',
    to: [row.email],
    reply_to: env.LEAD_NOTIFY_EMAIL || 'info@pianoplayertech.com',
    subject: row.subject,
    text, html,
    // What a mail client's own Unsubscribe button uses.
    headers: {
      'List-Unsubscribe': `<${link}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
}

// ------------------------------------------------------------------ drafting

const LEAD_COLS = 'id, contact_id, pipeline, status, name, email, system, piano_make, piano_model, ' +
  'updated_at, scheduled_at, referred_at, referral_status, archived_at';

async function factsFor(env, ids) {
  const facts = new Map();
  if (!ids.length) return facts;
  const rows = (await env.DB.prepare(
    `SELECT lead_id, type, created_at, meta FROM activities
      WHERE lead_id IS NOT NULL AND type IN ('status', 'call', 'email', 'sms', 'note', 'appointment')
      ORDER BY created_at LIMIT 20000`).all()).results || [];
  const want = new Set(ids);
  for (const a of rows) {
    if (!want.has(a.lead_id)) continue;
    let f = facts.get(a.lead_id);
    if (!f) { f = { statusAt: {}, lastTouchAt: '' }; facts.set(a.lead_id, f); }
    if (a.type === 'status') {
      let meta = null;
      try { meta = JSON.parse(a.meta || 'null'); } catch { meta = null; }
      // Newest wins: rows arrive oldest first, so a later move into the
      // same status overwrites the earlier one.
      if (meta && meta.field === 'status' && meta.to) f.statusAt[meta.to] = a.created_at;
    } else if (TOUCH_TYPES.includes(a.type)) {
      // Our own sends are logged as email activities. They are not a reply.
      let meta = null;
      try { meta = JSON.parse(a.meta || 'null'); } catch { meta = null; }
      if (!(meta && meta.outreach)) f.lastTouchAt = a.created_at;
    }
  }
  return facts;
}

/** Insert a draft for everything due. Returns how many were new. */
export async function draftDue(env, nowIso) {
  const config = await loadConfig(env);
  if (KINDS.every((k) => config.kinds[k].mode === 'off')) return 0;

  const leads = (await env.DB.prepare(
    `SELECT ${LEAD_COLS} FROM leads
      WHERE archived_at IS NULL AND email IS NOT NULL AND email != ''
        AND (status IN ('quoted', 'completed', 'invoiced', 'paid', 'needs_contact') OR pipeline = 'tuning')
      LIMIT 2000`).all()).results || [];
  if (!leads.length) return 0;

  const facts = await factsFor(env, leads.map((l) => l.id));
  const gone = new Set(((await env.DB.prepare('SELECT email_norm FROM unsubscribes').all()).results || [])
    .map((r) => r.email_norm));

  let made = 0;
  for (const lead of leads) {
    const email = normEmail(lead.email);
    if (!email || gone.has(email)) continue;
    for (const d of dueFor(lead, facts.get(lead.id), config, nowIso)) {
      const tpl = config.kinds[d.kind];
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO outreach
           (created_at, lead_id, contact_id, kind, cycle, email, subject, body, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
        .bind(nowIso, lead.id, lead.contact_id == null ? null : lead.contact_id, d.kind, d.cycle, email,
          clip(fill(tpl.subject, lead, config), LIMITS.subject),
          clip(fill(tpl.body, lead, config), LIMITS.body))
        .run();
      if (res && res.meta && res.meta.changes) made++;
    }
  }
  return made;
}

// ------------------------------------------------------------------ sending

async function settle(env, id, status, actor, now, error) {
  await env.DB.prepare(
    'UPDATE outreach SET status = ?, decided_at = ?, decided_by = ?, error = ? WHERE id = ?')
    .bind(status, now, clip(actor, 200) || null, error ? clip(error, 500) : null, id).run();
}

async function sentToday(env, nowIso) {
  const day = String(nowIso).slice(0, 10) + 'T00:00:00.000Z';
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM outreach WHERE status = 'sent' AND decided_at >= ?`).bind(day).first();
  return (r && r.n) || 0;
}

/**
 * Send one queued email.
 *
 * Every check here is made again even though drafting made most of them:
 * a draft can sit in the queue for days, and the person may have
 * unsubscribed, or the lead been archived, in between.
 */
export async function sendOne(env, origin, id, actor, nowIso, edits) {
  const row = await env.DB.prepare('SELECT * FROM outreach WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: 'That email is no longer in the queue.' };
  if (row.status !== 'draft' && row.status !== 'failed') {
    return { ok: false, error: 'That email has already been dealt with.' };
  }

  const config = await loadConfig(env);
  if (!config.address) {
    return { ok: false, error: 'Add your mailing address in Settings before sending. The law requires one in every email.' };
  }
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Email is not set up on the server.' };

  if (await isUnsubscribed(env, row.email)) {
    await settle(env, id, 'skipped', actor, nowIso, 'unsubscribed');
    return { ok: false, error: 'They have unsubscribed, so this was skipped.' };
  }
  const lead = await env.DB.prepare('SELECT id, archived_at FROM leads WHERE id = ?').bind(row.lead_id).first();
  if (!lead || lead.archived_at) {
    await settle(env, id, 'skipped', actor, nowIso, 'lead archived');
    return { ok: false, error: 'That lead is archived, so this was skipped.' };
  }
  if (await sentToday(env, nowIso) >= DAILY_CAP) {
    return { ok: false, error: `The daily limit of ${DAILY_CAP} emails has been reached. Try again tomorrow.` };
  }

  if (edits && (edits.subject != null || edits.body != null)) {
    row.subject = clip(edits.subject != null ? edits.subject : row.subject, LIMITS.subject).replace(/\n/g, ' ').trim() || row.subject;
    row.body = clip(edits.body != null ? edits.body : row.body, LIMITS.body).trim() || row.body;
    await env.DB.prepare('UPDATE outreach SET subject = ?, body = ? WHERE id = ?')
      .bind(row.subject, row.body, id).run();
  }

  let error = '';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await renderEmail(env, origin, row, config))
    });
    if (!r.ok) error = `The email service refused it (${r.status}).`;
  } catch (err) {
    error = 'Could not reach the email service.';
    console.error('outreach send threw', err && err.message);
  }

  if (error) {
    await settle(env, id, 'failed', actor, nowIso, error);
    return { ok: false, error };
  }
  await settle(env, id, 'sent', actor, nowIso, null);
  await logQuietly(env, {
    lead_id: row.lead_id, contact_id: row.contact_id, type: 'email', actor,
    subject: `Sent: ${row.subject}`, body: row.body,
    meta: { outreach: row.kind, outreach_id: id }
  }, nowIso);
  return { ok: true };
}

export async function skipOne(env, id, actor, nowIso) {
  const row = await env.DB.prepare('SELECT id, status, lead_id, contact_id, kind FROM outreach WHERE id = ?').bind(id).first();
  if (!row) return { ok: false, error: 'That email is no longer in the queue.' };
  if (row.status !== 'draft' && row.status !== 'failed') {
    return { ok: false, error: 'That email has already been dealt with.' };
  }
  await settle(env, id, 'skipped', actor, nowIso, null);
  return { ok: true };
}

/** Draft what is due, then send the kinds that are set to send themselves. */
export async function runOutreach(env, origin, nowIso) {
  const made = await draftDue(env, nowIso);
  const config = await loadConfig(env);
  const auto = KINDS.filter((k) => config.kinds[k].mode === 'auto');
  let sent = 0;
  // Without an address nothing can go, so there is nothing to attempt.
  if (auto.length && config.address) {
    const rows = (await env.DB.prepare(
      `SELECT id, kind FROM outreach WHERE status = 'draft' ORDER BY created_at LIMIT ?`)
      .bind(DAILY_CAP).all()).results || [];
    for (const r of rows) {
      if (!auto.includes(r.kind)) continue;
      const out = await sendOne(env, origin, r.id, 'automatic', nowIso);
      if (out.ok) sent++;
    }
  }
  return { made, sent };
}

/**
 * Send one kind's wording to ourselves, filled in for a made-up customer.
 * Goes through the same rendering as the real thing, footer and all, so what
 * arrives is what a customer would see.
 */
export async function sendTest(env, origin, kind, to) {
  if (!KINDS.includes(kind)) return { ok: false, error: 'Unknown email.' };
  const config = await loadConfig(env);
  if (!config.address) {
    return { ok: false, error: 'Add your mailing address in Settings before sending. The law requires one in every email.' };
  }
  if (!env.RESEND_API_KEY) return { ok: false, error: 'Email is not set up on the server.' };
  const dest = normEmail(to);
  if (!dest) return { ok: false, error: 'There is no address to send the test to.' };
  const sample = { name: 'Dana Example', system: kind === 'tuning_reminder' ? '' : 'Disklavier Mark III',
    pipeline: kind === 'tuning_reminder' ? 'tuning' : 'repair' };
  const tpl = config.kinds[kind];
  const row = { email: dest, subject: '[Test] ' + fill(tpl.subject, sample, config), body: fill(tpl.body, sample, config) };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(await renderEmail(env, origin, row, config))
    });
    if (!r.ok) return { ok: false, error: `The email service refused it (${r.status}).` };
  } catch (err) {
    console.error('outreach test threw', err && err.message);
    return { ok: false, error: 'Could not reach the email service.' };
  }
  return { ok: true, to: dest };
}

/** How many are waiting. For the badge on the tab. */
export async function waitingCount(env) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM outreach WHERE status IN ('draft', 'failed')`).first();
  return (r && r.n) || 0;
}

/** What the Emails tab shows. */
export async function loadQueue(env) {
  const cols = 'o.id, o.created_at, o.lead_id, o.kind, o.cycle, o.email, o.subject, o.body, o.status, ' +
    'o.decided_at, o.decided_by, o.error, l.name AS lead_name, l.pipeline AS lead_pipeline';
  const waiting = (await env.DB.prepare(
    `SELECT ${cols} FROM outreach o LEFT JOIN leads l ON l.id = o.lead_id
      WHERE o.status IN ('draft', 'failed') ORDER BY o.created_at LIMIT 200`).all()).results || [];
  const recent = (await env.DB.prepare(
    `SELECT ${cols} FROM outreach o LEFT JOIN leads l ON l.id = o.lead_id
      WHERE o.status IN ('sent', 'skipped') ORDER BY o.decided_at DESC LIMIT 50`).all()).results || [];
  return { waiting, recent };
}
