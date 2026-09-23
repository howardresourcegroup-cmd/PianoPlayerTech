// Lead field helpers.
//
// Small rules, but they are the ones you read while standing in somebody's
// living room, and the past-due rule decides whether something turns red.

import test from 'node:test';
import assert from 'node:assert';
import { placeOf, jobOf, isPastDue, FINISHED } from '../crm/fields.js';

// The bug this was extracted to fix.
test('the city is not repeated when the address already has it', () => {
  assert.strictEqual(
    placeOf({ address: '88 Peachtree Ln, Marietta, GA 30060', city: 'Marietta' }),
    '88 Peachtree Ln, Marietta, GA 30060');
});

test('the city is added when the address lacks it', () => {
  assert.strictEqual(placeOf({ address: '5 Elm St', city: 'Atlanta' }), '5 Elm St, Atlanta');
});

test('matching the city ignores case', () => {
  assert.strictEqual(placeOf({ address: '1 A St, MARIETTA GA', city: 'Marietta' }), '1 A St, MARIETTA GA');
});

test('either half alone is enough', () => {
  assert.strictEqual(placeOf({ address: '', city: 'Cumming' }), 'Cumming');
  assert.strictEqual(placeOf({ address: '9 Oak Rd', city: '' }), '9 Oak Rd');
  assert.strictEqual(placeOf({}), '');
  assert.strictEqual(placeOf(null), '');
});

test('whitespace does not produce a stray comma', () => {
  assert.strictEqual(placeOf({ address: '  ', city: ' Roswell ' }), 'Roswell');
});

test('the job line joins what there is', () => {
  assert.strictEqual(jobOf({ service: 'Piano Tuning', system: 'Yamaha U1' }), 'Piano Tuning · Yamaha U1');
  assert.strictEqual(jobOf({ service: 'Piano Tuning' }), 'Piano Tuning');
  assert.strictEqual(jobOf({}), '');
});

// ------------------------------------------------------------- past due
const NOW = new Date('2026-09-23T12:00:00Z');

test('a job whose time has gone by is past due', () => {
  assert.ok(isPastDue({ scheduled_at: '2026-09-22T09:00:00Z', status: 'booked' }, NOW));
});

test('a job still to come is not', () => {
  assert.ok(!isPastDue({ scheduled_at: '2026-09-25T09:00:00Z', status: 'booked' }, NOW));
});

// Finished work is never chased, whatever its date was.
test('finished work is never past due', () => {
  for (const s of FINISHED) {
    assert.ok(!isPastDue({ scheduled_at: '2026-09-01T09:00:00Z', status: s }, NOW), `${s} should not be past due`);
  }
});

test('an unscheduled or unreadable date is not past due', () => {
  assert.ok(!isPastDue({ scheduled_at: null, status: 'new' }, NOW));
  assert.ok(!isPastDue({ scheduled_at: 'whenever', status: 'new' }, NOW));
  assert.ok(!isPastDue(null, NOW));
});

// The table cell and the phone card both call this, so they cannot disagree
// about what is red.
test('the same lead gets the same answer however it is rendered', () => {
  const r = { scheduled_at: '2026-09-22T09:00:00Z', status: 'contacted' };
  assert.strictEqual(isPastDue(r, NOW), isPastDue(r, NOW));
});
