// Merging two people who are not the same person is worse than leaving
// duplicates, and it is hard to undo. These tests pin the conservative rule:
// merge only on strong evidence, flag everything else for a human.
import test from 'node:test';
import assert from 'node:assert';
import { normPhone, normEmail, namesCompatible, clusterLeads, stripDupSuffix }
  from '../functions/_lib/dedupe.js';

// ------------------------------------------------------------- normalising
test('phones normalise to their last ten digits', () => {
  assert.strictEqual(normPhone('(770) 555-0142'), '7705550142');
  assert.strictEqual(normPhone('770-555-0142'), '7705550142');
  assert.strictEqual(normPhone('+1 770 555 0142'), '7705550142');
  assert.strictEqual(normPhone('17705550142'), '7705550142');
});

test('a phone too short to identify anyone normalises to empty', () => {
  assert.strictEqual(normPhone('555'), '');
  assert.strictEqual(normPhone(''), '');
  assert.strictEqual(normPhone(null), '');
});

test('emails normalise by case and surrounding space', () => {
  assert.strictEqual(normEmail('  Dana@Example.COM '), 'dana@example.com');
  assert.strictEqual(normEmail(''), '');
  assert.strictEqual(normEmail(null), '');
  assert.strictEqual(normEmail('not-an-email'), '');
});

// -------------------------------------------------------- name compatibility
test('an empty name is compatible with anything', () => {
  assert.ok(namesCompatible('', 'Dana Whitfield'));
  assert.ok(namesCompatible('Dana Whitfield', null));
});

test('the same name in any casing or punctuation is compatible', () => {
  assert.ok(namesCompatible('dana whitfield', 'Dana Whitfield'));
  assert.ok(namesCompatible("O'Brien, Pat", 'Pat OBrien'));
});

test('a first name is compatible with its own full name', () => {
  assert.ok(namesCompatible('Dana', 'Dana Whitfield'));
  assert.ok(namesCompatible('Dana Whitfield', 'Dana'));
});

// The case that protects a household: two different people, one landline.
test('clearly different names are NOT compatible', () => {
  assert.ok(!namesCompatible('Dana Whitfield', 'Marcus Bell'));
  assert.ok(!namesCompatible('Dana', 'Marcus'));
});

test('a shared surname alone is not enough', () => {
  assert.ok(!namesCompatible('Dana Whitfield', 'Marcus Whitfield'));
});

// -------------------------------------------------------------- clustering
const L = (id, name, phone, email) => ({ id, name, phone, email });

test('leads sharing a phone and a compatible name become one contact', () => {
  const { clusters, flagged } = clusterLeads([
    L(1, 'Dana Whitfield', '(770) 555-0142', 'dana@example.com'),
    L(2, 'Dana', '770-555-0142', '')
  ]);
  assert.strictEqual(clusters.length, 1);
  assert.deepStrictEqual(clusters[0].leadIds, [1, 2]);
  assert.strictEqual(flagged.length, 0);
});

test('leads sharing an email become one contact even with different phones', () => {
  const { clusters } = clusterLeads([
    L(1, 'Dana Whitfield', '770-555-0142', 'dana@example.com'),
    L(2, 'Dana Whitfield', '404-555-9999', 'Dana@Example.com')
  ]);
  assert.strictEqual(clusters.length, 1);
  assert.deepStrictEqual(clusters[0].leadIds, [1, 2]);
});

// The important negative case.
test('a shared phone with different names is flagged, never merged', () => {
  const { clusters, flagged } = clusterLeads([
    L(1, 'Dana Whitfield', '770-555-0142', ''),
    L(2, 'Marcus Bell', '770-555-0142', '')
  ]);
  assert.strictEqual(clusters.length, 2, 'these must stay separate contacts');
  assert.strictEqual(flagged.length, 1);
  assert.deepStrictEqual(flagged[0].leadIds.sort(), [1, 2]);
  assert.match(flagged[0].reason, /same phone/i);
});

test('leads with no phone and no email each stand alone', () => {
  const { clusters } = clusterLeads([
    L(1, 'Anonymous One', '', ''),
    L(2, 'Anonymous Two', '', '')
  ]);
  assert.strictEqual(clusters.length, 2);
});

test('a chain of matches collapses into a single contact', () => {
  // 1 and 2 share a phone; 2 and 3 share an email. All one person.
  const { clusters } = clusterLeads([
    L(1, 'Dana Whitfield', '770-555-0142', ''),
    L(2, 'Dana Whitfield', '770-555-0142', 'dana@example.com'),
    L(3, 'Dana Whitfield', '', 'dana@example.com')
  ]);
  assert.strictEqual(clusters.length, 1);
  assert.deepStrictEqual(clusters[0].leadIds, [1, 2, 3]);
});

test('the contact takes the fullest name and most recent details', () => {
  const { clusters } = clusterLeads([
    { id: 1, name: 'Dana', phone: '770-555-0142', email: '',
      address: '', city: 'Marietta', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, name: 'Dana Whitfield', phone: '770-555-0142', email: 'dana@example.com',
      address: '88 Peachtree Ln', city: 'Marietta', created_at: '2026-06-01T00:00:00Z' }
  ]);
  const c = clusters[0].contact;
  assert.strictEqual(c.name, 'Dana Whitfield', 'should prefer the fuller name');
  assert.strictEqual(c.email, 'dana@example.com');
  assert.strictEqual(c.address, '88 Peachtree Ln', 'should prefer the later address');
});

test('clustering is deterministic regardless of input order', () => {
  const rows = [
    L(3, 'Dana Whitfield', '', 'dana@example.com'),
    L(1, 'Dana Whitfield', '770-555-0142', ''),
    L(2, 'Dana Whitfield', '770-555-0142', 'dana@example.com')
  ];
  const a = clusterLeads(rows).clusters[0].leadIds;
  const b = clusterLeads([...rows].reverse()).clusters[0].leadIds;
  assert.deepStrictEqual(a, b);
});

// ------------------------------------------------- duplicate-submission names
// A repeat form submission arrives as "Arthur Schiff 2". That trailing count
// is an artifact of the form, not part of the person's name, and the contact
// name ends up on invoices.
test('a duplicate-submission suffix is stripped from a name', () => {
  assert.strictEqual(stripDupSuffix('Arthur Schiff 2'), 'Arthur Schiff');
  assert.strictEqual(stripDupSuffix('Ramzi 2'), 'Ramzi');
  assert.strictEqual(stripDupSuffix('Fisher Martin 10'), 'Fisher Martin');
});

test('a name that is not a duplicate suffix is left alone', () => {
  assert.strictEqual(stripDupSuffix('Arthur Schiff'), 'Arthur Schiff');
  assert.strictEqual(stripDupSuffix('Henry VIII'), 'Henry VIII');
  // Nothing recognisable would remain, so leave it as it is.
  assert.strictEqual(stripDupSuffix('2'), '2');
  assert.strictEqual(stripDupSuffix(''), '');
});

test('the contact takes the clean name, not the longest one', () => {
  const { clusters } = clusterLeads([
    { id: 1, name: 'Arthur Schiff', phone: '404-245-2280', email: 'art@example.com' },
    { id: 2, name: 'Arthur Schiff 2', phone: '404-245-2280', email: 'art@example.com' }
  ]);
  assert.strictEqual(clusters[0].contact.name, 'Arthur Schiff');
});

test('a fuller name still wins once suffixes are stripped', () => {
  const { clusters } = clusterLeads([
    { id: 1, name: 'Fisher 2', phone: '470-421-5635', email: 'f@example.com' },
    { id: 2, name: 'Fisher Martin 2', phone: '470-421-5635', email: 'f@example.com' }
  ]);
  assert.strictEqual(clusters[0].contact.name, 'Fisher Martin');
});
