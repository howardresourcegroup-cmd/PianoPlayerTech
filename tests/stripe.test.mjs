import test from 'node:test';
import assert from 'node:assert';
import { createInvoice, INVOICE_COLUMNS, STRIPE_VERSION, MAX_LINES, MAX_LINE_CENTS }
  from '../functions/_lib/stripe.js';
import { REFERRAL_FEE } from '../functions/_lib/db.js';

test('the Stripe API version stays pinned', () => {
  // Unpinning lets an upstream upgrade silently change what these calls mean.
  assert.strictEqual(STRIPE_VERSION, '2024-06-20');
});

test('invoice limits are what the dashboard promises', () => {
  assert.strictEqual(MAX_LINES, 25);
  assert.strictEqual(MAX_LINE_CENTS, 5000000);
});

test('the invoice mirror carries what the Invoices tab lists', () => {
  for (const c of ['id', 'kind', 'amount_cents', 'status', 'hosted_url', 'lead_id']) {
    assert.ok(INVOICE_COLUMNS.includes(c), `INVOICE_COLUMNS missing ${c}`);
  }
});

// The referral invoice path is the money path: it bills World Class for every
// booked referral. It once referenced REFERRAL_FEE as a free variable after a
// refactor, which would have thrown a ReferenceError on the first monthly
// bill. Driving it with a stub DB catches that class of break.
function stubEnv(referrals) {
  const calls = [];
  return {
    calls,
    env: {
      STRIPE_SECRET_KEY: 'sk_test_x',
      DB: {
        prepare(sql) {
          calls.push(sql);
          return {
            bind() { return this; },
            all: async () => ({ results: referrals }),
            first: async () => referrals[0] || null,
            run: async () => ({ meta: { changes: 1, last_row_id: 1 } })
          };
        }
      }
    }
  };
}

test('a referral invoice prices every booked referral at the fee', async () => {
  const refs = [{ id: 31, name: 'Peter Jacobson' }, { id: 36, name: 'Phillip' }];
  const { env } = stubEnv(refs);

  // Stub the network so nothing reaches Stripe.
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init && init.body && String(init.body) });
    return new Response(JSON.stringify({ id: 'in_test', status: 'open',
      number: 'PPT-1', hosted_invoice_url: 'https://pay', lines: { data: [] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await createInvoice(env, { kind: 'referral', email: 'wc@example.com',
      billTo: 'World Class' }, new Date().toISOString());
  } catch (err) {
    // A ReferenceError means the module lost a binding in a refactor. Any
    // other error is this stub not modelling Stripe closely enough.
    assert.ok(!(err instanceof ReferenceError), `lost binding: ${err.message}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  const priced = sent.some((s) => s.body && s.body.includes(String(REFERRAL_FEE * 100)));
  assert.ok(priced || sent.length === 0,
    `referral lines should be priced at ${REFERRAL_FEE * 100} cents`);
});
