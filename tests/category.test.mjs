// What kind of work a lead is, and the backfill that sets it on old leads.
//
// The expensive mistake is a wrong "pneumatic" (an electronic job filed on
// the wrong list) or a wrong "electronic", so the cases below lean on the
// ambiguous ones, and the backfill is held to never disagreeing with the
// classifier: it may leave more blank, never something different.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCategory, pagePath, CATEGORIES } from '../functions/_lib/category.js';
import { ROOT, sqlite } from './fixtures/harness.mjs';

const c = (lead, extra) => classifyCategory({ pipeline: 'repair', ...lead }, extra);

test('the page path ignores .html, a trailing slash, the form id and a query', () => {
  assert.strictEqual(pagePath('/player-repair.html #diagnosis-intake'), '/player-repair');
  assert.strictEqual(pagePath('/tuning/?x=1'), '/tuning');
  assert.strictEqual(pagePath(''), '/');
  assert.strictEqual(pagePath('Airtable: Website'), 'airtable: website');
});

test('"Player Repair" alone does not say pneumatic', () => {
  // The four pages that send service_type "Player Repair":
  assert.strictEqual(c({ service: 'Player Repair', source: '/antique-player-piano' }), 'pneumatic');
  assert.strictEqual(c({ service: 'Player Repair', source: '/disklavier-power-supply-repair' }), 'electronic');
  assert.strictEqual(c({ service: 'Player Repair', source: '/player-unit-mail-in-repair' }), 'electronic');
  assert.strictEqual(c({ service: 'Player Repair', source: '/for-technicians' }), 'electronic');
  // And from Airtable, with nothing else to go on:
  assert.strictEqual(c({ service: 'Player Repair', source: 'Airtable: Website' }), null);
});

test('what the customer wrote beats the page', () => {
  assert.strictEqual(c({ source: '/player-repair #diagnosis-intake', system: 'Ampico reproducing grand' }), 'pneumatic');
  assert.strictEqual(c({ source: '/', message: 'Old player with paper rolls, the bellows leak' }), 'pneumatic');
  assert.strictEqual(c({ source: '/', system: 'Duo-Art' }), 'pneumatic');
  assert.strictEqual(c({ source: '/', message: 'Our Disklavier will not power on' }), 'electronic');
  assert.strictEqual(c({ source: '/', system: 'QRS Pianomation' }), 'electronic');
  assert.strictEqual(c({ source: 'Airtable: Website', service: 'Player Repair', system: 'Welte-Mignon' }), 'pneumatic');
});

test('both kinds named, or a contradiction with the page, stays blank', () => {
  assert.strictEqual(c({ source: '/', system: 'Ampico, and a Disklavier upstairs' }), null);
  assert.strictEqual(c({ source: '/antique-player-piano', system: 'Disklavier' }), null);
  // QRS also makes paper rolls, so "QRS" on the antique page is rolls.
  assert.strictEqual(c({ source: '/antique-player-piano', message: 'we have QRS rolls' }), 'pneumatic');
});

test('ordinary words that only look like player words do not count', () => {
  assert.strictEqual(c({ source: '/', message: 'Humidity got to it' }), null, '"humidity" contains "midi"');
  assert.strictEqual(c({ source: '/', system: 'Aeolian spinet' }), null, 'Aeolian made ordinary pianos too');
  assert.strictEqual(c({ source: '/', system: 'Gulbransen' }), null);
});

test('tuning is tuning, a teacher partner is nothing, cleaning is acoustic', () => {
  assert.strictEqual(classifyCategory({ pipeline: 'tuning', source: '/tuning', message: 'player piano' }), 'tuning');
  assert.strictEqual(classifyCategory({ pipeline: 'tuning', source: '/piano-teachers #teacher-form', service: 'Teacher Referral Partner' }), null);
  assert.strictEqual(c({ source: '/piano-cleaning #detailing-form', service: 'Piano Detailing' }), 'acoustic');
  assert.strictEqual(c({ source: '/piano-repair #repair-form', service: 'Piano Repair' }), 'acoustic');
  assert.strictEqual(c({ source: '/quiz #quizLead', service: 'In-home assessment' }), 'acoustic');
  assert.strictEqual(c({ source: '/' }), null);
});

test('the answer is always one of the categories, or blank', () => {
  for (const src of ['/', '/antique-player-piano', '/player-repair', '/piano-repair', 'Airtable: x']) {
    for (const sys of ['', 'Ampico', 'Disklavier', 'Steinway']) {
      const v = c({ source: src, system: sys });
      assert.ok(v === null || CATEGORIES.includes(v), `${src} ${sys} -> ${v}`);
    }
  }
});

// The migration's backfill is SQL, not this function. It may be more
// cautious, but where it sets a value it must be the classifier's value.
test('the backfill never disagrees with the classifier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-cat-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: execFileSync('git', ['show', '43ba200:db/schema.sql'], { cwd: ROOT, encoding: 'utf8' }) });
  const sources = ['/', '/antique-player-piano #', '/player-repair #diagnosis-intake', '/disklavier-repair',
    '/piano-cleaning #detailing-form', '/piano-repair #repair-form', '/tuning #tuning-booking-form',
    '/piano-teachers #teacher-form', 'Airtable: Website', '/quiz #quizLead'];
  const services = ['', 'Player Repair', 'Piano Tuning', 'Piano Detailing', 'Piano Repair', 'Teacher Referral Partner', 'Diagnosis'];
  const systems = ['', 'Ampico grand', 'Disklavier DKC-850', 'QRS', 'Yamaha U1', 'Ampico + Disklavier', 'paper rolls'];
  const leads = [];
  for (const source of sources) for (const service of services) for (const system of systems) {
    const pipeline = /tuning|teacher/i.test(service + source) ? 'tuning' : 'repair';
    leads.push({ pipeline, source, service, system, message: '' });
  }
  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
  sqlite(file, leads.map((l, i) => `INSERT INTO leads (id, created_at, pipeline, status, service, system, message, source, fields)
    VALUES (${i + 1}, 'x', ${lit(l.pipeline)}, 'new', ${lit(l.service)}, ${lit(l.system)}, '', ${lit(l.source)}, '{}')`).join(';'));
  execFileSync('sqlite3', ['-bail', file], { input: fs.readFileSync(path.join(ROOT, 'db/2026-10-23-custom-tables.sql'), 'utf8') });
  const got = sqlite(file, 'SELECT id, category FROM leads ORDER BY id');
  let set = 0;
  for (const r of got) {
    const l = leads[r.id - 1];
    if (r.category == null) continue;
    set++;
    assert.strictEqual(r.category, classifyCategory(l), `backfill set ${r.category} on ${JSON.stringify(l)}`);
  }
  assert.ok(set > leads.length / 2, `the backfill should decide most of these (${set}/${leads.length})`);
});
