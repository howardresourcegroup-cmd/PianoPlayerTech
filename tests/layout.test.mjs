// When the layout switches between the table and the phone cards.
//
// This exists because the browser could not be made to exercise it: changing
// an emulated viewport fired neither a resize event nor a matchMedia change,
// so the wiring is untestable there. The decision itself is testable, and it
// is the part that can be wrong.

import test from 'node:test';
import assert from 'node:assert';
import { onModeChange, isPhoneWidth, PHONE_MAX } from '../crm/layout.js';

// A stand-in for "something changed", so a test can fire it by hand.
function signal() {
  const listeners = [];
  return {
    subscribe: (fn) => listeners.push(fn),
    fire: () => listeners.forEach((f) => f()),
    count: () => listeners.length
  };
}

test('the breakpoint is a single definition', () => {
  assert.strictEqual(PHONE_MAX, 760);
  assert.ok(isPhoneWidth(375));
  assert.ok(isPhoneWidth(760), 'the breakpoint itself is the phone layout');
  assert.ok(!isPhoneWidth(761));
  assert.ok(!isPhoneWidth(1024));
});

test('a width that is not a number is not the phone layout', () => {
  for (const v of [null, undefined, '375', NaN, {}]) assert.ok(!isPhoneWidth(v));
});

test('nothing happens until the mode actually flips', () => {
  let width = 1024;
  let calls = 0;
  const sig = signal();
  onModeChange(() => isPhoneWidth(width), sig.subscribe, () => calls++);

  // Dragging a desktop window narrower, but still desktop.
  width = 900; sig.fire();
  width = 800; sig.fire();
  assert.strictEqual(calls, 0, 'sixty cards must not be rebuilt for nothing');

  // Crossing the line.
  width = 700; sig.fire();
  assert.strictEqual(calls, 1);

  // And staying there.
  width = 400; sig.fire();
  width = 375; sig.fire();
  assert.strictEqual(calls, 1, 'still one flip');
});

test('flipping back calls again', () => {
  let width = 375;
  const seen = [];
  const sig = signal();
  onModeChange(() => isPhoneWidth(width), sig.subscribe, (now) => seen.push(now));

  width = 1024; sig.fire();
  width = 375; sig.fire();
  width = 1024; sig.fire();
  assert.deepStrictEqual(seen, [false, true, false]);
});

test('the callback is told which mode it is now', () => {
  let width = 1024;
  let told = null;
  const sig = signal();
  onModeChange(() => isPhoneWidth(width), sig.subscribe, (now) => { told = now; });
  width = 300; sig.fire();
  assert.strictEqual(told, true);
});

test('the starting mode is captured, not assumed', () => {
  let width = 375;           // starts as a phone
  let calls = 0;
  const sig = signal();
  onModeChange(() => isPhoneWidth(width), sig.subscribe, () => calls++);
  sig.fire();                // nothing changed
  assert.strictEqual(calls, 0, 'starting on a phone is not a flip');
});

test('every signal offered gets subscribed', () => {
  const sig = signal();
  onModeChange(() => true, sig.subscribe, () => {});
  assert.strictEqual(sig.count(), 1);
});

test('the check can be run by hand and behaves the same', () => {
  let width = 1024;
  let calls = 0;
  const check = onModeChange(() => isPhoneWidth(width), () => {}, () => calls++);
  width = 375;
  check();
  assert.strictEqual(calls, 1);
  check();
  assert.strictEqual(calls, 1, 'running it twice is not two flips');
});
