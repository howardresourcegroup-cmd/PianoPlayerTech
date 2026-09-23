// The subscribable calendar feed.
//
// A calendar client cannot authenticate: no cookies, no Cloudflare Access,
// no OAuth. The only mechanism that works is an unguessable URL, which makes
// this URL a bearer credential for customer names, addresses and phone
// numbers. That is inherent to calendar subscription, not a shortcut taken
// here, and it is why the feed is off until somebody switches it on.
//
// What follows from that:
//
//   - the token is compared in constant time, like a password;
//   - a wrong or missing token gets 404, not 403, so the endpoint does not
//     confirm that a calendar exists to be guessed at;
//   - nothing here logs the token, including on the failure paths;
//   - the response is private, no-store and noindex, so it is not cached by
//     an intermediary or found by a crawler that is handed the link.

import { safeEqual } from '../_lib/auth.js';
import { getSetting, CALENDAR_TOKEN } from '../_lib/settings.js';
import { buildCalendar, eventsFor } from '../_lib/ics.js';
import { NOT_ARCHIVED } from '../_lib/db.js';

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestGet(context) {
  const { params, env } = context;
  if (!env.DB) return notFound();

  const supplied = String(params.token || '').replace(/\.ics$/i, '');
  if (!supplied) return notFound();

  const real = await getSetting(env, CALENDAR_TOKEN);
  // No calendar has been turned on, so there is nothing here -- and nothing
  // to compare against either.
  if (!real) return notFound();
  if (!safeEqual(supplied, real)) return notFound();

  let leads = [];
  let followups = [];
  try {
    leads = (await env.DB.prepare(
      `SELECT id, created_at, status, name, phone, email, address, city,
              service, system, message, scheduled_at, scheduled_mins,
              referred_at, referral_status, archived_at
         FROM leads
        WHERE ${NOT_ARCHIVED}
          AND (scheduled_at IS NOT NULL
               OR status = 'new'
               OR (referral_status = 'sent' AND referred_at IS NOT NULL))
        LIMIT 2000`).all()).results || [];

    followups = (await env.DB.prepare(
      `SELECT a.id, a.due_at, a.subject, a.body, a.completed_at, l.name AS lead_name
         FROM activities a
         LEFT JOIN leads l ON l.id = a.lead_id
        WHERE a.due_at IS NOT NULL
          AND a.completed_at IS NULL
          AND (l.id IS NULL OR l.archived_at IS NULL)
        LIMIT 500`).all()).results || [];
  } catch (err) {
    // Never name the token in a log line.
    console.error('calendar feed query failed', err && err.message);
    // An empty calendar beats an error page: a client that gets a 500
    // may unsubscribe on its own.
    return calendarResponse(buildCalendar([]));
  }

  return calendarResponse(buildCalendar(eventsFor(leads, followups)));
}

function calendarResponse(body) {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="pianoplayertech.ics"',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
