// Every public form, from the page to the stored lead.
//
// Each case reads the real form out of the real HTML: its field names, its
// hidden values, its select options. It fills it in the way a person would,
// runs the real ppt-tracking.js submit handler (the only thing that sends a
// form to /api/lead) in a sandbox, posts exactly what that handler sent to
// the real functions/api/lead.js against a real SQLite database, and then
// checks the row, the emails, and which of the seeded tables it lands in.
// docs/lead-flow-audit.md is the write-up of what these found.

// Node 18+ globals; the lint config only lists the older ones.
/* global Request, Blob, File, FormData */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { onRequestPost as leadPost } from '../functions/api/lead.js';
import { onRequestPost as photosPost } from '../functions/api/photos.js';
import { listTables } from '../functions/_lib/views.js';
import { compileRules } from '../functions/_lib/tablefilter.js';
import { ROOT, sqlite, fakeDb, freshDbFile, context } from './fixtures/harness.mjs';

const TRACKING = fs.readFileSync(path.join(ROOT, 'ppt-tracking.js'), 'utf8');
const NOTIFY = 'alerts@ppt.test';

// ---------------------------------------------------------- reading forms

function formsIn(file) {
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const body = m[2];
    const attr = (n) => { const a = new RegExp('\\b' + n + '="([^"]*)"').exec(attrs); return a ? a[1] : ''; };
    const fields = [];
    const fr = /<(input|select|textarea)\b([^>]*)>/g;
    let f;
    while ((f = fr.exec(body))) {
      const a = f[2];
      const inner = f[1] === 'select' ? body.slice(fr.lastIndex, body.indexOf('</select>', fr.lastIndex)) : '';
      const name = (/\bname="([^"]+)"/.exec(a) || [])[1];
      if (!name) continue;
      const type = f[1] === 'input' ? ((/\btype="([^"]+)"/.exec(a) || [])[1] || 'text') : f[1];
      const value = (/\bvalue="([^"]*)"/.exec(a) || [])[1];
      const options = inner ? [...inner.matchAll(/<option\b([^>]*)>([^<]*)/g)]
        .map((o) => { const v = /\bvalue="([^"]*)"/.exec(o[1]); return v ? v[1] : o[2].trim(); }) : [];
      fields.push({ name, type, value, options, required: /\brequired\b/.test(a) });
    }
    out.push({ file, id: attr('id'), action: attr('action'),
      noAirtable: /\bdata-no-airtable\b/.test(attrs), afterOk: /\bdata-lead-after-ok\b/.test(attrs), fields });
  }
  return out;
}

const ALL_FORMS = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort().flatMap(formsIn);
const formKey = (f) => `${f.file}#${f.id || f.action}`;

// What a person would type, by field name.
const SAMPLE = {
  name: 'Pat Tester', email: 'pat@example.com', phone: '(770) 555-0199', city: 'Marietta',
  location: 'Dahlonega, GA', area: 'Roswell', address: '12 Main St, Marietta, GA', piano: 'Yamaha U1',
  system: 'Yamaha U1', issue: 'It needs looking at.', message: 'Please call me back.', notes: 'Gate code 1234.',
  studio: 'Keys Studio', company: 'Tech Co', preferred_dates: 'Weekday mornings'
};

// The entries a browser's FormData would hold for this form, in order.
function fill(form, over = {}) {
  return form.fields.map((f) => {
    let v;
    if (Object.prototype.hasOwnProperty.call(over, f.name)) v = over[f.name];
    else if (f.name === '_gotcha') v = '';
    else if (f.type === 'hidden') v = f.value == null ? '' : f.value;
    else if (f.type === 'select') v = f.options.find((o) => o) || '';
    else if (f.type === 'file') v = '';
    else v = SAMPLE[f.name] == null ? 'Test value' : SAMPLE[f.name];
    return [f.name, v];
  });
}

// ------------------------------------------------- the browser half, for real

// Runs ppt-tracking.js against a stand-in page and submits `form` with
// `entries`. Returns what it handed to sendBeacon: [] when it sent nothing.
// A data-lead-after-ok form sends nothing on submit; its page calls
// pptAfterFormspree with Formspree's HTTP status (0 for no answer) once it
// has one, which `formspree` stands in for. What that returned is on
// the result as `.how`.
async function submitThroughTracking(form, entries, pathname, { formspree = 200 } = {}) {
  let onSubmit = null;
  const beacons = [];
  const page = {
    document: { addEventListener: (type, fn) => { if (type === 'submit') onSubmit = fn; } },
    location: { pathname, href: `https://pianoplayertech.com${pathname}` },
    navigator: { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } },
    Blob,
    FormData: function FormData() { return { forEach: (cb) => entries.forEach(([k, v]) => cb(v, k)) }; },
    fetch: () => Promise.resolve(),
    gtag: () => {}
  };
  page.window = page;
  vm.runInNewContext(TRACKING, page);
  const el = {
    tagName: 'FORM', id: form.id,
    hasAttribute: (n) => (n === 'data-no-airtable' && form.noAirtable) || (n === 'data-lead-after-ok' && form.afterOk),
    querySelector: (sel) => {
      const m = /\[name="([^"]+)"\]/.exec(sel);
      const hit = m && entries.find(([k]) => k === m[1]);
      return hit ? { value: hit[1] } : null;
    }
  };
  onSubmit({ target: el });
  let how = null;
  if (form.afterOk) {
    assert.strictEqual(beacons.length, 0, 'nothing is sent before Formspree answers');
    how = page.window.pptAfterFormspree(el, formspree);
  }
  const out = [];
  for (const b of beacons) out.push({ url: b.url, body: JSON.parse(await b.blob.text()) });
  out.how = how;
  out.message = how ? page.window.pptFormspreeMessage(how, 'email should be an email') : '';
  return out;
}

// --------------------------------------------------- the server half, for real

function env() {
  const file = freshDbFile('ppt-flow-');
  return { DB: fakeDb(file), _file: file, RESEND_API_KEY: 'test', LEAD_NOTIFY_EMAIL: NOTIFY,
    LEAD_FROM_EMAIL: 'PPT <info@ppt.test>' };
}

async function postLead(e, body) {
  const real = globalThis.fetch;
  const emails = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
    emails.push(JSON.parse(init.body));
    return new Response('{}', { status: 200 });
  };
  try {
    const req = new Request('https://pianoplayertech.com/api/lead', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://pianoplayertech.com' },
      body: JSON.stringify(body) });
    const ctx = context(req, e);
    const res = await leadPost(ctx);
    await ctx.settle();
    return { status: res.status, emails };
  } finally {
    globalThis.fetch = real;
  }
}

async function tablesHolding(e, id) {
  const names = [];
  for (const t of await listTables(e)) {
    const c = compileRules(t.config.rules, { now: new Date() });
    let stmt = e.DB.prepare(`SELECT id FROM leads WHERE id = ? AND ${c.sql}`).bind(id, ...c.params);
    if ((await stmt.first())) names.push(t.name);
  }
  return names;
}

const pathOf = (file) => file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, '');

// ------------------------------------------------------------- the cases
//
// Every form that sends a lead, with what it must become. `over` sets what
// the person typed where the page itself does not decide the answer.

const CASES = [
  { form: 'index.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: null, table: 'Repair', about: 'your piano' },
  { form: 'antique-player-piano.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: 'pneumatic', table: 'Pneumatic', about: 'your player piano',
    over: { system: 'Not sure, it has paper rolls' } },
  { form: 'disklavier-power-supply-repair.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano',
    over: { system: 'Disklavier MX100A' } },
  { form: 'disklavier-repair.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano' },
  { form: 'for-technicians.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano' },
  // A technician refers a customer: the lead is the customer, electronic,
  // with the referring tech's name kept in the lead's fields.
  { form: 'for-technicians.html#tech-referral-form', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano',
    over: { referring_tech: 'Sam Tuner', tech_phone: '(404) 555-0123' } },
  { form: 'piano-cleaning.html#detailing-form', pipeline: 'repair', category: 'acoustic', table: 'Repair', about: 'your piano' },
  { form: 'piano-repair.html#repair-form', pipeline: 'repair', category: 'acoustic', table: 'Repair', about: 'your piano' },
  { form: 'piano-detailing.html#detailing-quote-form', pipeline: 'repair', category: 'acoustic', table: 'Repair', about: 'your piano' },
  { form: 'piano-detailing.html#detailing-quote-form', name: 'piano-detailing (bundled with a tuning)', pipeline: 'repair', category: 'acoustic', table: 'Repair', about: 'your piano',
    over: { service_level: 'Detailing + a tuning (bundle)' } },
  // "voicing" reads as tuning to the pipeline rule; this page is ours to quote and do.
  { form: 'piano-voicing-regulation.html#voicing-form', pipeline: 'repair', category: 'acoustic', table: 'Repair', about: 'your piano' },
  { form: 'player-system-install.html#install-form', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano' },
  { form: 'player-system-install.html#install-form', name: 'player-system-install (pneumatic system named)', pipeline: 'repair', category: 'pneumatic', table: 'Pneumatic', about: 'your player piano',
    over: { service_level: 'Not sure yet', message: 'It is an old Ampico reproducing grand, we want the player taken out' } },
  { form: 'piano-teachers.html#teacher-form', pipeline: 'tuning', category: null, table: 'Tuning', about: 'referring your students' },
  { form: 'piano-tuning-atlanta.html#https://formspree.io/f/xzdlraeq', pipeline: 'tuning', category: 'tuning', table: 'Tuning', about: 'tuning your piano' },
  { form: 'piano-tuning-cumming-ga.html#https://formspree.io/f/xzdlraeq', pipeline: 'tuning', category: 'tuning', table: 'Tuning', about: 'tuning your piano' },
  { form: 'piano-tuning-gainesville-ga.html#https://formspree.io/f/xzdlraeq', pipeline: 'tuning', category: 'tuning', table: 'Tuning', about: 'tuning your piano' },
  { form: 'piano-tuning-marietta-ga.html#https://formspree.io/f/xzdlraeq', pipeline: 'tuning', category: 'tuning', table: 'Tuning', about: 'tuning your piano' },
  { form: 'pianodisc-repair.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano' },
  { form: 'player-diagnostic.html#quizLead', pipeline: 'repair', category: 'pneumatic', table: 'Pneumatic', about: 'your player piano',
    over: { quiz_summary: 'Player piano · An antique player with paper rolls · Keys move but no sound', recommended: 'Pneumatic restoration assessment' } },
  { form: 'player-diagnostic.html#quizLead', name: 'player-diagnostic (electronic answers)', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano',
    over: { quiz_summary: 'Yamaha Disklavier · Completely dead', recommended: 'In-home player system diagnosis' } },
  { form: 'player-repair.html#diagnosis-intake', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano',
    over: { system: 'Disklavier Mark III' } },
  { form: 'player-repair.html#diagnosis-intake', name: 'player-repair diagnosis intake (pneumatic system named)', pipeline: 'repair', category: 'pneumatic', table: 'Pneumatic', about: 'your player piano',
    over: { system: 'Ampico reproducing grand' } },
  { form: 'player-unit-mail-in-repair.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano',
    over: { system: 'PianoDisc PDS-128 controller' } },
  { form: 'qrs-repair.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano' },
  { form: 'quiz.html#quizLead', pipeline: 'tuning', category: 'tuning', table: 'Tuning', about: 'tuning your piano',
    over: { quiz_summary: 'Upright · Sounds out of tune · Within a month', recommended: 'In-home piano tuning' } },
  { form: 'quiz.html#quizLead', name: 'quiz (player answers)', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano',
    over: { quiz_summary: 'Player piano · Player system not working · Yamaha Disklavier', recommended: 'In-home player system diagnosis' } },
  { form: 'spirio-repair.html#https://formspree.io/f/xeebglab', pipeline: 'repair', category: 'electronic', table: 'Repair', about: 'your player piano' },
  { form: 'tuning.html#tuning-booking-form', pipeline: 'tuning', category: 'tuning', table: 'Tuning', about: 'tuning your piano' }
];

// Answers that land in their own column, in lead.js's pick() order: the
// first of these the form filled in wins.
const COLUMNS_FROM = { name: ['name', 'full_name'], email: ['email'], phone: ['phone', 'tel'],
  city: ['city', 'location', 'area'], address: ['address', 'street', 'service_address'],
  system: ['system', 'piano', 'make', 'model'],
  service: ['service_type', 'lead_type', 'form_type', 'service_level', 'recommended'],
  message: ['message', 'notes', 'issue', 'details', 'quiz_summary', 'description'] };

test('every form on the site that sends a lead has a case here', () => {
  const sending = ALL_FORMS.filter((f) => !f.noAirtable).map(formKey);
  const covered = new Set(CASES.map((c) => c.form));
  for (const k of sending) assert.ok(covered.has(k), `${k} sends leads and has no lead-flow case`);
  for (const c of CASES) assert.ok(sending.includes(c.form), `${c.form} is not a lead form on the site`);
  // Every one of them carries the spam trap.
  for (const f of ALL_FORMS.filter((x) => !x.noAirtable)) {
    assert.ok(f.fields.some((x) => x.name === '_gotcha'), `${formKey(f)} has no honeypot`);
  }
});

for (const c of CASES) {
  test(`lead flow: ${c.name || c.form}`, async () => {
    const form = ALL_FORMS.find((f) => formKey(f) === c.form);
    assert.ok(form, `${c.form} not found`);
    const entries = fill(form, c.over);
    const pathname = pathOf(form.file);

    // The browser half: exactly one beacon, to /api/lead, with every answer.
    const sent = await submitThroughTracking(form, entries, pathname);
    assert.strictEqual(sent.length, 1, 'one beacon per submit');
    assert.strictEqual(sent[0].url, '/api/lead');
    const body = sent[0].body;
    assert.strictEqual(body.source, pathname + (form.id ? ` #${form.id}` : ''));
    assert.ok(!body.hp, 'a person is not flagged as a bot');
    const answers = Object.fromEntries(entries.filter(([k, v]) => k.charAt(0) !== '_' && String(v).trim() !== ''));
    assert.deepStrictEqual(body.fields, answers, 'every answer is sent, no plumbing fields');

    // The server half.
    const e = env();
    const r = await postLead(e, body);
    assert.strictEqual(r.status, 204);
    const rows = sqlite(e._file, 'SELECT * FROM leads');
    assert.strictEqual(rows.length, 1, 'one lead');
    const lead = rows[0];
    assert.strictEqual(lead.status, 'new');
    assert.strictEqual(lead.pipeline, c.pipeline, 'pipeline');
    assert.strictEqual(lead.category, c.category, 'category');
    assert.strictEqual(lead.source, body.source);

    // Nothing dropped: every answer is in fields, and the ones with a column are in it.
    assert.deepStrictEqual(JSON.parse(lead.fields), answers);
    for (const [col, names] of Object.entries(COLUMNS_FROM)) {
      const k = names.find((n) => answers[n] != null);
      assert.strictEqual(lead[col] || '', k ? String(answers[k]).trim() : '', `${col} (from ${k || 'nothing'})`);
    }

    // One alert to us, one confirmation to them, each once.
    assert.strictEqual(r.emails.length, 2, 'two emails');
    const alert = r.emails.find((m) => m.to[0] === NOTIFY);
    const confirm = r.emails.find((m) => m.to[0] === answers.email);
    assert.ok(alert && confirm, 'an alert and a confirmation');
    assert.match(alert.subject, c.pipeline === 'tuning' ? /^NEW TUNING/ : /^NEW REPAIR/);
    assert.ok(confirm.text.includes(`about ${c.about}.`), `confirmation says "${c.about}": ${confirm.text.split('\n')[2]}`);

    // It lands in the seeded table it belongs to, and only that one.
    assert.deepStrictEqual(await tablesHolding(e, lead.id), [c.table]);

    // A double submit is the same lead: no second row, no second emails.
    const again = await postLead(e, body);
    assert.strictEqual(again.status, 204);
    assert.strictEqual(sqlite(e._file, 'SELECT COUNT(*) AS n FROM leads')[0].n, 1);
    assert.strictEqual(again.emails.length, 0);
  });
}

test('a technician referral records the referring tech on the lead, and touches no World Class referral column', async () => {
  const form = ALL_FORMS.find((f) => formKey(f) === 'for-technicians.html#tech-referral-form');
  assert.ok(form && form.afterOk, 'the referral form uses the lead-safe Formspree flow');
  const sent = await submitThroughTracking(form, fill(form, { referring_tech: 'Sam Tuner', tech_phone: '(404) 555-0123' }), '/for-technicians');
  const e = env();
  await postLead(e, sent[0].body);
  const [row] = sqlite(e._file, 'SELECT * FROM leads');
  assert.strictEqual(row.category, 'electronic');
  assert.strictEqual(row.service, 'Technician Referral — Player System');
  assert.strictEqual(JSON.parse(row.fields).referring_tech, 'Sam Tuner');
  assert.strictEqual(JSON.parse(row.fields).tech_phone, '(404) 555-0123');
  // Those columns are outbound referrals to World Class, billed at the $25 fee.
  assert.strictEqual(row.referred_at, null);
  assert.strictEqual(row.referral_status, null);
});

test('the job application still posts to Formspree only, with the role and experience questions', () => {
  const form = ALL_FORMS.find((f) => formKey(f) === 'careers.html#apply-form');
  assert.ok(form, 'careers.html#apply-form');
  assert.strictEqual(form.action, 'https://formspree.io/f/xeebglab');
  assert.ok(form.noAirtable, 'never a CRM lead, never a customer confirmation');
  assert.ok(form.fields.some((x) => x.name === '_gotcha'), 'keeps its honeypot');
  const role = form.fields.find((x) => x.name === 'role');
  assert.deepStrictEqual(role && role.options, ['', 'Lead Responder', 'Piano Tuner', 'Player System Apprentice', 'Other']);
  assert.ok(form.fields.some((x) => x.name === 'experience' && x.type === 'select'));
  assert.ok(!ALL_FORMS.some((f) => f.file === 'index.html' && f.id === 'apply-form'));
});

test('a bot that fills the honeypot is told 204 and nothing is stored or sent', async () => {
  const form = ALL_FORMS.find((f) => formKey(f) === 'tuning.html#tuning-booking-form');
  const entries = fill(form, { _gotcha: 'http://spam.example' });
  const sent = await submitThroughTracking(form, entries, '/tuning');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].body.hp, 1);
  assert.ok(!('_gotcha' in sent[0].body.fields));
  const e = env();
  const r = await postLead(e, sent[0].body);
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.emails.length, 0, 'no alert, no confirmation');
  // Kept, already archived, so a real person caught by autofill can be found
  // in the Archive tab and restored. Never on a working tab, never linked.
  let rows = sqlite(e._file, 'SELECT status, archived_at, notes, contact_id, name FROM leads');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].archived_at, 'archived');
  assert.strictEqual(rows[0].status, 'closed');
  assert.match(rows[0].notes, /spam trap/);
  assert.strictEqual(rows[0].name, 'Pat Tester');
  // A bot posting straight to the endpoint with the field filled in, too.
  const direct = await postLead(e, { source: '/', fields: { name: 'x', email: 'x@spam.example', _gotcha: 'y' } });
  assert.strictEqual(direct.status, 204);
  assert.strictEqual(direct.emails.length, 0);
  rows = sqlite(e._file, 'SELECT archived_at FROM leads');
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((x) => x.archived_at));
});

test('the job application and the photo upload never become leads', async () => {
  for (const key of ['careers.html#apply-form', 'antique-player-piano.html#photo-form']) {
    const form = ALL_FORMS.find((f) => formKey(f) === key);
    assert.ok(form && form.noAirtable, `${key} must carry data-no-airtable`);
    assert.strictEqual((await submitThroughTracking(form, fill(form), pathOf(form.file))).length, 0, key);
  }
});

test('the same person a second time is linked to their contact; a stranger is not', async () => {
  const e = env();
  sqlite(e._file, `INSERT INTO contacts (id, created_at, name, phone_norm, email_norm) VALUES
    (7, 'x', 'Pat Tester', '7705550199', 'pat@example.com'),
    (8, 'x', 'Lee Other', '4045550100', 'lee@example.com')`);
  await postLead(e, { source: '/tuning #tuning-booking-form', fields: { name: 'Pat Tester', email: 'PAT@example.com', phone: '770-555-0199', service_type: 'Piano Tuning' } });
  // Same landline, different person: never merged.
  await postLead(e, { source: '/', fields: { name: 'Sam Different', phone: '(404) 555-0100', message: 'hi' } });
  // Same phone, compatible name: linked.
  await postLead(e, { source: '/', fields: { name: 'Lee', phone: '(404) 555-0100', message: 'again' } });
  // A known phone or email with no name, or a different name, is anyone at all.
  await postLead(e, { source: '/', fields: { phone: '(404) 555-0100', email: 'stranger@example.com', message: 'no name' } });
  await postLead(e, { source: '/', fields: { email: 'pat@example.com', message: 'no name either' } });
  await postLead(e, { source: '/', fields: { name: 'Someone Else', email: 'pat@example.com', message: 'wrong name' } });
  assert.deepStrictEqual(sqlite(e._file, 'SELECT contact_id FROM leads ORDER BY id').map((r) => r.contact_id),
    [7, null, 8, null, null, null]);
});

test('a changed resubmission is a new lead, not a duplicate', async () => {
  const e = env();
  await postLead(e, { source: '/', fields: { name: 'Pat', email: 'p@example.com', message: 'first' } });
  await postLead(e, { source: '/', fields: { name: 'Pat', email: 'p@example.com', message: 'first, and my number is 770 555 0100' } });
  assert.strictEqual(sqlite(e._file, 'SELECT COUNT(*) AS n FROM leads')[0].n, 2);
});

test('a lead is kept even on a database from before the category column', async () => {
  const e = env();
  // Rebuild leads without category, as an unmigrated production database is.
  const cols = sqlite(e._file, "SELECT name FROM pragma_table_info('leads')").map((r) => r.name).filter((n) => n !== 'category');
  sqlite(e._file, `CREATE TABLE l2 AS SELECT ${cols.join(', ')} FROM leads; DROP TABLE leads; ALTER TABLE l2 RENAME TO leads;`);
  const r = await postLead(e, { source: '/player-repair #diagnosis-intake', fields: { name: 'Pat', email: 'p@example.com', system: 'Ampico' } });
  assert.strictEqual(r.status, 204);
  assert.strictEqual(sqlite(e._file, 'SELECT COUNT(*) AS n FROM leads')[0].n, 1);
  assert.strictEqual(r.emails.length, 2);
});

test('photos from the website leave a note on that customer\'s lead', async () => {
  const e = env();
  sqlite(e._file, `INSERT INTO leads (id, created_at, pipeline, status, name, email) VALUES
    (3, '${new Date(Date.now() - 86400000).toISOString()}', 'repair', 'new', 'Pat', 'Pat@Example.com')`);
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0]);
  const fd = new FormData();
  fd.append('email', 'pat@example.com');
  fd.append('photos', new File([JPEG], 'a.jpg', { type: 'image/jpeg' }));
  fd.append('photos', new File([JPEG], 'b.jpg', { type: 'image/jpeg' }));
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const req = new Request('https://pianoplayertech.com/api/photos', { method: 'POST', body: fd,
      headers: { Accept: 'application/json', Origin: 'https://pianoplayertech.com' } });
    const ctx = context(req, e);
    const res = await photosPost(ctx);
    await ctx.settle();
    assert.strictEqual(res.status, 200);
  } finally {
    globalThis.fetch = real;
  }
  const notes = sqlite(e._file, 'SELECT lead_id, type, subject, body, meta FROM activities');
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].lead_id, 3);
  assert.match(notes[0].body, /^2 photos were sent from the website using this lead's email address \(not verified\)/);
  assert.deepStrictEqual(JSON.parse(notes[0].meta), { auto: 'photos' }, 'marked so outreach does not count it');
});

test('every form that posts with fetch shows a refusal instead of a false success', () => {
  for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const posts = (html.match(/fetch\('https:\/\/formspree\.io/g) || []).length;
    if (!posts) continue;
    // Each fetch's first .then looks at res.ok before saying thank you.
    const checked = (html.match(/\.then\(function\s*\(res\)\s*\{[\s\S]{0,400}?if \(res\.ok\)/g) || []).length;
    assert.strictEqual(checked, posts, `${file}: a Formspree fetch shows success without checking res.ok`);
  }
});

async function sendPhotos(e, email) {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0]);
  const fd = new FormData();
  fd.append('email', email);
  fd.append('photos', new File([JPEG], 'a.jpg', { type: 'image/jpeg' }));
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const ctx = context(new Request('https://pianoplayertech.com/api/photos', { method: 'POST', body: fd,
      headers: { Accept: 'application/json', Origin: 'https://pianoplayertech.com' } }), e);
    const res = await photosPost(ctx);
    await ctx.settle();
    return res.status;
  } finally {
    globalThis.fetch = real;
  }
}

test('a photo note needs exactly one recent live lead with that email', async () => {
  const e = env();
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  sqlite(e._file, `INSERT INTO leads (id, created_at, pipeline, status, name, email) VALUES
    (1, '${day(2)}', 'repair', 'new', 'A', 'two@example.com'),
    (2, '${day(3)}', 'repair', 'new', 'B', 'two@example.com'),
    (3, '${day(60)}', 'repair', 'new', 'C', 'old@example.com')`);
  assert.strictEqual(await sendPhotos(e, 'two@example.com'), 200);
  assert.strictEqual(await sendPhotos(e, 'old@example.com'), 200);
  assert.strictEqual(await sendPhotos(e, 'nobody@example.com'), 200);
  assert.strictEqual(sqlite(e._file, 'SELECT COUNT(*) AS n FROM activities')[0].n, 0);
});

test('two identical submits arriving together store one lead and send one pair of emails', async () => {
  const e = env();
  const body = { source: '/piano-repair #repair-form', fields: { name: 'Pat', email: 'p@example.com', issue: 'sticky keys' } };
  const real = globalThis.fetch;
  let emails = 0;
  globalThis.fetch = async () => { emails++; return new Response('{}', { status: 200 }); };
  try {
    const one = () => {
      const ctx = context(new Request('https://pianoplayertech.com/api/lead', { method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://pianoplayertech.com' },
        body: JSON.stringify(body) }), e);
      return leadPost(ctx).then(() => ctx.settle());
    };
    await Promise.all([one(), one()]);
  } finally {
    globalThis.fetch = real;
  }
  assert.strictEqual(sqlite(e._file, 'SELECT COUNT(*) AS n FROM leads')[0].n, 1);
  assert.strictEqual(emails, 2);
  // The check and the write are one statement, which is what makes this
  // hold on D1 too, where the two requests really can interleave.
  const src = fs.readFileSync(path.join(ROOT, 'functions/api/lead.js'), 'utf8');
  assert.match(src, /INSERT INTO leads[\s\S]{0,200}SELECT[\s\S]{0,200}WHERE NOT EXISTS \(SELECT 1 FROM leads WHERE source = \? AND fields = \?/);
  assert.doesNotMatch(src, /SELECT id FROM leads WHERE source = \? AND fields = \?/, 'no separate check-then-insert');
});

test('a form Formspree refuses never reaches the CRM; the corrected resubmit is the one lead', async () => {
  const form = ALL_FORMS.find((f) => formKey(f) === 'piano-repair.html#repair-form');
  assert.ok(form.afterOk);
  for (const status of [422, 400]) {
    const refused = await submitThroughTracking(form, fill(form, { email: 'pat@exmaple' }), '/piano-repair', { formspree: status });
    assert.deepStrictEqual([...refused], [], `${status} sends nothing`);
    assert.strictEqual(refused.how, 'refused');
    assert.match(refused.message, /^email should be an email — please check the form/);
  }
  const ok = await submitThroughTracking(form, fill(form), '/piano-repair');
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(ok.how, 'ok');
  assert.strictEqual(ok[0].body.fields.email, 'pat@example.com');
});

// Formspree failing is exactly when the CRM copy matters: a lead must fail
// everywhere to be lost.
for (const [status, how, says] of [
  [503, 'saved', /reached us, but our form service had a problem/],
  [500, 'saved', /reached us/],
  [429, 'saved', /reached us/],
  [0, 'offline', /could not confirm that went through/]
]) {
  test(`when Formspree answers ${status || 'nothing (network failure)'}, the lead is still stored, and the page says so honestly`, async () => {
    for (const key of ['tuning.html#tuning-booking-form', 'player-repair.html#diagnosis-intake', 'quiz.html#quizLead']) {
      const form = ALL_FORMS.find((f) => formKey(f) === key);
      assert.ok(form.afterOk, key);
      const sent = await submitThroughTracking(form, fill(form), pathOf(form.file), { formspree: status });
      assert.strictEqual(sent.length, 1, `${key}: the CRM copy is sent`);
      assert.strictEqual(sent.how, how);
      assert.match(sent.message, says);
      const e = env();
      assert.strictEqual((await postLead(e, sent[0].body)).status, 204);
      assert.strictEqual(sqlite(e._file, 'SELECT COUNT(*) AS n FROM leads')[0].n, 1, `${key}: stored`);
    }
  });
}

test('every form that posts to Formspree itself hands every outcome to pptAfterFormspree', () => {
  for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const posts = (html.match(/fetch\('https:\/\/formspree\.io/g) || []).length;
    if (!posts) continue;
    assert.ok(formsIn(file).some((f) => f.afterOk), `${file} posts with fetch but sends to the CRM on submit`);
    // Once with the response's status, before res.ok decides anything...
    assert.strictEqual((html.match(/pptAfterFormspree\([A-Za-z]+, res\.status\)/g) || []).length, posts,
      `${file}: the response path does not report Formspree's status`);
    // ...and once from the catch, for no answer at all.
    assert.strictEqual((html.match(/\.catch\(function\s*\((?:err)?\)\s*\{[\s\S]{0,200}?pptAfterFormspree\([A-Za-z]+, 0\)/g) || []).length, posts,
      `${file}: a network failure would lose the CRM copy`);
    assert.doesNotMatch(html, /pptSendLead/, `${file} still calls the old success-only send`);
  }
  const tracking = fs.readFileSync(path.join(ROOT, 'ppt-tracking.js'), 'utf8');
  assert.match(tracking, /var refused = status === 400 \|\| status === 422;/);
});
