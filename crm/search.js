// Parsing what somebody types into the search box.
//
// The old box did one thing: lowercase substring across a fixed list of
// fields. That is fine until you have a few hundred leads and want "the
// Marietta tunings I haven't billed", which is three conditions.
//
// The grammar is the one people already expect from a search box, because
// they have used GitHub and Gmail:
//
//   dana marietta        every word must match somewhere   (AND, not OR)
//   "pitch raise"        a phrase, kept together
//   city:marietta        one field
//   piano:yamaha         an alias for system
//   -closed              exclude
//   -status:closed       exclude by field
//   is:open              a computed condition, not a column
//   has:email            the field is filled in
//
// Everything here is pure: no DOM, no fetch. That is what lets it be tested
// properly rather than driven through a browser.

// Columns you can name directly, plus the aliases people actually type.
export const FIELDS = {
  name: 'name', phone: 'phone', email: 'email', city: 'city',
  address: 'address', addr: 'address', system: 'system', piano: 'system',
  service: 'service', message: 'message', msg: 'message',
  note: 'notes', notes: 'notes', status: 'status', pipeline: 'pipeline',
  id: 'id', source: 'source'
};

// What a bare word is compared against.
export const FREE_FIELDS = [
  'name', 'phone', 'email', 'city', 'address', 'system', 'service',
  'message', 'notes', 'id', 'status'
];

const norm = (v) => String(v == null ? '' : v).toLowerCase();

// Digits only, so "7705550142", "770-555-0142" and "(770) 555-0142" are the
// same search. Anyone typing a phone number expects that.
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');

// Day boundaries in the viewer's own zone, because "today" means the day
// they are having, not a UTC day that starts at 8pm for them.
function dayStart(d){ var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function within(iso, from, to){
  if (!iso) return false;
  var t = new Date(iso).getTime();
  return !isNaN(t) && t >= from.getTime() && t < to.getTime();
}

/**
 * Computed conditions. Each takes the row and the current time, and answers
 * a question no single column can.
 */
export const IS = {
  new: (r) => r.status === 'new',
  open: (r) => r.status !== 'closed' && r.status !== 'lost' && r.status !== 'paid',
  closed: (r) => r.status === 'closed' || r.status === 'lost',
  referred: (r) => !!r.referred_at,
  booked: (r) => r.referral_status === 'booked',
  paid: (r) => !!r.referral_paid_at,
  unpaid: (r) => r.referral_status === 'booked' && !r.referral_paid_at,
  unbilled: (r) => r.referral_status === 'booked' && !r.referral_paid_at && !r.referral_invoice_id,
  archived: (r) => !!r.archived_at,
  tuning: (r) => r.pipeline === 'tuning',
  repair: (r) => r.pipeline === 'repair',

  // Scheduling.
  scheduled: (r) => !!r.scheduled_at,
  unscheduled: (r) => !r.scheduled_at,
  today: (r, now) => {
    var from = dayStart(now);
    return within(r.scheduled_at, from, new Date(from.getTime() + 86400000));
  },
  tomorrow: (r, now) => {
    var from = new Date(dayStart(now).getTime() + 86400000);
    return within(r.scheduled_at, from, new Date(from.getTime() + 86400000));
  },
  // The next seven days, which is what somebody means by "this week" when
  // they are looking at a work diary on a Wednesday.
  week: (r, now) => {
    var from = dayStart(now);
    return within(r.scheduled_at, from, new Date(from.getTime() + 7 * 86400000));
  },
  upcoming: (r, now) => !!r.scheduled_at && new Date(r.scheduled_at).getTime() >= now.getTime(),
  // A job whose time has passed and which nobody has closed out.
  late: (r, now) => !!r.scheduled_at && new Date(r.scheduled_at).getTime() < now.getTime() &&
    r.status !== 'completed' && r.status !== 'closed' && r.status !== 'paid' && r.status !== 'lost'
};

export const HAS = {
  email: (r) => !!String(r.email || '').trim(),
  phone: (r) => !!String(r.phone || '').trim(),
  address: (r) => !!String(r.address || '').trim(),
  notes: (r) => !!String(r.notes || '').trim(),
  invoice: (r) => r.referral_invoice_id != null
};

/**
 * Split a query into terms.
 *
 * @returns [{kind, field, value, negate}]
 *   kind: 'free' | 'field' | 'is' | 'has'
 */
export function parseQuery(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];

  const out = [];
  // A leading '-' negates. A field name may be followed by a quoted phrase
  // or a bare run of non-space characters.
  const re = /(-)?(?:([a-zA-Z_]+):)?(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const negate = !!m[1];
    const rawField = m[2] ? m[2].toLowerCase() : '';
    const value = (m[3] !== undefined ? m[3] : m[4] || '').trim();
    if (!value && !rawField) continue;

    if (rawField === 'is') {
      out.push({ kind: 'is', field: 'is', value: value.toLowerCase(), negate });
    } else if (rawField === 'has') {
      out.push({ kind: 'has', field: 'has', value: value.toLowerCase(), negate });
    } else if (rawField && FIELDS[rawField]) {
      out.push({ kind: 'field', field: FIELDS[rawField], value: value.toLowerCase(), negate });
    } else if (rawField) {
      // An unknown prefix is not a field. Treat the whole thing as text, so
      // searching for "re:tuning" or a time like "9:30" still finds
      // something instead of silently matching nothing.
      out.push({ kind: 'free', field: '', value: (rawField + ':' + value).toLowerCase(), negate });
    } else {
      out.push({ kind: 'free', field: '', value: value.toLowerCase(), negate });
    }
  }
  return out;
}

function fieldMatches(row, field, value) {
  if (field === 'phone') {
    const d = digits(value);
    // A numeric search compares digits; a letter search falls back to text.
    if (d) return digits(row.phone).indexOf(d) >= 0;
  }
  return norm(row[field]).indexOf(value) >= 0;
}

function freeMatches(row, value) {
  const d = digits(value);
  if (d.length >= 4 && digits(row.phone).indexOf(d) >= 0) return true;
  for (const f of FREE_FIELDS) {
    if (norm(row[f]).indexOf(value) >= 0) return true;
  }
  return false;
}

/**
 * Does one row satisfy every term?
 *
 * Terms are ANDed, which is what people mean when they type two words. An
 * unknown is:/has: condition matches nothing rather than everything: a typo
 * should show you no results, not silently show you all of them.
 */
export function matchesTerms(row, terms, now) {
  const when = now instanceof Date ? now : new Date();
  for (const t of terms) {
    let hit;
    if (t.kind === 'is') hit = Object.prototype.hasOwnProperty.call(IS, t.value) ? !!IS[t.value](row, when) : false;
    else if (t.kind === 'has') hit = Object.prototype.hasOwnProperty.call(HAS, t.value) ? !!HAS[t.value](row) : false;
    else if (t.kind === 'field') hit = fieldMatches(row, t.field, t.value);
    else hit = freeMatches(row, t.value);

    if (t.negate ? hit : !hit) return false;
  }
  return true;
}

// Convenience for callers that just have a string.
export function makeMatcher(raw, now) {
  const terms = parseQuery(raw);
  // Captured once so every row in a pass is judged against the same instant.
  const when = now instanceof Date ? now : new Date();
  return (row) => matchesTerms(row, terms, when);
}

// What the search box offers as help.
export const SEARCH_HINTS = [
  ['is:today', "today's jobs"],
  ['is:week', 'the next seven days'],
  ['is:unscheduled', 'no date yet'],
  ['city:marietta', 'one field'],
  ['"pitch raise"', 'a phrase'],
  ['is:unbilled', 'booked, not paid, not invoiced'],
  ['is:open', 'still live work'],
  ['has:email', 'the field is filled in'],
  ['-closed', 'exclude']
];
