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

test('the sheet body has an auto flex basis, because Safari collapses flex:1 inside an auto-height column', () => {
  // On an iPhone the lead dialog opened as a header with nothing usable
  // under it: the body had flex:1 (basis 0%) in a column flex box whose
  // height is automatic, which Safari resolves to zero height.
  assert.ok(!/\.dlg\{flex:1;/.test(CSS), 'found .dlg{flex:1; which Safari collapses');
  assert.ok(/\.dlg\{flex:1 1 auto;/.test(CSS), 'expected .dlg{flex:1 1 auto;');
});

test('the phone sheet has a 100vh fallback before the 100dvh height, for older iOS', () => {
  const i = CSS.indexOf('max-height:calc(100vh - 28px)');
  const j = CSS.indexOf('max-height:calc(100dvh - 28px)');
  assert.ok(i >= 0 && j > i, 'expected a 100vh max-height declared before the 100dvh one');
});
