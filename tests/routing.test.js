const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// functions/leads.js was built around the belief that Pages routes every file
// under functions/, so shared code had to stay in one file. That is false for
// underscore-prefixed paths: `wrangler pages functions build` bundles
// functions/_lib/*.js as modules and emits no route for them. This pins that,
// so a platform change fails loudly rather than quietly publishing a module.
test('shared modules live under an underscore-prefixed directory', () => {
  const dir = path.join(ROOT, 'functions/_lib');
  assert.ok(fs.existsSync(dir), 'functions/_lib must exist');
  assert.ok(
    path.basename(dir).startsWith('_'),
    'shared modules must be underscore-prefixed or Pages will route them'
  );
});

test('the stylesheet lives in its own module, not in leads.js', () => {
  const leads = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');
  assert.doesNotMatch(leads, /^const CSS = `/m, 'CSS should live in _lib/css.js');
  // Only the page shell needs the stylesheet, so only html.js imports it.
  const html = fs.readFileSync(path.join(ROOT, 'functions/_lib/html.js'), 'utf8');
  assert.match(html, /from\s*'\.\/css\.js'/);
});

test('leads.js imports its HTML helpers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');
  assert.match(src, /from\s*'\.\/_lib\/html\.js'/);
  assert.doesNotMatch(src, /^function page\(/m, 'page() should live in _lib/html.js');
});

test('the escaping rules did not drift during the move', () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions/_lib/html.js'), 'utf8');
  // Security-relevant: every one of these must still be escaped.
  for (const ch of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) {
    assert.ok(src.includes(ch), `escape_ no longer produces ${ch}`);
  }
});
