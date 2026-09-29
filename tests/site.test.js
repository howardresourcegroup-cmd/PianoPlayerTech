const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The public site used to carry its whole stylesheet inside every page, so a
// colour change meant editing twenty-five files and missing some. These tests
// pin the arrangement that replaced it, and the promises the pages make that
// a redesign could quietly break: where a form posts, which fields it sends,
// and the prices the business actually charges.

const PUBLIC = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort();

// Pages rebuilt on site.css alone. Every other page keeps its inline block
// and takes the new look from the stylesheet that loads after it.
const REBUILT = [
  'index.html',
  'antique-player-piano.html',
  'player-repair.html',
  'player-unit-mail-in-repair.html',
  'tuning.html',
  'disklavier-power-supply-repair.html'
];

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Forms as the outside world sees them: where they post and what they send.
// Ids and classes are free to change; these are not, because Formspree, the
// lead function and the CRM all key on them.
function formsOf(html) {
  const out = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const attr = (name) => {
      const a = new RegExp('\\b' + name + '="([^"]*)"').exec(attrs);
      return a ? a[1] : '';
    };
    const names = new Set();
    const fieldRe = /<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g;
    let f;
    while ((f = fieldRe.exec(body))) names.add(f[1]);
    out.push({
      id: attr('id'),
      action: attr('action'),
      noConversion: /\bdata-no-conversion\b/.test(attrs),
      fields: [...names].sort()
    });
  }
  return out.sort((a, b) => (a.id + a.action).localeCompare(b.id + b.action));
}

test('every public page loads the shared stylesheet, after its own styles', () => {
  for (const file of PUBLIC) {
    const html = read(file);
    const link = html.indexOf('href="/site.css"');
    assert.ok(link !== -1, `${file} does not link /site.css`);
    const lastStyle = html.lastIndexOf('</style>');
    // Order is the whole mechanism: at equal specificity the later rule wins,
    // so the shared sheet has to come last to restyle the inline one.
    assert.ok(link > lastStyle, `${file} links /site.css before its inline <style>`);
  }
});

test('rebuilt pages carry no inline stylesheet and load the shared script', () => {
  for (const file of REBUILT) {
    const html = read(file);
    assert.doesNotMatch(html, /<style[\s>]/, `${file} still has an inline <style>`);
    assert.match(html, /<script src="\/site\.js"/, `${file} does not load /site.js`);
  }
});

test('rebuilt pages post the same forms with the same fields', () => {
  const contract = JSON.parse(read('tests/fixtures/form-contract.json'));
  for (const file of REBUILT) {
    assert.deepStrictEqual(formsOf(read(file)), contract[file], `${file} changed a form`);
  }
});

test('the job application form still opts out of lead conversions', () => {
  const apply = formsOf(read('index.html')).find((f) => f.id === 'apply-form');
  assert.ok(apply, 'index.html lost #apply-form');
  assert.ok(apply.noConversion, '#apply-form must keep data-no-conversion');
});

test('no page claims a certification', () => {
  for (const file of PUBLIC) {
    assert.doesNotMatch(read(file), /certif/i, `${file} mentions a certification`);
  }
});

test('the restoration page states pneumatic pricing, not the electronic fees', () => {
  const html = read('antique-player-piano.html');
  assert.match(html, /\$8,000/, 'restoration range is missing');
  assert.match(html, /\$15,000/, 'restoration range is missing');
  // $100 and $125 are the electronic diagnosis and labour rates. Pneumatic
  // work is quoted, so neither belongs on this page.
  assert.doesNotMatch(html, /\$100\b/, 'the $100 diagnosis is for electronic systems');
  assert.doesNotMatch(html, /\$125\b/, 'the $125 rate is for electronic repair');
});

test('each rebuilt page has one hero with one primary action', () => {
  for (const file of REBUILT) {
    const html = read(file);
    const heroes = html.match(/class="pp-hero[ "]/g) || [];
    assert.strictEqual(heroes.length, 1, `${file} should have exactly one pp-hero`);
    const start = html.indexOf('class="pp-hero');
    const end = html.indexOf('</section>', start);
    const hero = html.slice(start, end);
    const primary = hero.match(/pp-btn--primary/g) || [];
    assert.strictEqual(primary.length, 1, `${file} hero should have exactly one primary action`);
  }
});

