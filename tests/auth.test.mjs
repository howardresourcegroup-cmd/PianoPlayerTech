// These two functions decide who may read customer names, phone numbers and
// addresses. They are tested by behaviour, not by grepping the source.
import test from 'node:test';
import assert from 'node:assert';
import { safeEqual, emailAllowed } from '../functions/_lib/auth.js';

test('safeEqual accepts identical strings', () => {
  assert.strictEqual(safeEqual('hunter2', 'hunter2'), true);
  assert.strictEqual(safeEqual('', ''), true);
});

test('safeEqual rejects differing strings of equal length', () => {
  assert.strictEqual(safeEqual('hunter2', 'hunter3'), false);
});

test('safeEqual rejects differing lengths without throwing', () => {
  assert.strictEqual(safeEqual('short', 'muchlongervalue'), false);
  assert.strictEqual(safeEqual('', 'x'), false);
});

test('safeEqual handles non-string input', () => {
  assert.strictEqual(safeEqual(undefined, ''), false);
  assert.strictEqual(safeEqual(null, 'null'), true); // String(null) === 'null'
});

test('an empty ACCESS_EMAILS list admits nobody', () => {
  // The dashboard fails closed. An unset or blank list must not mean "anyone".
  assert.strictEqual(emailAllowed({}, 'ethan@pianoplayertech.com'), false);
  assert.strictEqual(emailAllowed({ ACCESS_EMAILS: '' }, 'ethan@pianoplayertech.com'), false);
  assert.strictEqual(emailAllowed({ ACCESS_EMAILS: '   ' }, 'ethan@pianoplayertech.com'), false);
});

test('an exact address on the list is admitted', () => {
  const env = { ACCESS_EMAILS: 'ethan@example.com' };
  assert.strictEqual(emailAllowed(env, 'ethan@example.com'), true);
  assert.strictEqual(emailAllowed(env, 'someone@example.com'), false);
});

test('a leading-@ entry admits a whole domain', () => {
  const env = { ACCESS_EMAILS: '@pianoplayertech.com' };
  assert.strictEqual(emailAllowed(env, 'anyone@pianoplayertech.com'), true);
  assert.strictEqual(emailAllowed(env, 'anyone@example.com'), false);
});

test('a domain entry does not match a lookalike suffix', () => {
  // '@playertech.com' must not admit 'x@pianoplayertech.com'.
  const env = { ACCESS_EMAILS: '@playertech.com' };
  assert.strictEqual(emailAllowed(env, 'x@pianoplayertech.com'), false);
});

test('matching ignores case', () => {
  const env = { ACCESS_EMAILS: 'Ethan@Example.COM' };
  assert.strictEqual(emailAllowed(env, 'ETHAN@example.com'), true);
});

test('the list accepts commas, semicolons and whitespace', () => {
  const env = { ACCESS_EMAILS: 'a@x.com, b@x.com; c@x.com\nd@x.com' };
  for (const e of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']) {
    assert.strictEqual(emailAllowed(env, e), true, `${e} should be allowed`);
  }
  assert.strictEqual(emailAllowed(env, 'e@x.com'), false);
});

test('a value that is not an address is rejected', () => {
  const env = { ACCESS_EMAILS: '@x.com, admin' };
  assert.strictEqual(emailAllowed(env, 'admin'), false);
  assert.strictEqual(emailAllowed(env, ''), false);
});
