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
  'disklavier-power-supply-repair.html',
  'careers.html',
  'piano-detailing.html',
  'piano-voicing-regulation.html',
  'player-system-install.html'
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
  // It moved from the home page to /careers.html; the home page keeps a teaser.
  const apply = formsOf(read('careers.html')).find((f) => f.id === 'apply-form');
  assert.ok(apply, 'careers.html lost #apply-form');
  assert.ok(apply.noConversion, '#apply-form must keep data-no-conversion');
  assert.strictEqual(apply.action, 'https://formspree.io/f/xeebglab', 'the application still posts to Formspree');
  assert.ok(apply.fields.includes('role'), 'the application asks which role');
  assert.ok(apply.fields.includes('experience'), 'the application keeps the experience question');
  assert.ok(!formsOf(read('index.html')).some((f) => f.id === 'apply-form'), 'the application is no longer on the home page');
  assert.match(read('index.html'), /href="\/careers\.html"/, 'the home page links to the careers page');
});

test('every service page carries the hiring line, linking to the careers page', () => {
  const services = ['antique-player-piano.html', 'player-repair.html', 'player-unit-mail-in-repair.html', 'tuning.html',
    'disklavier-power-supply-repair.html', 'disklavier-repair.html', 'pianodisc-repair.html', 'qrs-repair.html',
    'spirio-repair.html', 'piano-repair.html', 'piano-cleaning.html', 'for-technicians.html',
    'piano-tuning-atlanta.html', 'piano-tuning-cumming-ga.html', 'piano-tuning-gainesville-ga.html',
    'piano-tuning-marietta-ga.html', 'piano-detailing.html', 'piano-voicing-regulation.html', 'player-system-install.html'];
  for (const file of services) {
    assert.match(read(file), /<aside class="pp-hiring"[^>]*>\s*<a href="\/careers\.html">We&rsquo;re hiring tuners, a player-system apprentice and a lead responder\. <span>See open roles/,
      `${file} has no hiring line`);
  }
});

test('every page with a nav links to the careers page', () => {
  const untouched = new Set(['review.html', 'privacy-policy.html', 'terms-of-service.html', 'checkout-return.html', 'thank-you.html']);
  for (const file of PUBLIC.filter((f) => !untouched.has(f))) {
    const html = read(file);
    const nav = (html.match(/<nav[\s\S]*?<\/nav>/) || [''])[0];
    assert.match(nav, /href="\/careers\.html"/, `${file} nav has no Careers link`);
    assert.match(html, /href="\/piano-detailing\.html"[\s\S]*href="\/player-system-install\.html"|href="\/player-system-install\.html"[\s\S]*href="\/piano-detailing\.html"/,
      `${file} footer is missing the new service pages`);
  }
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

