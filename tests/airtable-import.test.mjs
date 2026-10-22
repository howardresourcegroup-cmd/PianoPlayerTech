// The one-time Airtable import. Every fixture here is SYNTHETIC: invented
// people, 555 numbers, example.com addresses. The real export is never
// committed and never read by a test.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCsv, sqlStr, parseCreated, parseMoneyCents, mapRow, rowHash, buildSql, STATUS_MAP
} from '../tools/airtable-import.mjs';
import { DEFAULT_CONFIG, cleanConfig, dueFor } from '../functions/_lib/outreach.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'Name,No. of Pianos,Type of Piano,Type,Status,Tuner Paid/Referral Paid,Email,Source,Message,Phone,Address,Appointment Date and Time,Details,Quote Amount,Assignee,Attachments,Attachment Summary,Created';

const row = (o = {}) => ({
  Name: 'Pat Example', 'No. of Pianos': '1', 'Type of Piano': 'Baldwin upright', Type: 'Tuning',
  Status: 'Complete', 'Tuner Paid/Referral Paid': 'checked', Email: 'Pat@Example.com', Source: 'Google',
  Message: "It's flat", Phone: '(555) 010-0101', Address: '1 Test Rd', 'Appointment Date and Time': '3/4/2025 2:30pm',
  Details: 'Bench broken', 'Quote Amount': '$1,250.00', Assignee: 'Sam Tech', Attachments: '', 'Attachment Summary': '',
  Created: '3/1/2025 9:05am', ...o
});

test('parseCsv: BOM, quoted commas, doubled quotes, embedded newlines, CRLF', () => {
  const csv = '﻿' + HEAD.split(',').slice(0, 3).join(',') + '\r\n' +
    '"Lee, Ann","say ""hi""","a\nb"\r\n,,\r\nBob,1,2\r\n';
  const rows = parseCsv(csv);
  assert.strictEqual(rows.length, 2); // the all-empty line is dropped
  assert.strictEqual(rows[0].Name, 'Lee, Ann');
  assert.strictEqual(rows[0]['No. of Pianos'], 'say "hi"');
  assert.strictEqual(rows[0]['Type of Piano'], 'a\nb');
  assert.strictEqual(rows[1].Name, 'Bob');
});

test('sqlStr: doubles quotes, strips NUL, empty is NULL, injection stays inside the literal', () => {
  assert.strictEqual(sqlStr("O'Brien"), "'O''Brien'");
  assert.strictEqual(sqlStr(''), 'NULL');
  assert.strictEqual(sqlStr(null), 'NULL');
  assert.strictEqual(sqlStr('a\0b'), "'ab'");
  assert.strictEqual(sqlStr("x'); DROP TABLE leads;--"), "'x''); DROP TABLE leads;--'");
});

test('status mapping: the six Airtable statuses', () => {
  const s = (Status, Type = 'Tuning') => { const m = mapRow(row({ Status, Type })); return [m.status, m.archived]; };
  assert.deepStrictEqual(s('Complete'), ['completed', true]);
  assert.deepStrictEqual(s('No Tune'), ['lost', true]);
  assert.deepStrictEqual(s(''), ['new', true]);
  assert.deepStrictEqual(s('Scheduled'), ['booked', false]);
  assert.deepStrictEqual(s('Scheduled', 'Diagnosis'), ['diag_scheduled', false]);
  assert.deepStrictEqual(s('In Repair'), ['in_repair', false]);
  assert.deepStrictEqual(s('Quoted'), ['quoted', false]);
  // Unknown values fall back to the safe archived 'new', and say so.
  const odd = mapRow(row({ Status: 'Mystery' }));
  assert.deepStrictEqual([odd.status, odd.archived, odd.warnings], ['new', true, ['status']]);
});

test('every mapped status key exists in the schema statuses table', () => {
  const schema = fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8');
  for (const k of [...Object.values(STATUS_MAP).map((v) => v.status), 'diag_scheduled']) {
    assert.ok(schema.includes(`('${k}',`), `status ${k} not in schema.sql`);
  }
});

test('type mapping, source tag, normalization', () => {
  assert.deepStrictEqual(
    ['Tuning', 'Player Repair', 'Digital Keyboard Repair', 'Diagnosis', 'Unknown', ''].map((t) => mapRow(row({ Type: t })).pipeline),
    ['tuning', 'repair', 'repair', 'repair', 'repair', 'repair']);
  const m = mapRow(row({ Phone: '‪(555) 010-0101‬' }));
  assert.strictEqual(m.email, 'pat@example.com');
  assert.strictEqual(m.phone, '(555) 010-0101');
  assert.strictEqual(m.phoneNorm, '5550100101');
  assert.strictEqual(m.source, 'Airtable: Google');
  assert.strictEqual(mapRow(row({ Source: '' })).source, 'Airtable: unknown');
  assert.strictEqual(m.system, 'Baldwin upright');
});

test('dates and money', () => {
  assert.strictEqual(parseCreated('3/1/2025 9:05am'), '2025-03-01T09:05:00.000Z');
  assert.strictEqual(parseCreated('12/31/2024 12:00am'), '2024-12-31T00:00:00.000Z');
  assert.strictEqual(parseCreated('12/31/2024 12:30pm'), '2024-12-31T12:30:00.000Z');
  assert.strictEqual(parseCreated('2025-03-01'), '2025-03-01T00:00:00.000Z');
  assert.strictEqual(parseCreated('13/45/2025 9:05am'), '');
  assert.strictEqual(parseCreated('garbage'), '');
  assert.strictEqual(parseCreated('1/1/2999 9:00am'), '');
  assert.strictEqual(parseMoneyCents('$1,250.00'), 125000);
  assert.strictEqual(parseMoneyCents('150'), 15000);
  assert.ok(Number.isNaN(parseMoneyCents('150 plus 200 parts')));
  assert.ok(Number.isNaN(parseMoneyCents('')));
});

test('labeled lines carry the fields that have no column', () => {
  const m = mapRow(row());
  for (const want of ['No. of Pianos: 1', 'Type of Piano: Baldwin upright', 'Details: Bench broken',
    'Quote Amount: $1,250.00', 'Appointment: 3/4/2025 2:30pm', 'Assignee: Sam Tech', 'Tuner Paid/Referral Paid: checked']) {
    assert.ok(m.notes.includes(want), want);
  }
  assert.strictEqual(m.message, "It's flat");
  assert.strictEqual(m.quotedCents, 125000);
});

test('rowHash is stable and content-sensitive', () => {
  assert.strictEqual(rowHash(row()), rowHash(row()));
  assert.notStrictEqual(rowHash(row()), rowHash(row({ Details: 'other' })));
});

// ---------------------------------------------------------------- real SQLite

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-at-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8') });
  return file;
}
const run = (db, sql) => execFileSync('sqlite3', [db], { input: sql, encoding: 'utf8' });
const q = (db, sql) => execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();

const FIXTURE = [
  row({ Name: "Pat O'Example", Email: 'PAT@example.com', Phone: '', Status: 'Complete' }),                       // matches existing by email
  row({ Name: 'Quinn Sample', Email: '', Phone: '555.010.0202', Status: 'Scheduled' }),                          // matches existing by phone
  row({ Name: 'Rae New', Email: 'rae@example.com', Phone: '(555) 010-0303', Status: 'Quoted', Type: 'Player Repair', Created: '9/9/2026 10:00am' }),
  row({ Name: 'Rae New', Email: 'rae@example.com', Phone: '(555) 010-0303', Status: '', Created: '1/2/2024 10:00am' }), // same person twice: two jobs, two leads
  row({ Name: 'Sid Blank', Email: '', Phone: '', Status: 'No Tune', Created: 'not a date' })
];

test('SQL: creates, merges, never touches existing leads, writes only leads and activities', () => {
  const db = freshDb();
  run(db, `INSERT INTO leads (created_at, pipeline, status, name, email, phone, notes) VALUES
    ('2025-01-01T00:00:00Z','repair','new','Existing Pat','  pat@EXAMPLE.com ',NULL,'keep me'),
    ('2025-01-02T00:00:00Z','tuning','quoted','Existing Quinn',NULL,'(555) 010-0202',NULL);`);
  const before = q(db, 'SELECT * FROM leads WHERE id <= 2');
  const { sql } = buildSql(FIXTURE);
  run(db, sql);

  assert.strictEqual(q(db, 'SELECT * FROM leads WHERE id <= 2'), before, 'existing leads must be unchanged');
  assert.strictEqual(q(db, "SELECT count(*) FROM leads WHERE fields LIKE '%airtable_import%'"), '3');
  assert.strictEqual(q(db, "SELECT count(*) FROM leads WHERE fields LIKE '%airtable_import%' AND archived_at IS NULL"), '1');
  // Notes on the two existing leads, one each.
  assert.strictEqual(q(db, "SELECT lead_id || ':' || count(*) FROM activities WHERE lead_id <= 2 GROUP BY lead_id ORDER BY lead_id"), '1:1\n2:1');
  assert.ok(q(db, 'SELECT body FROM activities WHERE lead_id = 1').startsWith('Imported from Airtable:'));
  // Both Rae rows are kept as their own jobs.
  assert.strictEqual(q(db, "SELECT count(*) FROM leads WHERE email = 'rae@example.com'"), '2');
  // Original Created date is used when parseable; otherwise import time.
  assert.strictEqual(q(db, "SELECT created_at FROM leads WHERE name = 'Rae New' AND status = 'quoted'"), '2026-09-09T10:00:00.000Z');
  assert.ok(q(db, "SELECT created_at FROM leads WHERE name = 'Sid Blank'").startsWith('20'));
  // Archived leads outlive the 30-day purge by default.
  assert.ok(q(db, "SELECT archived_at FROM leads WHERE name = 'Sid Blank'") > '2030');
  assert.strictEqual(q(db, "SELECT status || '/' || pipeline || '/' || source FROM leads WHERE name = 'Rae New' AND status = 'quoted'"), 'quoted/repair/Airtable: Google');
  // Side effects: nothing but leads and activities.
  for (const t of ['outreach', 'unsubscribes', 'invoices', 'payments', 'people', 'contacts', 'settings']) {
    assert.strictEqual(q(db, `SELECT count(*) FROM ${t}`), '0', t);
  }
});

test('SQL: running it twice creates nothing', () => {
  const db = freshDb();
  run(db, "INSERT INTO leads (created_at, pipeline, status, email) VALUES ('2025-01-01T00:00:00Z','repair','new','pat@example.com');");
  const { sql } = buildSql(FIXTURE);
  run(db, sql);
  const snap = () => q(db, 'SELECT (SELECT count(*) FROM leads) || "/" || (SELECT count(*) FROM activities)');
  const once = snap();
  run(db, sql);
  run(db, buildSql(FIXTURE).sql); // regenerated from the same CSV: same markers
  assert.strictEqual(snap(), once);
});

test('SQL: --purge-archived opts back into the normal 30-day clock', () => {
  const db = freshDb();
  run(db, buildSql([row({ Status: '' })], { purgeArchived: true }).sql);
  assert.ok(q(db, 'SELECT archived_at FROM leads') < '2030');
});

test('SQL: hostile cell values stay data', () => {
  const db = freshDb();
  run(db, buildSql([row({ Name: "x'); DROP TABLE leads;--", Message: "a'b\"c;\n-- d" })]).sql);
  assert.strictEqual(q(db, 'SELECT name FROM leads'), "x'); DROP TABLE leads;--");
  assert.strictEqual(q(db, 'SELECT count(*) FROM leads'), '1');
});

test('imported open leads qualify for no automated email', () => {
  const db = freshDb();
  // Quoted 5 days ago: exactly the case where a quote check-in would draft.
  const recent = new Date(Date.now() - 5 * 86400000);
  const created = `${recent.getUTCMonth() + 1}/${recent.getUTCDate()}/${recent.getUTCFullYear()} 9:00am`;
  run(db, buildSql([row({ Status: 'Quoted', Created: created, Email: 'q@example.com' })]).sql);
  const lead = JSON.parse(q(db, "SELECT json_object('status',status,'pipeline',pipeline,'email',email,'updated_at',updated_at,'archived_at',archived_at,'referral_status',referral_status,'scheduled_at',scheduled_at,'referred_at',referred_at) FROM leads"));
  const cfg = cleanConfig(DEFAULT_CONFIG);
  const now = new Date().toISOString();
  // Without the import note this lead would get a draft...
  assert.deepStrictEqual(dueFor(lead, { statusAt: {}, lastTouchAt: '' }, cfg, now).map((d) => d.kind), ['quote_checkin']);
  // ...and the note the import writes is a touch the outreach rules respect.
  const note = JSON.parse(q(db, "SELECT json_object('type',type,'created_at',created_at,'meta',meta) FROM activities"));
  assert.strictEqual(note.type, 'note');
  assert.ok(!JSON.parse(note.meta).outreach);
  assert.deepStrictEqual(dueFor(lead, { statusAt: {}, lastTouchAt: note.created_at }, cfg, now), []);
  // Archived imports are excluded by the rules outright.
  const archivedDb = freshDb();
  run(archivedDb, buildSql([row({ Status: 'Complete', Created: created })]).sql);
  const done = JSON.parse(q(archivedDb, "SELECT json_object('status',status,'pipeline',pipeline,'email',email,'updated_at',updated_at,'archived_at',archived_at) FROM leads"));
  assert.ok(done.archived_at);
  assert.deepStrictEqual(dueFor(done, { statusAt: {}, lastTouchAt: '' }, cfg, now), []);
});
