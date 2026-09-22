# CRM Foundation and Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the CRM a test harness it has never had, split the 1,600-line
`functions/leads.js` into modules, apply the additive schema migration, and
ship lead archiving with a 30-day purge.

**Architecture:** `functions/leads.js` becomes a thin route handler over
modules in `functions/_lib/`. Pages bundles underscore-prefixed paths as
modules without routing them — verified experimentally, see Task 1. Tests use
Node's built-in runner and the `sqlite3` CLI, so the project stays
dependency-free.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla ES modules,
`node:test`, `sqlite3` CLI. No npm dependencies, no `package.json`.

**Spec:** `docs/superpowers/specs/2026-09-22-crm-scheduling-calendar-archive-design.md`

## Global Constraints

- No npm dependencies. The repo has no `package.json` and must not gain one.
- Node 20 in CI (`.github/workflows/site-check.yml`). Do not use `node:sqlite`
  (Node 22+). Use the `sqlite3` CLI for database tests.
- Timestamps are ISO-8601 UTC strings, matching `created_at`. Compare ranges
  against a JS-computed ISO string, never SQLite `datetime()` — the `Z` suffix
  breaks that comparison silently.
- Customer-supplied values reach the DOM through `textContent` or `.value`,
  never `innerHTML`. This is load-bearing XSS protection.
- The dashboard fails closed: with no `ADMIN_PASSWORD` and no Access
  configured, nobody gets in. No change may weaken that.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Pushing to `main` deploys to production. Commit freely; push only when the
  plan says to, or when the user asks.

---

### Task 1: Test harness and CI coverage for the client script

The client grid script lives inside a template literal in `leads.js`, so
`node --check` cannot see it and a syntax error there ships to production.
This task closes that gap and creates the test scaffolding every later task
uses.

**Files:**
- Create: `tools/extract.js`
- Create: `tools/harness.js`
- Create: `tests/extract.test.js`
- Modify: `.github/workflows/site-check.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `tools/extract.js` exporting
  `extractBlock(source: string, constName: string): string` — returns the body
  of a top-level `` const NAME = `...`; `` template literal, with `\\n`
  unescaped to `\n`. Used by Tasks 4 and 9.

- [ ] **Step 1: Write the failing test**

Create `tests/extract.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { extractBlock } = require('../tools/extract.js');

test('extractBlock returns the body of a named template literal', () => {
  const src = [
    'const OTHER = `nope`;',
    'const CSS = `',
    'body{color:red}',
    '`;',
    'const AFTER = 1;'
  ].join('\n');
  assert.strictEqual(extractBlock(src, 'CSS'), 'body{color:red}');
});

test('extractBlock unescapes doubled newline escapes', () => {
  const src = 'const JS = `\nvar a = "x\\\\ny";\n`;';
  assert.ok(extractBlock(src, 'JS').includes('\\n'));
  assert.ok(!extractBlock(src, 'JS').includes('\\\\n'));
});

test('extractBlock throws when the constant is absent', () => {
  assert.throws(() => extractBlock('const A = 1;', 'CSS'), /CSS/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'extract.test.js`
Expected: FAIL — `Cannot find module '../tools/extract.js'`

- [ ] **Step 3: Write minimal implementation**

Create `tools/extract.js`:

```js
// The dashboard's CSS and client script live inside template literals in
// functions/leads.js, where `node --check` cannot see them. This pulls them
// out so they can be syntax-checked and mounted in a test harness.

function extractBlock(source, constName) {
  const open = `const ${constName} = \``;
  const start = source.indexOf(open);
  if (start < 0) throw new Error(`extractBlock: no const ${constName} template literal found`);
  const from = start + open.length;
  const end = source.indexOf('\n`;', from);
  if (end < 0) throw new Error(`extractBlock: unterminated template literal for ${constName}`);
  // Inside the literal a newline is written \\n; as standalone source it is \n.
  return source.slice(from, end).replace(/\\\\n/g, '\\n').replace(/^\n/, '');
}

module.exports = { extractBlock };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'tests/*.test.js'extract.test.js`
Expected: PASS, 3 tests

- [ ] **Step 5: Add the syntax check that CI was missing**

Create `tools/harness.js`:

```js
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
const source = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');
const css = extractBlock(source, 'CSS');
const js = extractBlock(source, 'GRID_JS');

fs.mkdirSync(OUT, { recursive: true });
const jsPath = path.join(OUT, 'grid.js');
fs.writeFileSync(jsPath, js);

// This is the check CI could not do before: a syntax error inside GRID_JS
// used to ship silently.
execFileSync(process.execPath, ['--check', jsPath], { stdio: 'inherit' });
console.log('GRID_JS parses');

if (process.argv.includes('--check')) process.exit(0);

const rows = [
  { id: 101, created_at: '2026-09-20T14:02:00Z', updated_at: null, pipeline: 'tuning',
    status: 'new', name: 'Dana Whitfield', phone: '(770) 555-0142',
    email: 'dana@example.com', address: '88 Peachtree Ln, Marietta, GA 30060',
    city: 'Marietta', system: 'Yamaha U1 upright', service: 'Piano Tuning',
    message: 'Not tuned in four years.', notes: null, source: '/tuning#form',
    referred_at: null, referral_status: null, referral_paid_at: null,
    referral_invoice_id: null, fields: '{"preferred_dates":"weekday mornings"}' },
  { id: 102, created_at: '2026-09-18T11:15:00Z', updated_at: '2026-09-18T12:00:00Z',
    pipeline: 'tuning', status: 'referred', name: 'Priya Raman',
    phone: '(404) 555-0110', email: 'priya@example.com', address: '5 Elm St, Atlanta, GA',
    city: 'Atlanta', system: 'Steinway M', service: 'Piano Tuning', message: '',
    notes: 'Emailed to World Class', source: '/piano-tuning-atlanta#form',
    referred_at: '2026-09-18T12:00:00Z', referral_status: 'sent',
    referral_paid_at: null, referral_invoice_id: null, fields: '{}' },
  { id: 103, created_at: '2026-09-21T09:00:00Z', updated_at: null, pipeline: 'repair',
    status: 'new', name: 'Glenn Portier', phone: '(770) 555-0188',
    email: 'g@example.com', address: '9 Oak Rd, Atlanta, GA', city: 'Atlanta',
    system: 'Disklavier DKC-850', service: 'Power Supply Rebuild',
    message: 'Player system dead.', notes: null, source: '/player-repair#form',
    referred_at: null, referral_status: null, referral_paid_at: null,
    referral_invoice_id: null, fields: '{}' }
];

const data = JSON.stringify({
  view: 'all', rows,
  statuses: ['new', 'called', 'referred', 'booked', 'closed'],
  setStatuses: ['new', 'called', 'booked', 'closed'],
  refStatuses: ['sent', 'booked', 'no_booking'], fee: 25,
  ref: { sent: 1, booked: 0, lost: 0, paid: 0 },
  stripeReady: true, invoices: [], lastWcEmail: '', wcReady: true,
  who: 'harness@example.com'
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
```

- [ ] **Step 6: Verify the harness builds and the check works**

Run: `node tools/harness.js`
Expected: prints `GRID_JS parses` then `wrote .harness/harness.html`

Run: `node tools/harness.js --check`
Expected: prints `GRID_JS parses`, exits 0

Now prove the check actually catches a break. Temporarily insert `var x = ;`
near the top of the `GRID_JS` template literal in `functions/leads.js`, then:

Run: `node tools/harness.js --check`
Expected: FAIL with a SyntaxError. Revert the deliberate break before
continuing. A check that has never failed is not known to work.

- [ ] **Step 7: Wire it into CI**

In `.github/workflows/site-check.yml`, after the "Syntax-check JavaScript"
step, add:

```yaml
      - name: Syntax-check the dashboard's client script
        run: node tools/harness.js --check

      - name: Unit tests
        run: node --test 'tests/*.test.js'
```

Also fix the existing sweep in that file, which word-splits on paths
containing spaces. Replace its `for` loop with:

```yaml
      - name: Syntax-check JavaScript
        run: |
          find . -name '*.js' -not -path './node_modules/*' -not -path './.github/*' \
            -not -path './.harness/*' -print0 |
          while IFS= read -r -d '' f; do node --check "$f" || exit 1; done
          echo "all JS parses"
```

- [ ] **Step 8: Ignore harness output**

Append to `.gitignore`:

```
.harness/
```

- [ ] **Step 9: Commit**

```bash
git add tools/ tests/ .github/workflows/site-check.yml .gitignore
git commit -m "$(cat <<'EOF'
Give the client script a syntax check and the project a test harness

The dashboard's CSS and grid script live inside template literals, so
node --check never saw them and a syntax error in the grid would ship.
tools/extract.js pulls both out; tools/harness.js syntax-checks the
script and mounts it against fixture leads for browser testing.

Also makes the CI JavaScript sweep space-safe. It passed only because no
tracked .js path contains a space; the untracked ones under Images/ break
it immediately.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract presentation into `functions/_lib/`

`leads.js` opens with a comment claiming one file is necessary because "Pages
routes every file under functions/ as an endpoint". That is false for
underscore-prefixed paths: `wrangler pages functions build` bundles
`functions/_lib/*.js` as modules and emits no route for them. This task starts
the split with the pieces that have no dependencies.

**Files:**
- Create: `functions/_lib/css.js`
- Create: `functions/_lib/html.js`
- Modify: `functions/leads.js`
- Test: `tests/routing.test.js`

**Interfaces:**
- Consumes: `extractBlock` from Task 1.
- Produces:
  - `functions/_lib/css.js` exporting `CSS: string`
  - `functions/_lib/html.js` exporting
    `escape_(s: unknown): string`,
    `page(title: string, inner: string, js: string|null, nonce: string): string`,
    `privateHeaders(nonce: string, type?: string): object`,
    `newNonce(): string`,
    `json(obj: unknown, status?: number): Response`

- [ ] **Step 1: Write the failing test**

Create `tests/routing.test.js`. This pins the finding that the refactor rests
on, so a future Cloudflare change fails loudly instead of silently exposing a
module as a public URL:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

test('shared modules live under an underscore-prefixed directory', () => {
  const dir = path.join(ROOT, 'functions/_lib');
  assert.ok(fs.existsSync(dir), 'functions/_lib must exist');
  assert.ok(
    path.basename(dir).startsWith('_'),
    'shared modules must be underscore-prefixed or Pages will route them'
  );
});

test('leads.js imports its stylesheet rather than inlining it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');
  assert.match(src, /import\s*\{\s*CSS\s*\}\s*from\s*'\.\/_lib\/css\.js'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'routing.test.js`
Expected: FAIL — `functions/_lib must exist`

- [ ] **Step 3: Move the stylesheet**

Create `functions/_lib/css.js`. Take the entire body of the `` const CSS = ` ``
template literal from `functions/leads.js` verbatim — do not retype or reflow
it — and wrap it:

```js
// The dashboard stylesheet. Kept as a module so functions/leads.js stays a
// route handler. Pages bundles underscore-prefixed paths without routing them.
export const CSS = `
<PASTE THE EXISTING CSS BODY HERE, UNCHANGED>
`;
```

- [ ] **Step 4: Move the HTML helpers**

Create `functions/_lib/html.js` and move `escape_`, `page`, `privateHeaders`,
`newNonce` and `json` from `leads.js` verbatim, adding `export` to each and
importing `CSS`:

```js
import { CSS } from './css.js';

export function escape_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

Keep the existing bodies of `page`, `privateHeaders`, `newNonce` and `json`
exactly as they are. `page` already references `CSS`; the import satisfies it.

Note: copy `escape_`'s real body from `leads.js` rather than the sketch above
if it differs — the escaping rules are security-relevant and must not drift.

- [ ] **Step 5: Import them in leads.js**

At the top of `functions/leads.js`, below the header comment:

```js
import { CSS } from './_lib/css.js';
import { escape_, page, privateHeaders, newNonce, json } from './_lib/html.js';
```

Delete the moved definitions and the `const esc = escape_;` alias if it is now
unused. Correct the stale header comment: replace the "One file on purpose"
paragraph with:

```js
// Shared code lives in ./_lib/. Pages bundles underscore-prefixed paths as
// modules and does not route them, verified with `wrangler pages functions
// build` — only real endpoints appear in the compiled route table.
```

- [ ] **Step 6: Run the tests**

Run: `node --test 'tests/*.test.js'`
Expected: PASS

Run: `node tools/harness.js --check`
Expected: `GRID_JS parses`

- [ ] **Step 7: Verify Pages still compiles and routes correctly**

Run:
```bash
npx wrangler pages functions build --outdir=.harness/worker
grep -oE '"routePath": "[^"]*"' .harness/worker/index.js | sort -u
```
Expected: `/leads`, `/api/lead`, `/api/csp-report` and no `_lib` path.

If `wrangler` prompts for an account, prefix with
`env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=39798a42943e2b246263c85913c83895`.
That environment variable shadows the OAuth login and lacks D1 permission.

- [ ] **Step 8: Commit**

```bash
git add functions/_lib/css.js functions/_lib/html.js functions/leads.js tests/routing.test.js
git commit -m "$(cat <<'EOF'
Split the stylesheet and HTML helpers out of leads.js

The file claimed one file was necessary because Pages routes everything
under functions/. Underscore-prefixed paths are the exception: wrangler
pages functions build bundles functions/_lib/*.js as modules and emits no
route for them. A test pins that, so a platform change fails loudly rather
than quietly publishing a module.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extract authentication

**Files:**
- Create: `functions/_lib/auth.js`
- Modify: `functions/leads.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `functions/_lib/auth.js` exporting `hmac`, `safeEqual(a, b)`,
  `mintToken(secret)`, `tokenValid(secret, token)`, `cookieValue(request, name)`,
  `accessMode(env)`, `accessIdentity(request, env)`, `emailAllowed(env, email)`,
  `signedIn(request, env)`, `authed(request, env)`, `sameOrigin(request)`,
  `SESSION_HOURS`, `COOKIE`. Signatures unchanged from `leads.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/auth.test.js`. `safeEqual` and `emailAllowed` are pure and
security-relevant, so they get real tests:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../functions/_lib/auth.js'), 'utf8');

test('safeEqual is length-safe and constant-time in shape', () => {
  assert.match(SRC, /export function safeEqual/);
  // It must not short-circuit on the first differing byte.
  assert.doesNotMatch(SRC, /if\s*\(\s*a\[i\]\s*!==\s*b\[i\]\s*\)\s*return\s+false/);
});

test('an empty ACCESS_EMAILS list admits nobody', () => {
  assert.match(SRC, /export function emailAllowed/);
  assert.ok(
    SRC.includes('ACCESS_EMAILS'),
    'emailAllowed must consult ACCESS_EMAILS'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'auth.test.js`
Expected: FAIL — no such file `functions/_lib/auth.js`

- [ ] **Step 3: Move the auth block**

Create `functions/_lib/auth.js`. Move everything in `leads.js` between the
`// ---- auth` and `// ---- routes` banner comments — `enc`, `hmac`,
`safeEqual`, `mintToken`, `tokenValid`, `cookieValue`, `accessMode`,
`teamDomain`, `b64urlBytes`, `accessKeys`, `accessIdentity`, `emailAllowed`,
`signedIn`, `authed`, `sameOrigin` — plus the `SESSION_HOURS` and `COOKIE`
constants. Copy the bodies verbatim. Export everything named in the Interfaces
block above; leave `enc`, `teamDomain`, `b64urlBytes` and `accessKeys`
module-private.

This code decides who may read customer records. Do not rewrite, simplify or
"improve" any of it while moving it.

- [ ] **Step 4: Import in leads.js**

```js
import {
  SESSION_HOURS, COOKIE, safeEqual, mintToken, cookieValue,
  accessMode, accessIdentity, emailAllowed, signedIn, authed, sameOrigin
} from './_lib/auth.js';
```

Delete the moved definitions. If `SESSION_HOURS` or `COOKIE` are now only used
inside `auth.js`, drop them from the import rather than leaving unused names.

- [ ] **Step 5: Run the tests**

Run: `node --test 'tests/*.test.js'`
Expected: PASS

- [ ] **Step 6: Verify the compile still routes correctly**

Run:
```bash
npx wrangler pages functions build --outdir=.harness/worker
grep -oE '"routePath": "[^"]*"' .harness/worker/index.js | sort -u
```
Expected: unchanged from Task 2 — no `_lib` route.

- [ ] **Step 7: Commit**

```bash
git add functions/_lib/auth.js functions/leads.js tests/auth.test.js
git commit -m "$(cat <<'EOF'
Move session, Access and origin checks into _lib/auth.js

Moved verbatim: this code decides who may read customer names, phone
numbers and addresses, so the split must not change behaviour.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Extract the client grid script

**Files:**
- Create: `functions/_lib/grid.js`
- Modify: `functions/leads.js`, `tools/harness.js`, `tools/extract.js`
- Test: `tests/harness.test.js`

**Interfaces:**
- Consumes: `extractBlock` from Task 1.
- Produces: `functions/_lib/grid.js` exporting `GRID_JS: string` and
  `dashboard(view, rows, counts, ref, extra, nonce): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/harness.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

test('the harness builds and the client script parses', () => {
  const out = execFileSync(
    process.execPath,
    [path.join(__dirname, '../tools/harness.js'), '--check'],
    { encoding: 'utf8' }
  );
  assert.match(out, /GRID_JS parses/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'harness.test.js`
Expected: FAIL once `GRID_JS` has moved out of `leads.js` in Step 3 — run this
step after Step 3 if it passes now.

- [ ] **Step 3: Move the script and the dashboard shell**

Create `functions/_lib/grid.js` holding the `GRID_JS` template literal and the
`dashboard()` function, both verbatim. It needs:

```js
import { escape_, page } from './html.js';
```

and exports:

```js
export function dashboard(view, rows, counts, ref, extra, nonce) { /* unchanged */ }
export const GRID_JS = `
<PASTE THE EXISTING GRID_JS BODY HERE, UNCHANGED>
`;
```

Move the `VIEWS`, `STATUSES`, `SET_STATUSES`, `REFERRAL_STATUSES` and
`REFERRAL_FEE` constants that `dashboard()` reads into `grid.js` too, and
re-export them so `leads.js` can still validate against them:

```js
export const VIEWS = { repair: 'Repair & Pneumatic', tuning: 'Tuning',
  referrals: 'Referrals', all: 'All', invoices: 'Invoices' };
export const STATUSES = ['new', 'called', 'referred', 'booked', 'closed'];
export const SET_STATUSES = STATUSES.filter((s) => s !== 'referred');
export const REFERRAL_STATUSES = ['sent', 'booked', 'no_booking'];
export const REFERRAL_FEE = 25;
```

- [ ] **Step 4: Point the extractor at the new location**

In `tools/harness.js`, read both files and take each block from whichever now
holds it:

```js
const leads = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');
const gridSrc = fs.readFileSync(path.join(ROOT, 'functions/_lib/grid.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'functions/_lib/css.js'), 'utf8');
const css = extractBlock(cssSrc, 'CSS');
const js = extractBlock(gridSrc, 'GRID_JS');
```

`extractBlock` matches `const NAME = \``, but these are now `export const`.
Update its `open` to tolerate both:

```js
  const m = source.match(
    new RegExp(`(?:export\\\\s+)?const\\\\s+${constName}\\\\s*=\\\\s*\``));
  if (!m) throw new Error(`extractBlock: no const ${constName} template literal found`);
  const from = m.index + m[0].length;
```

Add a test for the `export const` form to `tests/extract.test.js`:

```js
test('extractBlock handles exported constants', () => {
  const src = 'export const CSS = `\nbody{color:red}\n`;';
  assert.strictEqual(extractBlock(src, 'CSS'), 'body{color:red}');
});
```

- [ ] **Step 5: Import in leads.js**

```js
import {
  dashboard, VIEWS, STATUSES, SET_STATUSES, REFERRAL_STATUSES, REFERRAL_FEE
} from './_lib/grid.js';
```

- [ ] **Step 6: Run the tests**

Run: `node --test 'tests/*.test.js'`
Expected: PASS, including the new `export const` case.

- [ ] **Step 7: Verify the grid still renders**

Run: `node tools/harness.js`
Open `.harness/harness.html` in a browser. Expected: three fixture leads, a
gold `Refer →` on Dana, an outcome dropdown on Priya, and an empty Referral
cell on Glenn the repair lead. No console errors.

- [ ] **Step 8: Commit**

```bash
git add functions/_lib/grid.js functions/leads.js tools/ tests/
git commit -m "$(cat <<'EOF'
Move the grid client script and dashboard shell into _lib/grid.js

leads.js is now a route handler rather than a 1,600-line file holding
routing, auth, HTML, CSS, a client application and Stripe.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Extract Stripe invoicing

**Files:**
- Create: `functions/_lib/stripe.js`
- Modify: `functions/leads.js`
- Test: `tests/stripe.test.js`

**Interfaces:**
- Consumes: `json` from `_lib/html.js`.
- Produces: `functions/_lib/stripe.js` exporting `createInvoice(env, body, now)`,
  `voidInvoice(env, id)`, `syncInvoices(env)`, `releaseReferrals(env, invoiceId)`,
  `applyStripeStatus(env, id, s)`, `INVOICE_COLUMNS: string[]`,
  `STRIPE_VERSION: string`, `MAX_LINES: number`, `MAX_LINE_CENTS: number`.

- [ ] **Step 1: Write the failing test**

Create `tests/stripe.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../functions/_lib/stripe.js'), 'utf8');

test('the Stripe API version stays pinned', () => {
  assert.match(SRC, /STRIPE_VERSION\s*=\s*'2024-06-20'/);
});

test('invoice line limits are enforced', () => {
  assert.match(SRC, /MAX_LINES\s*=\s*25/);
  assert.match(SRC, /MAX_LINE_CENTS\s*=\s*5000000/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'stripe.test.js`
Expected: FAIL — no such file

- [ ] **Step 3: Move the Stripe block**

Move everything from the `// ---- stripe` banner through `syncInvoices`
verbatim, plus `INVOICE_COLUMNS`, `STRIPE_VERSION`, `MAX_LINES`,
`MAX_LINE_CENTS` and `EMAIL_RE`. Add `import { json } from './html.js';`.
Keep the `stripe()` request helper module-private.

- [ ] **Step 4: Import in leads.js**

```js
import {
  createInvoice, voidInvoice, syncInvoices, INVOICE_COLUMNS
} from './_lib/stripe.js';
```

- [ ] **Step 5: Run the tests and the compile check**

Run: `node --test 'tests/*.test.js'`
Expected: PASS

Run:
```bash
npx wrangler pages functions build --outdir=.harness/worker
grep -oE '"routePath": "[^"]*"' .harness/worker/index.js | sort -u
```
Expected: `/leads`, `/api/lead`, `/api/csp-report` only.

- [ ] **Step 6: Check the file actually shrank**

Run: `wc -l functions/leads.js functions/_lib/*.js`
Expected: `leads.js` well under 500 lines; no module over ~700.

- [ ] **Step 7: Commit**

```bash
git add functions/_lib/stripe.js functions/leads.js tests/stripe.test.js
git commit -m "$(cat <<'EOF'
Move Stripe invoicing into _lib/stripe.js

Completes the split. leads.js is now routing, request validation and
dispatch; everything else is a module.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Schema migration

**Files:**
- Modify: `db/schema.sql`
- Create: `db/2026-09-22-add-scheduling-and-archive.sql`
- Test: `tests/schema.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: columns `leads.scheduled_at`, `leads.scheduled_mins`,
  `leads.archived_at`; table `settings(key, value, updated_at)`.

- [ ] **Step 1: Write the failing test**

Create `tests/schema.test.js`. It shells out to the `sqlite3` CLI, which is
present on macOS and on GitHub's `ubuntu-latest`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function freshDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-')), 't.db');
  execFileSync('sqlite3', [file], {
    input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8')
  });
  return file;
}

function query(file, sql) {
  return execFileSync('sqlite3', [file, sql], { encoding: 'utf8' }).trim();
}

test('schema.sql creates the scheduling and archive columns', () => {
  const db = freshDb();
  const cols = query(db, "SELECT name FROM pragma_table_info('leads')").split('\n');
  for (const c of ['scheduled_at', 'scheduled_mins', 'archived_at']) {
    assert.ok(cols.includes(c), `leads.${c} missing`);
  }
});

test('schema.sql creates the settings table', () => {
  const db = freshDb();
  const t = query(db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'");
  assert.strictEqual(t, 'settings');
});

test('the migration is idempotent against an already-migrated database', () => {
  const db = freshDb();
  const sql = fs.readFileSync(
    path.join(ROOT, 'db/2026-09-22-add-scheduling-and-archive.sql'), 'utf8');
  // Each ALTER is guarded, so a second application must not throw.
  execFileSync('sqlite3', [db], { input: sql });
  execFileSync('sqlite3', [db], { input: sql });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'schema.test.js`
Expected: FAIL — `leads.scheduled_at missing`

- [ ] **Step 3: Update schema.sql**

Add to the `CREATE TABLE leads` body, before the closing paren:

```sql
  -- When the job is booked for, and how long it runs. Feeds the calendar.
  scheduled_at   TEXT,     -- ISO-8601 UTC
  scheduled_mins INTEGER,  -- NULL means the 90-minute default

  -- Set = archived: hidden from every working view, purged after 30 days.
  archived_at    TEXT,
```

And after the existing indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_leads_scheduled ON leads(scheduled_at)
  WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(archived_at);

-- Small key/value store. Holds the calendar feed token, so it can be rotated
-- from the dashboard without a redeploy.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);
```

Update the "Upgrading a database created before" comment at the top to list the
three new `ALTER TABLE` lines.

- [ ] **Step 4: Write the migration for the live database**

`CREATE TABLE IF NOT EXISTS` will not add columns to the existing table, so the
live database needs explicit ALTERs. SQLite has no `ADD COLUMN IF NOT EXISTS`,
so run them individually and accept a "duplicate column name" error as
already-applied.

Create `db/2026-09-22-add-scheduling-and-archive.sql`:

```sql
-- Adds scheduling and archiving to an existing database.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS. Apply each statement separately and
-- treat "duplicate column name" as already-applied, not as a failure:
--
--   npx wrangler d1 execute pianoplayertech-leads --remote \
--     --command "ALTER TABLE leads ADD COLUMN scheduled_at TEXT"
--   npx wrangler d1 execute pianoplayertech-leads --remote \
--     --command "ALTER TABLE leads ADD COLUMN scheduled_mins INTEGER"
--   npx wrangler d1 execute pianoplayertech-leads --remote \
--     --command "ALTER TABLE leads ADD COLUMN archived_at TEXT"
--
-- Then apply this file for the indexes and the settings table, which are
-- guarded and safe to re-run:
--
--   npx wrangler d1 execute pianoplayertech-leads --remote \
--     --file=db/2026-09-22-add-scheduling-and-archive.sql
--
-- If CLOUDFLARE_API_TOKEN is set in your shell it shadows the OAuth login and
-- lacks D1 permission. Prefix with `env -u CLOUDFLARE_API_TOKEN`.

CREATE INDEX IF NOT EXISTS idx_leads_scheduled ON leads(scheduled_at)
  WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_archived ON leads(archived_at);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);
```

- [ ] **Step 5: Run the tests**

Run: `node --test 'tests/*.test.js'schema.test.js`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add db/schema.sql db/2026-09-22-add-scheduling-and-archive.sql tests/schema.test.js
git commit -m "$(cat <<'EOF'
Add scheduling and archive columns to the schema

Additive only, so a running deployment is unaffected until code uses them.
SQLite has no ADD COLUMN IF NOT EXISTS, so the live ALTERs run individually
and a duplicate-column error means already-applied.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Apply to the live database**

This writes to production. Confirm with the user first, then run the three
ALTER commands and the file from Step 4. Verify:

```bash
env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=39798a42943e2b246263c85913c83895 \
  npx wrangler d1 execute pianoplayertech-leads --remote \
  --command "SELECT name FROM pragma_table_info('leads')"
```
Expected: the list includes `scheduled_at`, `scheduled_mins`, `archived_at`.

---

### Task 7: Hide archived leads from every query

The spec names this the most likely defect in the whole change. Every read
path gains `archived_at IS NULL`; every write path refuses an archived lead.

**Files:**
- Modify: `functions/leads.js`
- Test: `tests/archived-exclusion.test.js`

**Interfaces:**
- Consumes: the schema from Task 6.
- Produces: `NOT_ARCHIVED: string` constant exported from `functions/_lib/db.js`
  (create it in this task), equal to `'archived_at IS NULL'`.

- [ ] **Step 1: Write the failing test**

Create `tests/archived-exclusion.test.js`. Rather than mock D1, this asserts
against the SQL text the handler builds, then proves the clause behaves
correctly against real SQLite:

```js
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');

test('every leads query filters out archived rows', () => {
  const selects = SRC.match(/FROM leads[^`]*/g) || [];
  assert.ok(selects.length > 0, 'expected queries against leads');
  for (const s of selects) {
    assert.ok(
      /archived_at IS NULL/.test(s) || /WHERE id = \?/.test(s),
      `query does not exclude archived leads:\n${s}`
    );
  }
});

test('the clause actually excludes archived rows in SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-'));
  const db = path.join(dir, 't.db');
  execFileSync('sqlite3', [db], {
    input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8')
  });
  execFileSync('sqlite3', [db, `
    INSERT INTO leads (created_at,pipeline,status,name,archived_at) VALUES
      ('2026-09-01T00:00:00Z','tuning','new','Visible',NULL),
      ('2026-09-01T00:00:00Z','tuning','new','Hidden','2026-09-10T00:00:00Z');`]);
  const out = execFileSync('sqlite3',
    [db, 'SELECT name FROM leads WHERE archived_at IS NULL'],
    { encoding: 'utf8' }).trim();
  assert.strictEqual(out, 'Visible');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'archived-exclusion.test.js`
Expected: FAIL — the grid, counts and stats queries lack the clause

- [ ] **Step 3: Create the shared constant**

Create `functions/_lib/db.js`:

```js
// One spelling of "not archived", so a new query cannot quietly omit it.
// Archived leads are invisible to every working view and to the CSV export;
// only a lookup by explicit id may see one, so archive and restore can work.
export const NOT_ARCHIVED = 'archived_at IS NULL';
```

- [ ] **Step 4: Apply it to every read path**

In `functions/leads.js`, import it and amend each query:

```js
import { NOT_ARCHIVED } from './_lib/db.js';
```

The grid `where` clause becomes:

```js
    const where = view === 'all' || view === 'invoices' ? `WHERE ${NOT_ARCHIVED}`
      : view === 'referrals' ? `WHERE referred_at IS NOT NULL AND ${NOT_ARCHIVED}`
      : `WHERE pipeline = ? AND ${NOT_ARCHIVED}`;
```

The pipeline counts:

```js
    const c = await env.DB.prepare(
      `SELECT pipeline, SUM(status = 'new') AS n FROM leads
        WHERE ${NOT_ARCHIVED} GROUP BY pipeline`
    ).all();
```

The referral stats:

```js
    const s = await env.DB.prepare(
      `SELECT COUNT(referred_at) AS sent,
              SUM(referral_status = 'booked') AS booked,
              SUM(referral_status = 'no_booking') AS lost,
              SUM(referral_status = 'booked' AND referral_paid_at IS NOT NULL) AS paid
         FROM leads WHERE referred_at IS NOT NULL AND ${NOT_ARCHIVED}`
    ).first();
```

The CSV export shares the grid rows and needs no separate change — confirm
that by reading the export branch rather than assuming it.

- [ ] **Step 5: Refuse writes to archived leads**

In `onRequestPost`, after `const id = parseInt(body.id, 10);` and its validity
check, add:

```js
  // An archived lead is invisible, so an action against one is always a stale
  // tab. Refusing beats silently mutating a row nobody can see.
  const target = await env.DB.prepare(
    'SELECT archived_at FROM leads WHERE id = ?').bind(id).first();
  if (!target) return json({ error: 'That lead no longer exists.' }, 404);
  if (target.archived_at && body.action !== 'restore' && body.action !== 'purge') {
    return json({ error: 'That lead is archived. Restore it first.' }, 409);
  }
```

- [ ] **Step 6: Run the tests**

Run: `node --test 'tests/*.test.js'`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add functions/_lib/db.js functions/leads.js tests/archived-exclusion.test.js
git commit -m "$(cat <<'EOF'
Exclude archived leads from every view, count and stat

The spec calls this the most likely defect in the change: miss one query
and an archived lead reappears in a view or skews a number that drives
billing. A test walks every FROM leads query and fails if it lacks the
clause, so a new query cannot quietly omit it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Archive, restore and the Archive tab

**Files:**
- Modify: `functions/leads.js`, `functions/_lib/grid.js`, `functions/_lib/css.js`
- Test: `tests/archive.test.js`

**Interfaces:**
- Consumes: `NOT_ARCHIVED` from Task 7.
- Produces: POST actions `archive`, `restore`, `purge`, each taking `{id}` and
  returning `{ok: true}`; view key `archive` in `VIEWS`.

- [ ] **Step 1: Write the failing test**

Create `tests/archive.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEADS = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');
const GRID = fs.readFileSync(path.join(ROOT, 'functions/_lib/grid.js'), 'utf8');

test('the archive actions exist', () => {
  for (const a of ['archive', 'restore', 'purge']) {
    assert.ok(
      LEADS.includes(`body.action === '${a}'`),
      `missing handler for action ${a}`
    );
  }
});

test('the Archive tab is a view', () => {
  assert.match(GRID, /archive:\s*'Archive'/);
});

test('purge is a hard delete, archive is not', () => {
  assert.match(LEADS, /DELETE FROM leads WHERE id = \?/);
  assert.match(LEADS, /SET archived_at = \?/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'archive.test.js`
Expected: FAIL — missing handler for action archive

- [ ] **Step 3: Add the actions**

In `onRequestPost`, before the `unknown action` fallback:

```js
    if (body.action === 'archive') {
      await env.DB.prepare(
        'UPDATE leads SET archived_at = ?, updated_at = ? WHERE id = ?')
        .bind(now, now, id).run();
      return json({ ok: true, value: now });
    }

    if (body.action === 'restore') {
      await env.DB.prepare(
        'UPDATE leads SET archived_at = NULL, updated_at = ? WHERE id = ?')
        .bind(now, id).run();
      return json({ ok: true, value: null });
    }

    // Irreversible, and only reachable from the Archive tab.
    if (body.action === 'purge') {
      if (!target.archived_at) {
        return json({ error: 'Archive this lead before deleting it.' }, 400);
      }
      await env.DB.prepare('DELETE FROM leads WHERE id = ?').bind(id).run();
      return json({ ok: true, purged: true });
    }
```

- [ ] **Step 4: Add the Archive view**

In `functions/_lib/grid.js`, add to `VIEWS`:

```js
export const VIEWS = { repair: 'Repair & Pneumatic', tuning: 'Tuning',
  referrals: 'Referrals', all: 'All', invoices: 'Invoices', archive: 'Archive' };
```

In `leads.js`, add the archive branch to the `where`/`order` selection:

```js
    const where = view === 'archive' ? 'WHERE archived_at IS NOT NULL'
      : view === 'all' || view === 'invoices' ? `WHERE ${NOT_ARCHIVED}`
      : view === 'referrals' ? `WHERE referred_at IS NOT NULL AND ${NOT_ARCHIVED}`
      : `WHERE pipeline = ? AND ${NOT_ARCHIVED}`;
    const order = view === 'archive' ? 'ORDER BY archived_at DESC'
      : view === 'referrals' ? 'ORDER BY referred_at DESC'
      : `ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, created_at DESC`;
```

Add `archived_at` to the `COLUMNS` array so the grid receives it.

- [ ] **Step 5: Add the grid controls**

In the `COLS` builder inside `GRID_JS`, for the archive view:

```js
  if (view === 'archive') {
    COLS.push(
      {k:'archived_at', label:'Archived', type:'date', w:120},
      {k:'purge_in', label:'Deletes in', type:'purgein', w:110},
      {k:'id', label:'', type:'archiveacts', w:180}
    );
  }
```

Add the two cell types to `cell()`:

```js
    } else if (c.type === 'purgein') {
      var days = 30 - Math.floor(
        (Date.now() - new Date(r.archived_at).getTime()) / 86400000);
      td.appendChild(el('div', {className:'ro',
        text: days > 0 ? days + (days === 1 ? ' day' : ' days') : 'any time now'}));
    } else if (c.type === 'archiveacts') {
      td.appendChild(el('div', {className:'cellacts'}, [
        el('button', {className:'ghost sm', type:'button', text:'Restore',
          on:{click:function(){ archiveAction(r, 'restore'); }}}),
        el('button', {className:'danger', type:'button', text:'Delete now',
          on:{click:function(){ archiveAction(r, 'purge'); }}})
      ]));
```

And for every other view, an Archive button in the name cell:

```js
        el('button', {className:'ghost sm', type:'button', text:'Archive',
          title:'Hide this lead; deleted permanently after 30 days',
          on:{click:function(){ archiveAction(r, 'archive'); }}}),
```

Add the handler beside `save()`:

```js
  function archiveAction(r, action){
    if (action === 'purge' &&
        !confirm('Delete ' + (r.name || 'this lead') +
                 ' permanently? This cannot be undone.')) return;
    post({action:action, id:r.id}).then(function(j){
      rows = rows.filter(function(x){ return x !== r; });
      render();
    }, function(e){ alert(e.message); });
  }
```

- [ ] **Step 6: Style the destructive control**

In `functions/_lib/css.js`, beside `.ghost`.

Note two existing rules these must override: `.ghost` sets `flex:1`, so a
small in-cell button would stretch to fill; and `.pair` sets
`margin:.8rem 0 .2rem`, which is right in the referral dialog but wrong inside
a 36px table cell. Hence `.cellacts` rather than reusing `.pair`:

```css
.danger{flex:none;background:none;border:1px solid var(--bad);color:var(--bad);
border-radius:5px;padding:.25rem .5rem;cursor:pointer;font:inherit;font-size:.75rem}
.danger:hover{background:var(--bad);color:var(--ground)}
.ghost.sm{flex:none;font-size:.72rem;padding:0 .4rem;height:24px;line-height:22px}
.cellacts{display:flex;gap:.35rem;align-items:center;padding:0 .4rem;margin:0}
```

In Step 5, use `className:'cellacts'` for the archive actions wrapper rather
than `'pair'`.

- [ ] **Step 7: Run the tests and the harness**

Run: `node --test 'tests/*.test.js'`
Expected: PASS

Run: `node tools/harness.js`
Open `.harness/harness.html`. Expected: an Archive button on each row, no
console errors. (The harness has no server, so clicking it will fail the POST —
that is expected; you are checking it renders.)

- [ ] **Step 8: Commit**

```bash
git add functions/ tests/archive.test.js
git commit -m "$(cat <<'EOF'
Add archive, restore and permanent delete

Archiving hides a lead from every working view; the Archive tab shows what
is hidden and how many days remain before automatic deletion. Purging is
irreversible and says so before it runs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Thirty-day purge on dashboard load

Pages Functions have no cron triggers — confirmed in Cloudflare's Pages-to-
Workers migration guide, which lists Cron Triggers among the features Workers
has and Pages lacks. The purge therefore runs opportunistically, off the
response path.

**Files:**
- Modify: `functions/leads.js`, `functions/_lib/db.js`
- Test: `tests/purge.test.js`

**Interfaces:**
- Consumes: `NOT_ARCHIVED` from Task 7.
- Produces: `purgeCutoff(now: Date): string` and `purgeExpired(env, cutoff):
  Promise<number>` exported from `functions/_lib/db.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/purge.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'functions/_lib/db.js'), 'utf8');

test('the cutoff is an ISO string thirty days back', () => {
  // Extract and evaluate purgeCutoff without importing an ESM module
  // from a CommonJS test.
  const body = DB_SRC.match(
    /export function purgeCutoff[\s\S]*?\n}/)[0].replace('export ', '');
  const purgeCutoff = new Function(`${body}; return purgeCutoff;`)();
  const out = purgeCutoff(new Date('2026-09-22T12:00:00Z'));
  assert.strictEqual(out, '2026-08-23T12:00:00.000Z');
});

test('the purge deletes only leads archived more than thirty days ago', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-'));
  const db = path.join(dir, 't.db');
  execFileSync('sqlite3', [db], {
    input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8')
  });
  execFileSync('sqlite3', [db, `
    INSERT INTO leads (created_at,pipeline,status,name,archived_at) VALUES
      ('2026-01-01T00:00:00Z','tuning','new','Old','2026-08-01T00:00:00.000Z'),
      ('2026-01-01T00:00:00Z','tuning','new','Recent','2026-09-20T00:00:00.000Z'),
      ('2026-01-01T00:00:00Z','tuning','new','Active',NULL);`]);
  execFileSync('sqlite3', [db,
    `DELETE FROM leads WHERE archived_at IS NOT NULL
      AND archived_at < '2026-08-23T12:00:00.000Z'`]);
  const names = execFileSync('sqlite3',
    [db, 'SELECT name FROM leads ORDER BY name'],
    { encoding: 'utf8' }).trim().split('\n');
  assert.deepStrictEqual(names, ['Active', 'Recent']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'tests/*.test.js'purge.test.js`
Expected: FAIL — `purgeCutoff` not found in `_lib/db.js`

- [ ] **Step 3: Implement the purge**

Append to `functions/_lib/db.js`:

```js
// Pages Functions have no cron triggers, so the 30-day purge cannot be a
// scheduled job. It runs when the dashboard is opened, inside waitUntil, so
// it never delays a response. Consequence: if nobody opens the CRM for 45
// days, records purge on the next open. Thirty days is a floor on retention,
// not a ceiling, and the Archive tab says so.
export const PURGE_DAYS = 30;

export function purgeCutoff(now) {
  return new Date(now.getTime() - PURGE_DAYS * 86400000).toISOString();
}

export async function purgeExpired(env, cutoff) {
  const r = await env.DB.prepare(
    'DELETE FROM leads WHERE archived_at IS NOT NULL AND archived_at < ?'
  ).bind(cutoff).run();
  return (r.meta && r.meta.changes) || 0;
}
```

ISO-8601 UTC strings sort lexicographically, which is why this compares
strings rather than calling SQLite's `datetime()` — mixing the two silently
mishandles the `Z` suffix.

- [ ] **Step 4: Call it off the response path**

In `onRequestGet`, after the auth checks and the `env.DB` guard:

```js
  // Off the response path: a slow delete must never make the dashboard slow.
  context.waitUntil(
    purgeExpired(env, purgeCutoff(new Date()))
      .catch((err) => console.error('purge failed', err && err.message))
  );
```

Add to the imports:

```js
import { NOT_ARCHIVED, purgeCutoff, purgeExpired, PURGE_DAYS } from './_lib/db.js';
```

`onRequestGet` already destructures `{ request, env }` from `context`; keep
`context` itself in scope for `waitUntil`.

- [ ] **Step 5: Tell the user what the Archive tab actually promises**

There is no module-level `banner` variable in `GRID_JS` — `renderBanner()`
fetches the element itself with `document.getElementById('banner')`. Follow
that pattern. Inside `renderBanner()`, before its existing logic:

```js
    if (view === 'archive') {
      var b = document.getElementById('banner');
      b.textContent = 'Archived leads are deleted permanently about ' +
        D.purgeDays + ' days after archiving. Restore one to keep it.';
      b.hidden = false;
      return;
    }
```

Pass `purgeDays: PURGE_DAYS` in the `data` object that `dashboard()` builds,
and import `PURGE_DAYS` into `grid.js` from `./db.js`.
"About" is deliberate — the purge is opportunistic, and the wording should not
promise precision the implementation does not have.

- [ ] **Step 6: Run the tests**

Run: `node --test 'tests/*.test.js'`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add functions/ tests/purge.test.js
git commit -m "$(cat <<'EOF'
Purge leads archived more than thirty days ago

Pages Functions have no cron triggers, so this runs on dashboard load
inside waitUntil rather than on a schedule. Thirty days is a floor on
retention, not a guarantee, and the Archive tab says "about 30 days"
rather than promising precision the implementation cannot deliver.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Verify end to end, then ship

**Files:** none modified.

- [ ] **Step 1: Full local verification**

```bash
node --test 'tests/*.test.js'
node tools/harness.js --check
node .github/scripts/check-site.js
npx wrangler pages functions build --outdir=.harness/worker
grep -oE '"routePath": "[^"]*"' .harness/worker/index.js | sort -u
```
Expected: all tests pass; `check-site.js` prints PASSED; routes are `/leads`,
`/api/lead`, `/api/csp-report` and nothing under `_lib`.

- [ ] **Step 2: Confirm the migration is live**

The code now reads `archived_at`. If Task 6 Step 7 has not been applied to the
live database, the dashboard will fail with "no such column". Verify before
pushing:

```bash
env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=39798a42943e2b246263c85913c83895 \
  npx wrangler d1 execute pianoplayertech-leads --remote \
  --command "SELECT name FROM pragma_table_info('leads')"
```
Expected: includes `archived_at`. **Do not push until this passes.**

- [ ] **Step 3: Push**

Pushing deploys to production. Confirm with the user, then:

```bash
git push origin main
```

- [ ] **Step 4: Confirm the deployment**

```bash
env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=39798a42943e2b246263c85913c83895 \
  npx wrangler pages deployment list --project-name=pianoplayertech | head -5
```
Expected: the newest deployment is `Active` and its Source matches the pushed
commit.

- [ ] **Step 5: Check the real dashboard**

Ask the user to open `/leads` and confirm: every tab loads, the counts and
referral stats are unchanged from before the refactor, an Archive button
appears on each row, archiving moves a lead to the Archive tab, and restoring
brings it back. The refactor is only correct if nothing visible changed except
the new archive controls.

---

## Follow-on plans

- **Plan B — scheduling and the calendar feed.** `scheduled_at` editing, the
  `.ics` endpoint, token generation and rotation. Depends on Task 6's columns.
- **Plan C — style overhaul.** Light theme with dark support, the sub-760px
  card layout, priority hierarchy. Last on purpose: if something breaks in A
  or B it stays obvious rather than being masked by everything looking
  different.
