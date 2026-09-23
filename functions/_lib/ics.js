// Generating an iCalendar feed.
//
// RFC 5545 compliance is not a matter of taste here. Google Calendar and
// Apple Calendar both fail quietly and differently when it is wrong: Google
// tends to drop the offending event, Apple tends to reject the whole
// calendar. Neither tells the person subscribing. So the rules that matter
// are implemented deliberately and tested:
//
//   - CRLF line endings, everywhere, including the last line
//   - lines folded at 75 OCTETS, continued with a leading space, and folded
//     on a character boundary so a multi-byte character is never cut in half
//   - backslash, semicolon, comma and newline escaped in every text value
//   - UTC timestamps, with the Z
//
// UIDs are stable and derived from the lead, which is what makes a
// reschedule update the existing event instead of adding a second one. That
// is the most common defect in hand-rolled feeds, and it is invisible until
// somebody's phone shows two appointments.

export const DEFAULT_MINS = 90;
export const CALLBACK_AFTER_MINS = 30;
export const REFERRAL_FOLLOWUP_DAYS = 7;
export const EVENT_MINS = 15;

// RFC 5545 §3.3.11: escape backslash first, or the escapes we add get
// escaped again.
export function escapeText(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

const enc = new TextEncoder();

/**
 * Fold one content line to 75 octets.
 *
 * The limit is octets, not characters, but a fold must not land inside a
 * multi-byte character -- so this measures in bytes and cuts on character
 * boundaries. Continuation lines begin with a single space, which the parser
 * strips back off.
 */
export function foldLine(line) {
  const s = String(line == null ? '' : line);
  if (enc.encode(s).length <= 75) return s;

  const out = [];
  let cur = '';
  let curBytes = 0;
  // The first line may use 75 octets; a continuation loses one to its space.
  let limit = 75;

  for (const ch of s) {          // iterates by code point, not code unit
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = ch;
      curBytes = n;
      limit = 74;
    } else {
      cur += ch;
      curBytes += n;
    }
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

// 2026-09-23T14:05:00.000Z -> 20260923T140500Z
export function stamp(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (isNaN(t.getTime())) return '';
  return t.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function line(name, value) {
  return foldLine(name + ':' + escapeText(value));
}

/**
 * One VEVENT.
 * @param e {uid, start (Date|iso), mins, summary, description, location, stampedAt}
 */
export function vevent(e) {
  const start = e.start instanceof Date ? e.start : new Date(e.start);
  if (isNaN(start.getTime())) return null;
  const mins = Number.isFinite(e.mins) && e.mins > 0 ? e.mins : DEFAULT_MINS;
  const end = new Date(start.getTime() + mins * 60000);

  const out = [
    'BEGIN:VEVENT',
    // The UID is an identifier, not text: escaping it would change it.
    foldLine('UID:' + e.uid),
    foldLine('DTSTAMP:' + stamp(e.stampedAt || start)),
    foldLine('DTSTART:' + stamp(start)),
    foldLine('DTEND:' + stamp(end)),
    line('SUMMARY', e.summary || 'PianoPlayerTech')
  ];
  if (e.description) out.push(line('DESCRIPTION', e.description));
  if (e.location) out.push(line('LOCATION', e.location));
  out.push('END:VEVENT');
  return out;
}

/**
 * The whole calendar.
 * @param events array of event objects for vevent()
 */
export function buildCalendar(events, opts = {}) {
  const name = opts.name || 'PianoPlayerTech';
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    foldLine('PRODID:-//PianoPlayerTech//CRM//EN'),
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    line('X-WR-CALNAME', name),
    // Hints only. Subscribers poll on their own schedule -- Google can lag
    // by hours -- so the dashboard stays the authority on what is true.
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M'
  ];
  for (const e of events) {
    const block = vevent(e);
    if (block) out.push(...block);
  }
  out.push('END:VCALENDAR');
  // A trailing CRLF: the last line is a line like any other.
  return out.join('\r\n') + '\r\n';
}

const addMins = (iso, m) => new Date(new Date(iso).getTime() + m * 60000);
const addDays = (iso, d) => new Date(new Date(iso).getTime() + d * 86400000);

const who = (l) => l.name || 'Customer';
const contactLine = (l) => [l.phone, l.email].filter(Boolean).join(' · ');

/**
 * Turn leads and follow-ups into events.
 *
 * Nothing about the feed is stored. Every event is derived, so a lead that
 * stops qualifying simply stops appearing -- and because the feed is
 * METHOD:PUBLISH, disappearing is how an event gets removed. No cancellation
 * bookkeeping.
 */
export function eventsFor(leads, followups = []) {
  const out = [];

  for (const l of leads) {
    if (l.archived_at) continue;   // belt and braces; the query excludes them

    if (l.scheduled_at) {
      out.push({
        uid: `lead-${l.id}-job@pianoplayertech.com`,
        start: l.scheduled_at,
        mins: l.scheduled_mins || DEFAULT_MINS,
        summary: `${l.service || 'Piano work'} — ${who(l)}`,
        description: [contactLine(l), l.system, l.message].filter(Boolean).join('\n'),
        location: l.address || l.city || ''
      });
    }

    // A new lead is a callback you owe, half an hour after it arrived.
    if (l.status === 'new' && l.created_at) {
      out.push({
        uid: `lead-${l.id}-callback@pianoplayertech.com`,
        start: addMins(l.created_at, CALLBACK_AFTER_MINS),
        mins: EVENT_MINS,
        summary: `Call ${who(l)}`,
        description: [contactLine(l), l.service, l.message].filter(Boolean).join('\n'),
        location: l.address || ''
      });
    }

    // A referral nobody has heard back about, a week on.
    if (l.referral_status === 'sent' && l.referred_at) {
      out.push({
        uid: `lead-${l.id}-referral@pianoplayertech.com`,
        start: addDays(l.referred_at, REFERRAL_FOLLOWUP_DAYS),
        mins: EVENT_MINS,
        summary: `Referral check: ${who(l)}`,
        description: ['Did World Class book this one?', contactLine(l)].filter(Boolean).join('\n'),
        location: ''
      });
    }
  }

  // Follow-ups somebody typed into the record view. These are the only
  // events with a date a person actually chose.
  for (const a of followups) {
    if (!a.due_at || a.completed_at) continue;
    out.push({
      uid: `activity-${a.id}@pianoplayertech.com`,
      start: a.due_at,
      mins: EVENT_MINS,
      summary: a.subject || (a.lead_name ? `Follow up: ${a.lead_name}` : 'Follow up'),
      description: [a.body, a.lead_name].filter(Boolean).join('\n'),
      location: ''
    });
  }

  return out;
}
