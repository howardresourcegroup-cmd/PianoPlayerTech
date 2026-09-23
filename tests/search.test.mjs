// The search grammar.
//
// This is pure logic reached through a text box, which makes it exactly the
// kind of thing that rots silently: a broken parser returns no results, and
// no results looks the same as no matching leads.

import test from 'node:test';
import assert from 'node:assert';
import { parseQuery, matchesTerms, makeMatcher, FIELDS, IS, HAS }
  from '../crm/search.js';

const lead = (over = {}) => ({
  id: 12, created_at: '2026-09-20T14:02:00Z', pipeline: 'tuning', status: 'new',
  name: 'Dana Whitfield', phone: '(770) 555-0142', email: 'dana@example.com',
  address: '88 Peachtree Ln', city: 'Marietta', system: 'Yamaha U1 upright',
  service: 'Piano Tuning', message: 'Not tuned in four years', notes: null,
  source: '/tuning', referred_at: null, referral_status: null,
  referral_paid_at: null, referral_invoice_id: null, archived_at: null, ...over
});

const hits = (q, row) => makeMatcher(q)(row);

// ------------------------------------------------------------- parsing
test('an empty query parses to no terms and matches everything', () => {
  assert.deepStrictEqual(parseQuery(''), []);
  assert.deepStrictEqual(parseQuery('   '), []);
  assert.ok(hits('', lead()));
});

test('bare words become free terms', () => {
  const t = parseQuery('dana marietta');
  assert.strictEqual(t.length, 2);
  assert.deepStrictEqual(t.map((x) => x.value), ['dana', 'marietta']);
  assert.ok(t.every((x) => x.kind === 'free' && !x.negate));
});

test('a quoted phrase stays one term', () => {
  const t = parseQuery('"pitch raise" dana');
  assert.strictEqual(t.length, 2);
  assert.strictEqual(t[0].value, 'pitch raise');
});

test('field:value resolves through its alias', () => {
  assert.strictEqual(parseQuery('piano:yamaha')[0].field, 'system');
  assert.strictEqual(parseQuery('addr:peachtree')[0].field, 'address');
  assert.strictEqual(parseQuery('note:gate')[0].field, 'notes');
  assert.strictEqual(FIELDS.msg, 'message');
});

test('a leading dash negates', () => {
  const t = parseQuery('-closed -status:lost');
  assert.ok(t[0].negate && t[1].negate);
  assert.strictEqual(t[1].field, 'status');
});

// A prefix that is not a field must not silently match nothing.
test('an unknown prefix is searched as plain text', () => {
  const t = parseQuery('re:tuning');
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].kind, 'free');
  assert.strictEqual(t[0].value, 're:tuning');
});

// ------------------------------------------------------------- matching
test('every word must match, not just one', () => {
  assert.ok(hits('dana marietta', lead()));
  assert.ok(!hits('dana savannah', lead()), 'AND, not OR');
});

test('matching ignores case', () => {
  assert.ok(hits('DANA', lead()));
  assert.ok(hits('yamaha', lead()));
});

test('a field search only looks at that field', () => {
  assert.ok(hits('city:marietta', lead()));
  assert.ok(!hits('city:yamaha', lead()), 'the piano is not the city');
  assert.ok(hits('piano:yamaha', lead()));
});

// Nobody types a phone number the way it is stored.
test('a phone number matches however it is punctuated', () => {
  assert.ok(hits('7705550142', lead()));
  assert.ok(hits('770-555-0142', lead()));
  assert.ok(hits('phone:5550142', lead()));
  assert.ok(hits('(770) 555-0142', lead()));
});

test('a short number is not treated as a phone fragment', () => {
  // "12" is the id; it must not match the phone's digits by accident.
  assert.ok(hits('12', lead()), 'should still match the id');
});

test('negation excludes', () => {
  assert.ok(!hits('-dana', lead()));
  assert.ok(hits('-marcus', lead()));
  assert.ok(!hits('dana -marietta', lead()));
  assert.ok(hits('dana -savannah', lead()));
});

test('a phrase must appear together', () => {
  const r = lead({ message: 'Not tuned in four years' });
  assert.ok(hits('"four years"', r));
  assert.ok(!hits('"years four"', r));
});

// ------------------------------------------------------- is: and has:
test('is: answers questions no column holds', () => {
  assert.ok(hits('is:new', lead()));
  assert.ok(hits('is:open', lead()));
  assert.ok(!hits('is:closed', lead()));
  assert.ok(hits('is:tuning', lead()));
  assert.ok(!hits('is:repair', lead()));

  const booked = lead({ referred_at: '2026-09-01T00:00:00Z', referral_status: 'booked' });
  assert.ok(hits('is:referred', booked));
  assert.ok(hits('is:booked', booked));
  assert.ok(hits('is:unpaid', booked));
  assert.ok(hits('is:unbilled', booked));

  const billed = lead({ ...booked, referral_invoice_id: 9 });
  assert.ok(!hits('is:unbilled', billed), 'it has an invoice now');
  assert.ok(hits('is:unpaid', billed), 'invoiced is not the same as paid');

  const paid = lead({ ...booked, referral_paid_at: '2026-09-10T00:00:00Z' });
  assert.ok(hits('is:paid', paid));
  assert.ok(!hits('is:unpaid', paid));
});

test('has: asks whether a field is filled in', () => {
  assert.ok(hits('has:email', lead()));
  assert.ok(!hits('has:notes', lead()));
  assert.ok(hits('has:notes', lead({ notes: 'gate code 4432' })));
  assert.ok(!hits('has:email', lead({ email: '   ' })), 'blank is not filled in');
});

// The important failure mode: a typo must not quietly match everything.
test('an unknown is: or has: matches nothing', () => {
  assert.ok(!hits('is:bananas', lead()));
  assert.ok(!hits('has:telepathy', lead()));
  // And negated, it matches everything, which is the consistent opposite.
  assert.ok(hits('-is:bananas', lead()));
});

test('every documented condition is implemented', () => {
  for (const k of ['new', 'open', 'closed', 'referred', 'booked', 'paid',
                   'unpaid', 'unbilled', 'archived', 'tuning', 'repair']) {
    assert.strictEqual(typeof IS[k], 'function', `is:${k} missing`);
  }
  for (const k of ['email', 'phone', 'address', 'notes', 'invoice']) {
    assert.strictEqual(typeof HAS[k], 'function', `has:${k} missing`);
  }
});

// ------------------------------------------------------------ combining
test('the real query this was built for', () => {
  const rows = [
    lead({ id: 1, city: 'Marietta', pipeline: 'tuning', referred_at: 'x', referral_status: 'booked' }),
    lead({ id: 2, city: 'Marietta', pipeline: 'tuning', referred_at: 'x', referral_status: 'booked', referral_invoice_id: 5 }),
    lead({ id: 3, city: 'Atlanta', pipeline: 'tuning', referred_at: 'x', referral_status: 'booked' }),
    lead({ id: 4, city: 'Marietta', pipeline: 'repair' })
  ];
  const terms = parseQuery('city:marietta is:tuning is:unbilled');
  const found = rows.filter((r) => matchesTerms(r, terms)).map((r) => r.id);
  assert.deepStrictEqual(found, [1], 'only the Marietta tuning that is not yet invoiced');
});

test('a null field never throws and never matches', () => {
  const r = lead({ notes: null, email: null, message: null });
  assert.ok(!hits('anything', r));
  assert.ok(hits('dana', r));
});
