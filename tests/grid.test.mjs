import test from 'node:test';
import assert from 'node:assert';
import { dashboard, VIEWS, STATUSES, SET_STATUSES, REFERRAL_STATUSES, REFERRAL_FEE }
  from '../functions/_lib/grid.js';

function lead(over = {}) {
  return {
    id: 1, created_at: '2026-09-20T14:02:00Z', updated_at: null, pipeline: 'tuning',
    status: 'new', name: 'Dana', phone: '770-555-0142', email: 'd@x.com',
    address: '1 A St', city: 'Marietta', system: 'U1', service: 'Tuning',
    message: 'hi', notes: null, source: '/t', referred_at: null,
    referral_status: null, referral_paid_at: null, referral_invoice_id: null,
    fields: '{}', ...over
  };
}

const EXTRA = { stripeReady: true, invoices: [], lastWcEmail: '', wcReady: true, who: 'e@x.com' };
const REF = { sent: 1, booked: 0, lost: 0, paid: 0 };

function render(rows, view = 'tuning', counts = { repair: 2, tuning: 1 }) {
  return dashboard(view, rows, counts, REF, EXTRA, 'NONCE123');
}

test('the dashboard renders a complete document', () => {
  const html = render([lead()]);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('id="data"'));
});

test('every view has a tab', () => {
  const html = render([lead()]);
  for (const label of Object.values(VIEWS)) {
    assert.ok(html.includes(label), `missing tab for ${label}`);
  }
});

test('the new-lead count shows as a pill', () => {
  assert.ok(render([lead()]).includes('<span class="pill">1</span>'));
});

test('the client loads as a module asset, not an inline script', () => {
  const html = render([lead()]);
  assert.ok(html.includes('<script type="module" src="/crm/app.js"></script>'),
    'the dashboard should load the client from /crm/');
  // The only other script tag is the JSON data island, which carries no code.
  const tags = html.match(/<script[^>]*>/g) || [];
  assert.strictEqual(tags.length, 2, `expected two script tags, saw ${tags.join(' ')}`);
  assert.ok(tags.some((t) => t.includes('application/json')));
  assert.ok(!html.includes('<script nonce='),
    'the dashboard no longer inlines a script');
});

// The payload is JSON inside a <script> tag. A customer who types "<" must not
// be able to close that tag.
test('a customer cannot close the script tag', () => {
  const html = render([lead({ name: 'Dana <script>alert(1)</script>' })]);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag reached the page');
  assert.ok(html.includes('\\u003cscript'), 'the < should be escaped as \\u003c');
});

test('referred is storable but not selectable', () => {
  // Set by the refer flow, which also stamps referred_at. Choosing it by hand
  // used to set the status alone, losing the referral.
  assert.ok(STATUSES.includes('referred'));
  assert.ok(!SET_STATUSES.includes('referred'));
});

test('the client receives the referral fee and outcome options', () => {
  const html = render([lead()]);
  assert.ok(html.includes(`"fee":${REFERRAL_FEE}`));
  for (const s of REFERRAL_STATUSES) assert.ok(html.includes(s), `missing ${s}`);
});

test('a pipeline with no new leads shows no pill', () => {
  const html = render([lead()], 'tuning', { repair: 0, tuning: 0 });
  assert.ok(!html.includes('class="pill"'));
});
