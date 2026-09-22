// ESM, because the modules under test are ESM (Pages Functions).
import test from 'node:test';
import assert from 'node:assert';
import { escape_, page, privateHeaders, newNonce, json }
  from '../functions/_lib/html.js';

test('escape_ escapes every character that can break out of markup', () => {
  assert.strictEqual(
    escape_(`<a href="x" title='y'>&</a>`),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
  );
});

test('escape_ renders null and undefined as empty, not as text', () => {
  assert.strictEqual(escape_(null), '');
  assert.strictEqual(escape_(undefined), '');
});

test('page builds a complete, non-indexable document', () => {
  const nonce = newNonce();
  const html = page('Leads', '<div>hi</div>', 'var x=1;', nonce);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>Leads · PianoPlayerTech</title>'));
  assert.ok(html.includes('name="robots" content="noindex,nofollow"'));
  assert.ok(html.includes('width=device-width'));
  assert.ok(html.includes('--gold:'), 'the stylesheet should be inlined');
});

test('page escapes the title', () => {
  const html = page('<script>x</script>', '', null, newNonce());
  assert.ok(!html.includes('<title><script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('page omits the script tag when there is no script', () => {
  assert.ok(!page('t', '', null, newNonce()).includes('<script nonce'));
});

test('the inline script is bound to the nonce', () => {
  const nonce = newNonce();
  const html = page('t', '', 'var x=1;', nonce);
  assert.ok(html.includes(`<script nonce="${nonce}">var x=1;</script>`));
});

test('a nonce is 32 hex characters', () => {
  assert.match(newNonce(), /^[0-9a-f]{32}$/);
});

test('private headers keep the dashboard out of caches and indexes', () => {
  const h = privateHeaders('abc');
  assert.strictEqual(h['Cache-Control'], 'no-store, private');
  assert.match(h['X-Robots-Tag'], /noindex/);
  assert.strictEqual(h['X-Content-Type-Options'], 'nosniff');
  assert.ok(h['Content-Security-Policy'].includes("'nonce-abc'"));
  assert.ok(h['Content-Security-Policy'].includes("frame-ancestors 'none'"));
});

test('private headers allow a content type override for CSV export', () => {
  assert.strictEqual(privateHeaders('abc', 'text/csv')['Content-Type'], 'text/csv');
});

test('json carries its status and is never cached', () => {
  const r = json({ a: 1 }, 418);
  assert.strictEqual(r.status, 418);
  assert.strictEqual(r.headers.get('Cache-Control'), 'no-store');
});
