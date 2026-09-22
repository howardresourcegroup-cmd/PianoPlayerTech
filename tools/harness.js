// Writes a standalone page that mounts the real dashboard CSS and client
// script against fixture leads, so the grid can be driven in a browser
// without Cloudflare, D1 or auth. Also used by CI to syntax-check the script.
//
//   node tools/harness.js            -> writes .harness/harness.html
//   node tools/harness.js --check    -> syntax-checks the script only

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractBlock } = require('./extract.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.harness');

// Each block may live in leads.js or, after the split, in _lib/. Look wherever
// it is rather than hard-coding a path that the refactor will move.
function findBlock(name, files) {
  for (const rel of files) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf8');
    try { return extractBlock(src, name); } catch { /* try the next file */ }
  }
  throw new Error(`harness: could not find ${name} in ${files.join(', ')}`);
}

const css = findBlock('CSS', ['functions/_lib/css.js', 'functions/leads.js']);
const js = findBlock('GRID_JS', ['functions/_lib/grid.js', 'functions/leads.js']);

fs.mkdirSync(OUT, { recursive: true });
const jsPath = path.join(OUT, 'grid.js');
fs.writeFileSync(jsPath, js);

// This is the check CI could not do before: a syntax error inside GRID_JS
// used to ship silently, because to Node the script is just a string.
// Verified by deliberately breaking the script and watching this fail while
// `node --check functions/leads.js` still reported the file as fine.
try {
  execFileSync(process.execPath, ['--check', jsPath], { stdio: 'inherit' });
} catch {
  // execFileSync would otherwise bury the SyntaxError under its own stack.
  console.error(`\nGRID_JS does not parse. The error above is at a line in ${
    path.relative(ROOT, jsPath)}; find it in the GRID_JS template literal.`);
  process.exit(1);
}
console.log('GRID_JS parses');

if (process.argv.includes('--check')) process.exit(0);

const rows = [
  { id: 101, created_at: '2026-09-20T14:02:00Z', updated_at: null, pipeline: 'tuning',
    status: 'new', name: 'Dana Whitfield', phone: '(770) 555-0142',
    email: 'dana@example.com', address: '88 Peachtree Ln, Marietta, GA 30060',
    city: 'Marietta', system: 'Yamaha U1 upright', service: 'Piano Tuning',
    message: 'Not tuned in four years.', notes: null, source: '/tuning#form',
    referred_at: null, referral_status: null, referral_paid_at: null,
    referral_invoice_id: null, archived_at: null,
    fields: '{"preferred_dates":"weekday mornings"}' },
  { id: 102, created_at: '2026-09-18T11:15:00Z', updated_at: '2026-09-18T12:00:00Z',
    pipeline: 'tuning', status: 'referred', name: 'Priya Raman',
    phone: '(404) 555-0110', email: 'priya@example.com', address: '5 Elm St, Atlanta, GA',
    city: 'Atlanta', system: 'Steinway M', service: 'Piano Tuning', message: '',
    notes: 'Emailed to World Class', source: '/piano-tuning-atlanta#form',
    referred_at: '2026-09-18T12:00:00Z', referral_status: 'sent',
    referral_paid_at: null, referral_invoice_id: null, archived_at: null, fields: '{}' },
  { id: 103, created_at: '2026-09-21T09:00:00Z', updated_at: null, pipeline: 'repair',
    status: 'new', name: 'Glenn Portier', phone: '(770) 555-0188',
    email: 'g@example.com', address: '9 Oak Rd, Atlanta, GA', city: 'Atlanta',
    system: 'Disklavier DKC-850', service: 'Power Supply Rebuild',
    message: 'Player system dead.', notes: null, source: '/player-repair#form',
    referred_at: null, referral_status: null, referral_paid_at: null,
    referral_invoice_id: null, archived_at: null, fields: '{}' }
];

const data = JSON.stringify({
  view: 'all', rows,
  statuses: ['new', 'called', 'referred', 'booked', 'closed'],
  setStatuses: ['new', 'called', 'booked', 'closed'],
  refStatuses: ['sent', 'booked', 'no_booking'], fee: 25,
  ref: { sent: 1, booked: 0, lost: 0, paid: 0 },
  stripeReady: true, invoices: [], lastWcEmail: '', wcReady: true,
  purgeDays: 30, who: 'harness@example.com'
}).replace(/</g, '\\u003c');

fs.writeFileSync(path.join(OUT, 'harness.html'), `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Harness</title><style>${css}</style></head><body>
<div class="wrap">
<div class="top"><h1>Leads</h1></div>
<nav class="tabs"></nav>
<div class="stats" id="stats"></div>
<div class="banner" id="banner" hidden></div>
<div class="tools" id="tools">
  <input type="search" id="q" aria-label="Search">
  <select id="sf" aria-label="Filter"></select>
  <span class="muted" id="shown"></span>
</div>
<div class="gridwrap"><table><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table>
  <div class="empty" id="empty" hidden>Nothing here yet.</div></div>
<dialog id="dlg"><div class="dlg" id="dlgbody"></div></dialog>
</div>
<script type="application/json" id="data">${data}</script>
<script>${js}</script></body></html>`);

console.log('wrote .harness/harness.html');
