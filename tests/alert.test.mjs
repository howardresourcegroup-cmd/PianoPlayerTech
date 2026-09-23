// Error alerting.
//
// Two ways this feature turns bad: it floods a mailbox until somebody
// switches it off, or it emails a secret to a less-guarded place. Most of
// these tests are about those two, not about the happy path.

import test from 'node:test';
import assert from 'node:assert';
import { redact, signature, shouldSend, buildEmail, alertError }
  from '../functions/_lib/alert.js';

// A KV stand-in with the bits the module uses.
function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); }
  };
}

// --------------------------------------------------------------- redaction
test('a Stripe key never leaves the worker', () => {
  const out = redact('Stripe rejected sk_live_51ABCdefGHIjklMNOpqrs said no');
  assert.ok(!out.includes('sk_live_51ABCdefGHIjklMNOpqrs'));
  assert.ok(out.includes('[stripe-key]'));
});

test('a bearer token is stripped', () => {
  const out = redact('failed with Authorization: Bearer abcdef0123456789xyz');
  assert.ok(!out.includes('abcdef0123456789xyz'));
  assert.ok(out.includes('Bearer [token]'));
});

test('a long opaque string is treated as a credential', () => {
  const tok = 'A'.repeat(48);
  assert.ok(!redact('token ' + tok).includes(tok));
});

// An alert email is a copy of production going somewhere less guarded.
test('a customer email address is stripped', () => {
  const out = redact('could not invoice dana@example.com');
  assert.ok(!out.includes('dana@example.com'));
  assert.ok(out.includes('[email]'));
});

test('an ordinary message survives readable', () => {
  assert.strictEqual(redact('D1_ERROR: no such column: foo'), 'D1_ERROR: no such column: foo');
});

test('a very long message is clipped rather than sent whole', () => {
  assert.ok(redact('x'.repeat(5000)).length <= 600);
});

test('redaction never throws on odd input', () => {
  for (const v of [null, undefined, 0, {}, []]) assert.strictEqual(typeof redact(v), 'string');
});

// --------------------------------------------------------------- signature
// The flood case: the same fault with a different id each time.
test('ids are flattened so one fault is one signature', () => {
  assert.strictEqual(
    signature('dashboard action', 'lead 41 not found'),
    signature('dashboard action', 'lead 42 not found'));
});

test('different faults stay different', () => {
  assert.notStrictEqual(
    signature('dashboard action', 'no such column: foo'),
    signature('dashboard action', 'no such table: bar'));
});

test('the same message in different places is different', () => {
  assert.notStrictEqual(signature('invoice', 'timeout'), signature('calendar', 'timeout'));
});

test('a signature redacts too, so a key cannot reach KV', () => {
  assert.ok(!signature('x', 'key sk_live_ABCdefGHIjklMNOpqrstu').includes('sk_live_ABCdefGHIjklMNOpqrstu'));
});

// ---------------------------------------------------------- deduplication
test('the first of a kind sends and the rest do not', async () => {
  const env = { RATE_LIMIT: fakeKV() };
  const sig = signature('dashboard action', 'boom');
  const first = await shouldSend(env, sig);
  assert.strictEqual(first.send, true);
  assert.strictEqual(first.seen, 1);
  assert.strictEqual(first.durable, true);

  for (let i = 2; i <= 5; i++) {
    const again = await shouldSend(env, sig);
    assert.strictEqual(again.send, false, `call ${i} should be suppressed`);
    assert.strictEqual(again.seen, i, 'but it is still counted');
  }
});

test('a different fault is not suppressed by the first', async () => {
  const env = { RATE_LIMIT: fakeKV() };
  assert.strictEqual((await shouldSend(env, signature('a', 'one'))).send, true);
  assert.strictEqual((await shouldSend(env, signature('a', 'two'))).send, true);
});

// Without KV there is nowhere durable to remember, but a burst inside one
// isolate must still be absorbed.
test('without KV a burst is still absorbed, and it says so', async () => {
  const env = {};
  const sig = signature('nokv-' + Math.random(), 'boom');
  const first = await shouldSend(env, sig);
  assert.strictEqual(first.send, true);
  assert.strictEqual(first.durable, false);
  const second = await shouldSend(env, sig);
  assert.strictEqual(second.send, false);
  assert.strictEqual(second.seen, 2);
});

// KV failing must not silence the alert -- that is the case you need it most.
test('a KV failure lets the alert through rather than swallowing it', async () => {
  const env = { RATE_LIMIT: { async get() { throw new Error('KV down'); }, async put() {} } };
  const r = await shouldSend(env, signature('x', 'y'));
  assert.strictEqual(r.send, true);
  assert.strictEqual(r.durable, false);
});

// --------------------------------------------------------------- the email
test('the email says what, where and when, and links to the CRM', () => {
  const body = buildEmail('dashboard action', 'no such column: foo',
    { when: '2026-09-23T04:00:00.000Z', action: 'update', seen: 1, durable: true });
  assert.match(body, /Where:\s+dashboard action/);
  assert.match(body, /Error:\s+no such column: foo/);
  assert.match(body, /Action:\s+update/);
  assert.match(body, /2026-09-23T04:00:00\.000Z/);
  assert.match(body, /pianoplayertech\.com\/leads/);
});

test('a repeat says how many times, so one email describes a storm', () => {
  const body = buildEmail('x', 'y', { when: 'now', seen: 240, durable: true });
  assert.match(body, /240 times/);
});

test('a non-durable window is disclosed rather than implied', () => {
  assert.match(buildEmail('x', 'y', { when: 'now', seen: 1, durable: false }), /in memory rather than KV/);
});

// ---------------------------------------------------------------- sending
test('nothing is sent when email is not configured', async () => {
  const env = { RATE_LIMIT: fakeKV() };
  const r = await alertError(env, 'somewhere', new Error('boom'));
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.reason, 'not configured');
});

test('a configured alert posts to Resend with a redacted body', async () => {
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured = { url, init: JSON.parse(init.body) };
    return { ok: true, status: 200 };
  };
  try {
    const env = { RATE_LIMIT: fakeKV(), RESEND_API_KEY: 're_test_key_value',
      LEAD_FROM_EMAIL: 'crm@send.pianoplayertech.com', LEAD_NOTIFY_EMAIL: 'me@example.com' };
    const r = await alertError(env, 'invoice action',
      new Error('Stripe said sk_live_ABCdefGHIjklMNOpqrstu is invalid for dana@example.com'),
      { action: 'invoice' });
    assert.strictEqual(r.sent, true);
    assert.match(captured.url, /api\.resend\.com/);
    assert.strictEqual(captured.init.to, 'me@example.com');
    assert.match(captured.init.subject, /invoice action/);
    assert.ok(!captured.init.text.includes('sk_live_ABCdefGHIjklMNOpqrstu'), 'key leaked into the email');
    assert.ok(!captured.init.text.includes('dana@example.com'), 'customer email leaked');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ALERT_EMAIL wins over the lead notification address', async () => {
  let to = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { to = JSON.parse(init.body).to; return { ok: true, status: 200 }; };
  try {
    await alertError({ RATE_LIMIT: fakeKV(), RESEND_API_KEY: 'k',
      LEAD_FROM_EMAIL: 'f@x.com', LEAD_NOTIFY_EMAIL: 'leads@x.com', ALERT_EMAIL: 'oncall@x.com' },
      'x', new Error('y'));
    assert.strictEqual(to, 'oncall@x.com');
  } finally { globalThis.fetch = realFetch; }
});

// The rule that matters most: monitoring must not be able to break the thing
// it monitors.
test('alerting never throws, whatever goes wrong', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network gone'); };
  try {
    const r = await alertError({ RATE_LIMIT: fakeKV(), RESEND_API_KEY: 'k',
      LEAD_FROM_EMAIL: 'f@x.com', LEAD_NOTIFY_EMAIL: 't@x.com' }, 'x', new Error('y'));
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.reason, 'threw');
  } finally { globalThis.fetch = realFetch; }

  // And with an env that is missing everything.
  assert.doesNotReject(() => alertError({}, 'x', null));
});

test('a rejected email is reported, not retried into a loop', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 422, text: async () => 'bad from address' });
  try {
    const r = await alertError({ RATE_LIMIT: fakeKV(), RESEND_API_KEY: 'k',
      LEAD_FROM_EMAIL: 'f@x.com', LEAD_NOTIFY_EMAIL: 't@x.com' }, 'x', new Error('y'));
    assert.strictEqual(r.sent, false);
    assert.strictEqual(r.reason, 'rejected');
  } finally { globalThis.fetch = realFetch; }
});
