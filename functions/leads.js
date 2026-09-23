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
  accessMode, accessIdentity, emailAllowed, signedIn, sameOrigin
} from './_lib/auth.js';
import {
  dashboard, VIEWS, REFERRAL_STATUSES
} from './_lib/grid.js';
import {
  createInvoice, voidInvoice, syncInvoices, INVOICE_COLUMNS
} from './_lib/stripe.js';
import { NOT_ARCHIVED, purgeCutoff, purgeExpired, loadStatuses } from './_lib/db.js';
import { BULK_OPS, parseIds, applyBulk } from './_lib/bulk.js';
import { listViews, saveView, deleteView } from './_lib/views.js';
import { getCalendarToken, rotateCalendarToken, disableCalendar } from './_lib/settings.js';
import {
  LOGGABLE_TYPES, SCHEDULED_TYPES, LIMITS as ACTIVITY_LIMITS, normStamp,
  logActivity, logQuietly, contactIdFor, loadRecord, setActivityDone,
  deleteActivity, openFollowups
} from './_lib/activity.js';

const PIPELINES = ['repair', 'tuning'];

// Grid cells a person may edit, with the longest value each one accepts.
// Anything not listed here (message, source, fields) is what the customer
// submitted and stays exactly as they sent it.
// A field maps to how it is validated: a number is a maximum length, 0 is
// an enum checked below, and a string names a kind.
const EDITABLE = {
  name: 200, phone: 50, email: 200, address: 300, city: 100,
  system: 200, service: 200, notes: 4000, status: 0, pipeline: 0, referral_status: 0,
  // The browser sends local wall-clock time. It is parsed and stored as the
  // normalised UTC instant, never as the text that arrived -- a string no
  // query can compare is worse than no value.
  scheduled_at: 'datetime',
  scheduled_mins: 'minutes'
};

// Changes worth a line in the lead's history. Editing a typo in an address
// is not a story; moving a job from new to booked is.
const TRACKED_FIELDS = ['status', 'pipeline', 'referral_status'];
const FIELD_LABEL = {
  status: 'Status', pipeline: 'Pipeline', referral_status: 'Referral outcome'
};

const COLUMNS = [
  'id', 'created_at', 'updated_at', 'pipeline', 'status', 'name', 'phone', 'email',
  'address', 'city', 'system', 'service', 'message', 'notes', 'source',
  'referred_at', 'referral_status', 'referral_paid_at', 'referral_invoice_id',
  'scheduled_at', 'scheduled_mins', 'archived_at', 'fields'
];

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

  // Off the response path: a slow delete must never make the dashboard slow.
  context.waitUntil(
    purgeExpired(env, purgeCutoff(new Date()))
      .catch((err) => console.error('purge failed', err && err.message))
  );

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

    const where = view === 'archive' ? 'WHERE archived_at IS NOT NULL'
      : view === 'all' || view === 'invoices' ? `WHERE ${NOT_ARCHIVED}`
      : view === 'referrals' ? `WHERE referred_at IS NOT NULL AND ${NOT_ARCHIVED}`
      : `WHERE pipeline = ? AND ${NOT_ARCHIVED}`;
    const order = view === 'archive' ? 'ORDER BY archived_at DESC'
      : view === 'referrals' ? 'ORDER BY referred_at DESC'
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
      `SELECT pipeline, SUM(status = 'new') AS n FROM leads WHERE ${NOT_ARCHIVED} GROUP BY pipeline`
    ).all();
    for (const r of (c.results || [])) {
      if (r.pipeline in counts) counts[r.pipeline] = r.n || 0;
    }

    const s = await env.DB.prepare(
      `SELECT COUNT(referred_at) AS sent,
              SUM(referral_status = 'booked') AS booked,
              SUM(referral_status = 'no_booking') AS lost,
              SUM(referral_status = 'booked' AND referral_paid_at IS NOT NULL) AS paid
         FROM leads WHERE referred_at IS NOT NULL AND ${NOT_ARCHIVED}`
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
  // The pipeline's own vocabulary, not a list hardcoded in the client.
  extra.statusList = await loadStatuses(env);
  extra.views = await listViews(env);
  // Only if it has been switched on. The URL is a bearer credential, so it
  // is never created just by loading the page.
  const calTok = await getCalendarToken(env);
  extra.calendarUrl = calTok ? `${url.origin}/calendar/${calTok}.ics` : '';

  // Follow-ups you owe someone. A CRM that does not surface these is a
  // list of names. Best-effort: a dashboard that loads without the badge
  // beats one that does not load.
  try {
    const due = await openFollowups(env, new Date().toISOString(), 50);
    extra.followups = { overdue: due.overdue.length, upcoming: due.upcoming.length, rows: due.all.slice(0, 20) };
  } catch (err) {
    console.error('follow-up lookup failed', err && err.message);
    extra.followups = { overdue: 0, upcoming: 0, rows: [] };
  }

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
    await new Promise((r) => { setTimeout(r, 1000); });
    return new Response(null, { status: 303, headers: { Location: '/leads?e=1' } });
  }

  // Everything else is a dashboard action and needs a valid session.
  if (!sameOrigin(request)) return json({ error: 'forbidden' }, 403);
  // signedIn is what authed wraps, so the gate is unchanged. Keeping the
  // identity rather than discarding it is what lets an activity record who
  // did the thing.
  const actor = await signedIn(request, env);
  if (!actor) return json({ error: 'Signed out — reload and sign in again.' }, 401);
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

  // Turning the calendar feed on, rotating it, or switching it off.
  if (body.action === 'calendarOn' || body.action === 'calendarRotate' || body.action === 'calendarOff') {
    try {
      if (body.action === 'calendarOff') {
        await disableCalendar(env);
        return json({ ok: true, url: '' });
      }
      const tok = body.action === 'calendarRotate'
        ? await rotateCalendarToken(env)
        : await getCalendarToken(env, { create: true });
      const origin = new URL(request.url).origin;
      return json({ ok: true, url: `${origin}/calendar/${tok}.ics` });
    } catch (err) {
      // Never let the token reach a log line.
      console.error('calendar action failed', body.action, err && err.message);
      return json({ error: 'Could not change the calendar feed — try again.' }, 500);
    }
  }

  // Saved views are their own objects, so these run before the lead lookup.
  if (body.action === 'viewSave' || body.action === 'viewDelete') {
    try {
      const out = body.action === 'viewDelete'
        ? await deleteView(env, body.viewId)
        : await saveView(env, { id: body.viewId, name: body.name, config: body.config, owner: actor },
                         new Date().toISOString());
      return out.error ? json({ error: out.error }, 400) : json({ ok: true, ...out });
    } catch (err) {
      console.error('view action failed', body.action, err && err.message);
      return json({ error: 'Could not save that view — try again.' }, 500);
    }
  }

  // Many leads at once, so it runs before the single-lead lookup.
  if (body.action === 'bulk') {
    const op = String(body.op || '');
    if (!BULK_OPS.includes(op)) return json({ error: 'unknown bulk action' }, 400);

    const parsed = parseIds(body.ids);
    if (parsed.error) return json({ error: parsed.error }, 400);

    const value = String(body.value == null ? '' : body.value).trim();
    if (op === 'status') {
      if (value === 'referred') {
        return json({ error: 'Use the Refer button so each referral is recorded and can be billed.' }, 400);
      }
      const known = (await loadStatuses(env)).some((x) => x.key === value);
      if (!known) return json({ error: 'bad status' }, 400);
    }
    if (op === 'pipeline' && !PIPELINES.includes(value)) return json({ error: 'bad pipeline' }, 400);

    try {
      const out = await applyBulk(env, parsed.ids, { op, value, actor }, new Date().toISOString());
      return json({ ok: true, ...out });
    } catch (err) {
      console.error('bulk action failed', op, err && err.message);
      return json({ error: 'Could not apply that to all of them — reload and check.' }, 500);
    }
  }

  // These are keyed by activity id, so they run before the lead lookup.
  if (body.action === 'activityDone' || body.action === 'activityDelete') {
    const aid = parseInt(body.activityId, 10);
    if (!Number.isInteger(aid)) return json({ error: 'bad id' }, 400);
    try {
      if (body.action === 'activityDelete') {
        return (await deleteActivity(env, aid))
          ? json({ ok: true, deleted: aid })
          : json({ error: 'That entry is already gone.' }, 404);
      }
      const row = await setActivityDone(env, aid, !!body.done, new Date().toISOString());
      return row ? json({ ok: true, activity: row })
        : json({ error: 'That entry is already gone.' }, 404);
    } catch (err) {
      console.error('activity action failed', body.action, err && err.message);
      return json({ error: 'Could not save — try again.' }, 500);
    }
  }

  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id)) return json({ error: 'bad id' }, 400);

  // An archived lead is invisible in every view, so an action against one is
  // always a stale tab. Refusing beats silently mutating a row nobody can see.
  const target = await env.DB.prepare(
    'SELECT archived_at FROM leads WHERE id = ?').bind(id).first();
  if (!target) return json({ error: 'That lead no longer exists.' }, 404);
  // 'record' is a read: an archived lead is still openable from the
  // Archive tab, and refusing to show its history would be unhelpful.
  if (target.archived_at && !['restore', 'purge', 'record'].includes(body.action)) {
    return json({ error: 'That lead is archived. Restore it first.' }, 409);
  }

  const now = new Date().toISOString();
  try {
    // Everything the record view shows, fetched when the lead is opened
    // rather than shipped with every row in the grid.
    if (body.action === 'record') {
      const rec = await loadRecord(env, id);
      if (!rec) return json({ error: 'That lead no longer exists.' }, 404);
      return json({ ok: true, record: rec });
    }

    // A note, a logged call, or a follow-up with a due date.
    if (body.action === 'activity') {
      const type = String(body.type || 'note');
      if (!LOGGABLE_TYPES.includes(type)) return json({ error: 'bad activity type' }, 400);

      const dueAt = normStamp(body.dueAt);
      if (body.dueAt && !dueAt) return json({ error: "That date didn't make sense." }, 400);
      if (SCHEDULED_TYPES.includes(type) && !dueAt) {
        return json({ error: 'A follow-up needs a date.' }, 400);
      }

      const text = String(body.body == null ? '' : body.body).trim();
      const subject = String(body.subject == null ? '' : body.subject).trim();
      if (!text && !subject) return json({ error: 'Write something first.' }, 400);

      const row = await logActivity(env, {
        lead_id: id,
        contact_id: await contactIdFor(env, id),
        type,
        subject: subject.slice(0, ACTIVITY_LIMITS.subject),
        body: text.slice(0, ACTIVITY_LIMITS.body),
        due_at: dueAt,
        actor
      }, now);
      if (!row) return json({ error: 'Could not save that — try again.' }, 500);
      return json({ ok: true, activity: row });
    }

    if (body.action === 'update') {
      const field = body.field;
      if (!Object.prototype.hasOwnProperty.call(EDITABLE, field)) return json({ error: 'That column is read-only.' }, 400);
      let value = String(body.value == null ? '' : body.value).trim();

      if (EDITABLE[field] === 'datetime') {
        if (value) {
          const t = new Date(value);
          if (isNaN(t.getTime())) return json({ error: "That date didn't make sense." }, 400);
          value = t.toISOString();
        }
        await env.DB.prepare('UPDATE leads SET scheduled_at = ?, updated_at = ? WHERE id = ?')
          .bind(value || null, now, id).run();
        await logQuietly(env, { lead_id: id, contact_id: await contactIdFor(env, id),
          type: 'status', actor,
          subject: value ? 'Scheduled' : 'Unscheduled',
          meta: { field: 'scheduled_at', to: value || null } }, now);
        return json({ ok: true, value: value || null });
      }

      if (EDITABLE[field] === 'minutes') {
        const n = parseInt(value, 10);
        // Nothing legitimate is negative or longer than a working day.
        if (value && (!Number.isInteger(n) || n < 5 || n > 720)) {
          return json({ error: 'A job runs between 5 and 720 minutes.' }, 400);
        }
        await env.DB.prepare('UPDATE leads SET scheduled_mins = ?, updated_at = ? WHERE id = ?')
          .bind(value ? n : null, now, id).run();
        return json({ ok: true, value: value ? n : null });
      }

      if (field === 'status' && value === 'referred') {
        return json({ error: 'Use the Refer button so the referral is recorded and can be billed.' }, 400);
      }
      if (field === 'status') {
        // Validated against the database, so adding a status is a row rather
        // than a deploy. 'referred' is excluded above, not here.
        const known = (await loadStatuses(env)).some((x) => x.key === value);
        if (!known) return json({ error: 'bad status' }, 400);
      }
      if (field === 'pipeline' && !PIPELINES.includes(value)) return json({ error: 'bad pipeline' }, 400);
      if (field === 'referral_status' && !REFERRAL_STATUSES.includes(value)) return json({ error: 'bad referral status' }, 400);
      if (typeof EDITABLE[field] === 'number' && EDITABLE[field]) value = value.slice(0, EDITABLE[field]);

      // A referral nobody booked cannot have been paid for.
      const extra = field === 'referral_status' && value !== 'booked' ? ', referral_paid_at = NULL' : '';

      // Read the old value first: once the UPDATE lands there is nothing
      // left to say what it changed from.
      const prev = TRACKED_FIELDS.includes(field)
        ? await env.DB.prepare(`SELECT ${field} AS v, contact_id FROM leads WHERE id = ?`).bind(id).first()
        : null;

      // `field` is safe to interpolate: it matched a key of EDITABLE above.
      await env.DB.prepare(`UPDATE leads SET ${field} = ?, updated_at = ?${extra} WHERE id = ?`)
        .bind(value, now, id).run();

      // The save has already happened; a failed log must not undo it.
      if (prev && String(prev.v == null ? '' : prev.v) !== value) {
        await logQuietly(env, {
          lead_id: id, contact_id: prev.contact_id, type: 'status', actor,
          subject: `${FIELD_LABEL[field] || field} → ${value || 'none'}`,
          meta: { field, from: prev.v == null ? '' : prev.v, to: value }
        }, now);
      }
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

    if (body.action === 'archive') {
      await env.DB.prepare(
        'UPDATE leads SET archived_at = ?, updated_at = ? WHERE id = ?')
        .bind(now, now, id).run();
      await logQuietly(env, { lead_id: id, contact_id: await contactIdFor(env, id),
        type: 'status', subject: 'Archived', actor, meta: { archived: true } }, now);
      return json({ ok: true, value: now });
    }

    if (body.action === 'restore') {
      await env.DB.prepare(
        'UPDATE leads SET archived_at = NULL, updated_at = ? WHERE id = ?')
        .bind(now, id).run();
      await logQuietly(env, { lead_id: id, contact_id: await contactIdFor(env, id),
        type: 'status', subject: 'Restored from archive', actor, meta: { archived: false } }, now);
      return json({ ok: true, value: null });
    }

    // Irreversible. Only reachable from the Archive tab, and only for a lead
    // that is already archived.
    if (body.action === 'purge') {
      if (!target.archived_at) {
        return json({ error: 'Archive this lead before deleting it.' }, 400);
      }
      await env.DB.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();
      return json({ ok: true, purged: true });
    }

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

