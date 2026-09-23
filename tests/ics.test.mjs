// The calendar feed's format.
//
// Google and Apple both fail quietly when an .ics is malformed, and neither
// tells the person who subscribed -- so the failure mode is "my calendar is
// just missing things" weeks later. These tests pin the rules that actually
// break clients rather than the ones that look tidy.

import test from 'node:test';
import assert from 'node:assert';
import {
  escapeText, foldLine, stamp, vevent, buildCalendar, eventsFor,
  DEFAULT_MINS, CALLBACK_AFTER_MINS, REFERRAL_FOLLOWUP_DAYS
} from '../functions/_lib/ics.js';

const bytes = (s) => new TextEncoder().encode(s).length;

// ------------------------------------------------------------- escaping
test('the four characters that must be escaped are', () => {
  assert.strictEqual(escapeText('a;b'), 'a\\;b');
  assert.strictEqual(escapeText('a,b'), 'a\\,b');
  assert.strictEqual(escapeText('a\\b'), 'a\\\\b');
  assert.strictEqual(escapeText('a\nb'), 'a\\nb');
  assert.strictEqual(escapeText('a\r\nb'), 'a\\nb');
});

// The ordering bug: escaping the backslash last would re-escape what we add.
test('a backslash is escaped first, not last', () => {
  assert.strictEqual(escapeText('a\;b'), 'a\\\;b');
});

test('an address with a comma survives as one value', () => {
  assert.strictEqual(escapeText('88 Peachtree Ln, Marietta, GA'),
    '88 Peachtree Ln\\, Marietta\\, GA');
});

// -------------------------------------------------------------- folding
test('a short line is left alone', () => {
  assert.strictEqual(foldLine('SUMMARY:Tuning'), 'SUMMARY:Tuning');
});

test('a long line folds at 75 octets with a leading space', () => {
  const folded = foldLine('DESCRIPTION:' + 'x'.repeat(200));
  const lines = folded.split('\r\n');
  assert.ok(lines.length > 1, 'should have folded');
  assert.strictEqual(bytes(lines[0]), 75);
  for (const l of lines.slice(1)) {
    assert.ok(l.startsWith(' '), 'a continuation must start with a space');
    assert.ok(bytes(l) <= 75, `continuation is ${bytes(l)} octets`);
  }
  // Unfolding must give back exactly what went in.
  assert.strictEqual(folded.split('\r\n ').join(''), 'DESCRIPTION:' + 'x'.repeat(200));
});

// The rule is octets, but cutting mid-character produces mojibake or a
// rejected calendar.
test('folding never splits a multi-byte character', () => {
  const folded = foldLine('SUMMARY:' + 'é'.repeat(80));
  for (const l of folded.split('\r\n')) {
    assert.ok(bytes(l) <= 75, `${bytes(l)} octets`);
    // A broken cut would leave an unpaired surrogate or a replacement char.
    assert.ok(!l.includes('�'), 'a character was cut in half');
  }
  assert.strictEqual(folded.split('\r\n ').join(''), 'SUMMARY:' + 'é'.repeat(80));
});

test('an emoji is measured in octets too', () => {
  const folded = foldLine('SUMMARY:' + '🎹'.repeat(40));
  for (const l of folded.split('\r\n')) assert.ok(bytes(l) <= 75);
  assert.strictEqual(folded.split('\r\n ').join(''), 'SUMMARY:' + '🎹'.repeat(40));
});

// ------------------------------------------------------------- stamping
test('a timestamp is UTC basic format with the Z', () => {
  assert.strictEqual(stamp('2026-09-23T14:05:00.000Z'), '20260923T140500Z');
  assert.strictEqual(stamp(new Date('2026-01-02T03:04:05Z')), '20260102T030405Z');
});

test('an unreadable date stamps to nothing rather than Invalid Date', () => {
  assert.strictEqual(stamp('not a date'), '');
});

// -------------------------------------------------------------- events
test('an event carries start, end and the fields a phone needs', () => {
  const v = vevent({ uid: 'x@y', start: '2026-09-23T14:00:00Z', mins: 90,
    summary: 'Tuning — Dana', description: '770-555-0142', location: '88 Peachtree Ln' }).join('\r\n');
  assert.match(v, /^BEGIN:VEVENT/);
  assert.match(v, /UID:x@y/);
  assert.match(v, /DTSTART:20260923T140000Z/);
  assert.match(v, /DTEND:20260923T153000Z/, '90 minutes later');
  assert.match(v, /SUMMARY:Tuning — Dana/);
  assert.match(v, /LOCATION:88 Peachtree Ln/);
  assert.match(v, /END:VEVENT$/);
});

test('a missing length falls back to the default', () => {
  const v = vevent({ uid: 'x@y', start: '2026-09-23T14:00:00Z' }).join('\r\n');
  const end = new Date(Date.parse('2026-09-23T14:00:00Z') + DEFAULT_MINS * 60000);
  assert.ok(v.includes('DTEND:' + stamp(end)));
});

test('an event with an unreadable date is dropped, not emitted broken', () => {
  assert.strictEqual(vevent({ uid: 'x@y', start: 'whenever' }), null);
});

// The UID is an identifier; escaping it would change it.
test('a UID is not text-escaped', () => {
  const v = vevent({ uid: 'lead-1-job@pianoplayertech.com', start: '2026-09-23T14:00:00Z' }).join('\r\n');
  assert.ok(v.includes('UID:lead-1-job@pianoplayertech.com'));
  assert.ok(!v.includes('\\,'), 'nothing in this UID needed escaping');
});

// ------------------------------------------------------------ calendar
test('the calendar has the headers clients check for', () => {
  const cal = buildCalendar([]);
  for (const h of ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:', 'CALSCALE:GREGORIAN',
                   'METHOD:PUBLISH', 'X-WR-CALNAME:', 'END:VCALENDAR']) {
    assert.ok(cal.includes(h), `missing ${h}`);
  }
});

test('every line ends CRLF, including the last', () => {
  const cal = buildCalendar([{ uid: 'a@b', start: '2026-09-23T14:00:00Z', summary: 'x' }]);
  assert.ok(cal.endsWith('END:VCALENDAR\r\n'));
  // A bare LF anywhere is the classic quiet failure.
  assert.strictEqual(cal.split('\n').length - 1, cal.split('\r\n').length - 1,
    'found a bare LF without its CR');
});

test('an empty calendar is still a valid calendar', () => {
  const cal = buildCalendar([]);
  assert.ok(cal.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(cal.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!cal.includes('BEGIN:VEVENT'));
});

// ---------------------------------------------------- deriving from leads
const lead = (o = {}) => ({
  id: 7, created_at: '2026-09-23T10:00:00Z', status: 'contacted', name: 'Dana Whitfield',
  phone: '770-555-0142', email: 'd@x.com', address: '88 Peachtree Ln', city: 'Marietta',
  service: 'Piano Tuning', system: 'Yamaha U1', message: '', scheduled_at: null,
  scheduled_mins: null, referred_at: null, referral_status: null, archived_at: null, ...o
});

test('a scheduled job becomes a job event at its address', () => {
  const [e] = eventsFor([lead({ scheduled_at: '2026-09-25T14:00:00Z', scheduled_mins: 60 })]);
  assert.strictEqual(e.uid, 'lead-7-job@pianoplayertech.com');
  assert.strictEqual(e.mins, 60);
  assert.match(e.summary, /Piano Tuning/);
  assert.strictEqual(e.location, '88 Peachtree Ln');
});

test('a new lead becomes a callback half an hour after it arrived', () => {
  const [e] = eventsFor([lead({ status: 'new' })]);
  assert.strictEqual(e.uid, 'lead-7-callback@pianoplayertech.com');
  assert.strictEqual(new Date(e.start).toISOString(),
    new Date(Date.parse('2026-09-23T10:00:00Z') + CALLBACK_AFTER_MINS * 60000).toISOString());
});

test('a referral that has not been heard about becomes a check a week later', () => {
  const [e] = eventsFor([lead({ referred_at: '2026-09-01T10:00:00Z', referral_status: 'sent' })]);
  assert.strictEqual(e.uid, 'lead-7-referral@pianoplayertech.com');
  assert.strictEqual(new Date(e.start).toISOString(),
    new Date(Date.parse('2026-09-01T10:00:00Z') + REFERRAL_FOLLOWUP_DAYS * 86400000).toISOString());
});

test('a booked referral is not chased', () => {
  assert.strictEqual(eventsFor([lead({ referred_at: '2026-09-01T10:00:00Z', referral_status: 'booked' })]).length, 0);
});

test('one lead can produce several events, each with its own stable id', () => {
  const es = eventsFor([lead({ status: 'new', scheduled_at: '2026-09-25T14:00:00Z',
    referred_at: '2026-09-01T10:00:00Z', referral_status: 'sent' })]);
  assert.deepStrictEqual(es.map((e) => e.uid).sort(), [
    'lead-7-callback@pianoplayertech.com',
    'lead-7-job@pianoplayertech.com',
    'lead-7-referral@pianoplayertech.com'
  ]);
});

// Stability is what makes a reschedule update rather than duplicate.
test('rescheduling keeps the same UID', () => {
  const a = eventsFor([lead({ scheduled_at: '2026-09-25T14:00:00Z' })])[0];
  const b = eventsFor([lead({ scheduled_at: '2026-09-28T09:00:00Z' })])[0];
  assert.strictEqual(a.uid, b.uid);
  assert.notStrictEqual(a.start, b.start);
});

test('an archived lead contributes nothing', () => {
  assert.strictEqual(eventsFor([lead({ status: 'new', archived_at: '2026-09-23T11:00:00Z' })]).length, 0);
});

test('a typed follow-up becomes an event, unless it is done', () => {
  const es = eventsFor([], [
    { id: 3, due_at: '2026-09-26T09:00:00Z', subject: 'Ring back', body: 'about the quote',
      completed_at: null, lead_name: 'Dana' },
    { id: 4, due_at: '2026-09-26T09:00:00Z', subject: 'Done one', completed_at: '2026-09-25T00:00:00Z' }
  ]);
  assert.strictEqual(es.length, 1);
  assert.strictEqual(es[0].uid, 'activity-3@pianoplayertech.com');
  assert.strictEqual(es[0].summary, 'Ring back');
});

// The end-to-end shape: a customer whose details contain the characters that
// break feeds.
test('a hostile customer name survives the whole pipeline', () => {
  const cal = buildCalendar(eventsFor([lead({
    status: 'new',
    name: 'Smith; Jones, "Bob" \\ Co',
    address: '1 A St, Apt 2; rear',
    message: 'line one\nline two'
  })]));
  assert.ok(cal.includes('\;'), 'semicolon escaped');
  assert.ok(cal.includes('\\,'), 'comma escaped');
  assert.ok(cal.includes('\\\\'), 'backslash escaped');
  assert.ok(cal.includes('\\n'), 'newline escaped');
  // No raw newline may leak into the middle of a value.
  for (const l of cal.split('\r\n')) {
    assert.ok(!/^[^A-Z;: -]/.test(l) || l.startsWith(' '),
      `a line began unexpectedly, suggesting a broken value: ${JSON.stringify(l)}`);
  }
});
