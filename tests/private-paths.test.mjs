// Pages deploys the whole repo root, so everything committed is servable.
// Until 2026-10-03 that included the outreach drafts, the CRM design docs and
// the database schema. The root middleware is what keeps those off the web;
// these tests run it the way Pages does, with a Request and a next().
import test from 'node:test';
import assert from 'node:assert';
import { onRequest } from '../functions/_middleware.js';

const { Request } = globalThis;

async function get(path, host = 'pianoplayertech.com') {
  const request = new Request(`https://${host}${path}`);
  const next = async () => new Response('static asset', { status: 200 });
  return onRequest({ request, next });
}

const HIDDEN = [
  '/docs/marketing/outreach-drafts.md',
  '/docs/superpowers/specs/2026-09-29-automated-emails-design.md',
  '/docs',
  '/docs/',
  '/tests/auth.test.mjs',
  '/tests/fixtures/schema-before-2026-09-30.sql',
  '/db/schema.sql',
  '/db/',
  '/tools/harness.js',
  '/.github/workflows/site-check.yml',
  '/.claude/settings.json',
  '/.gitignore',
  '/package.json',
  '/package-lock.json',
  '/eslint.config.mjs',
  '/node_modules/eslint/package.json',
];

for (const path of HIDDEN) {
  test(`${path} is not served`, async () => {
    const res = await get(path);
    assert.strictEqual(res.status, 404);
    assert.doesNotMatch(await res.text(), /static asset/);
  });
}

// Verified live: the asset server decodes %64 to "d" and collapses "//", so a
// check on the raw path alone would wave these through.
const DISGUISED = [
  '/%64ocs/marketing/outreach-drafts.md',
  '/%2e%67ithub/workflows/site-check.yml',
  '//docs/marketing/outreach-drafts.md',
  '/./docs/marketing/outreach-drafts.md',
  '/DOCS/marketing/outreach-drafts.md',
  '/docs%2fmarketing/outreach-drafts.md',
];

for (const path of DISGUISED) {
  test(`${path} is not served either`, async () => {
    assert.strictEqual((await get(path)).status, 404);
  });
}

const PUBLIC = [
  '/',
  '/player-repair',
  '/for-technicians',
  '/leads',
  '/crm/app.js',
  '/site.js',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest',
  '/.well-known/security.txt',
  '/api/lead',
  // Names that merely start like a hidden one.
  '/docsify',
  '/tools-for-technicians',
];

for (const path of PUBLIC) {
  test(`${path} still reaches the site`, async () => {
    const res = await get(path);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'static asset');
  });
}

test('www still redirects to the bare domain', async () => {
  const res = await get('/player-repair?x=1', 'www.pianoplayertech.com');
  assert.strictEqual(res.status, 301);
  assert.strictEqual(res.headers.get('location'), 'https://pianoplayertech.com/player-repair?x=1');
});
