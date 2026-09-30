// The phone layout of the dashboard.
//
// Style rules that once went wrong in a way a screenshot caught and a test
// did not. Each one here is a bug that shipped.

import test from 'node:test';
import assert from 'node:assert';
import { CSS } from '../functions/_lib/css.js';

test('the empty-state style is scoped, so a card\'s "Not scheduled" does not inherit 3rem of padding', () => {
  // A bare `.empty{` matched `.cl-date.empty` on every phone card and left
  // a 117px hole in each one.
  assert.ok(!/(^|[\s}])\.empty\s*\{/m.test(CSS), 'found a bare .empty{ rule');
});

test('form fields are at least 16px on phones, so iOS does not zoom on focus', () => {
  const m = CSS.match(/@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\n\}/g) || [];
  const phone = m.join('\n');
  assert.ok(/input[^{]*,\s*select[^{]*,\s*textarea[^{]*\{[^}]*font-size:\s*16px/.test(phone),
    'expected a phone rule setting input, select and textarea to 16px');
});
