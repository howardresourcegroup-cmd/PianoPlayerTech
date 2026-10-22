// One-time import of the old Airtable "Leads" export into the CRM.
//
//   node tools/airtable-import.mjs [input.csv] [output.sql]
//
// Defaults: ~/Downloads/Leads-PPTAll.csv -> ~/Downloads/ppt-airtable-import.sql
//
// This script contains no data. It reads the CSV you point it at and writes a
// SQL file OUTSIDE the repo; the CSV holds real client details and must never
// be committed. It prints counts only, never names, emails or phones.
//
// The SQL it writes is safe to run more than once (see docs/airtable-import.md).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normPhone, normEmail } from '../functions/_lib/dedupe.js';

export const ACTOR = 'airtable-import';

// Airtable status -> CRM status key, and whether the lead is archived.
// Keys are lowercased Airtable values; '' is the blank status.
export const STATUS_MAP = {
  'complete':  { status: 'completed', archived: true },
  'no tune':   { status: 'lost',      archived: true },
  '':          { status: 'new',       archived: true },
  'scheduled': { status: 'booked',    archived: false },
  'in repair': { status: 'in_repair', archived: false },
  'quoted':    { status: 'quoted',    archived: false }
};

// Airtable Type -> pipeline + the service label shown in the CRM.
export const TYPE_MAP = {
  'tuning':                  { pipeline: 'tuning', service: 'Piano Tuning' },
  'player repair':           { pipeline: 'repair', service: 'Player Repair' },
  'digital keyboard repair': { pipeline: 'repair', service: 'Digital Keyboard Repair' },
  'diagnosis':               { pipeline: 'repair', service: 'Diagnosis' },
  'unknown':                 { pipeline: 'repair', service: null }
};

// ------------------------------------------------------------------ CSV

// RFC 4180: quoted fields, "" escapes, embedded newlines. Strips a BOM.
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false, any = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') { q = true; any = true; }
    else if (c === ',') { row.push(cell); cell = ''; any = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      if (any || cell) { row.push(cell); rows.push(row); }
      row = []; cell = ''; any = false;
    } else { cell += c; any = true; }
  }
  if (any || cell) { row.push(cell); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])));
}

// ------------------------------------------------------------------ SQL

// A SQL string literal: quotes doubled, NUL removed (SQLite would truncate at
// it), NULL for empty.
export function sqlStr(v) {
  if (v == null) return 'NULL';
  const s = String(v).replace(/\0/g, '');
  if (s === '') return 'NULL';
  return "'" + s.replace(/'/g, "''") + "'";
}

export const sqlInt = (n) => (Number.isFinite(n) ? String(Math.round(n)) : 'NULL');

// ------------------------------------------------------------------ mapping

// Airtable wraps some phone numbers in invisible direction marks
// (U+200E/F, U+202A-E). They are not digits, but they must not be stored.
const trim = (v) => String(v == null ? '' : v).replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();

// "$1,250.00" -> 125000 cents. NaN unless the whole cell is one plain amount:
// "150 plus 200 parts" is free text and stays in the notes, not in a money column.
export function parseMoneyCents(v) {
  const m = trim(v).match(/^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/);
  return m ? Math.round(parseFloat(m[1].replace(/,/g, '') + (m[2] || '')) * 100) : NaN;
}

// Airtable exports M/D/YYYY (optionally with a time) or ISO. Returns an ISO
// UTC string, or '' when it cannot be read with confidence. Never guesses.
export function parseCreated(v) {
  const s = trim(v);
  if (!s) return '';
  let y, mo, d, h = 0, mi = 0, sec = 0;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    [, y, mo, d] = m; h = +(m[4] || 0); mi = +(m[5] || 0); sec = +(m[6] || 0);
    if (m[7] && m[7].toUpperCase() !== 'Z') {
      const t = Date.parse(s);
      return Number.isFinite(t) ? new Date(t).toISOString() : '';
    }
  } else {
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i);
    if (!m) return '';
    [, mo, d, y] = m; h = +(m[4] || 0); mi = +(m[5] || 0); sec = +(m[6] || 0);
    if (m[7]) h = (h % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  }
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, h, mi, sec));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return '';
  if (+y < 2000 || dt.getTime() > Date.now() + 86400000) return '';
  return dt.toISOString();
}

// Labeled lines for everything that has no column of its own.
const LABELS = [
  ['Message', 'Message'],
  ['No. of Pianos', 'No. of Pianos'],
  ['Type of Piano', 'Type of Piano'],
  ['Details', 'Details'],
  ['Quote Amount', 'Quote Amount'],
  ['Appointment Date and Time', 'Appointment'],
  ['Address', 'Address'],
  ['Assignee', 'Assignee'],
  ['Tuner Paid/Referral Paid', 'Tuner Paid/Referral Paid'],
  ['Attachment Summary', 'Attachment Summary']
];

export function labeledLines(row, skip = []) {
  const out = [];
  for (const [col, label] of LABELS) {
    if (skip.includes(col)) continue;
    const v = trim(row[col]).replace(/\s*\r?\n\s*/g, ' / ');
    if (v) out.push(`${label}: ${v}`);
  }
  return out;
}

// Stable per-row id, built from the row's own content, so regenerating the
// file from the same CSV never changes it. Two byte-identical rows get the
// same id on purpose: the second is a duplicate.
export function rowHash(row) {
  const s = Object.keys(row).sort().map((k) => k + '=' + trim(row[k])).join('\n');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function mapRow(row) {
  const statusKey = trim(row.Status).toLowerCase();
  const typeKey = trim(row.Type).toLowerCase();
  const warnings = [];
  let st = STATUS_MAP[statusKey];
  if (!st) { warnings.push('status'); st = STATUS_MAP['']; }
  let ty = TYPE_MAP[typeKey];
  if (!ty) { if (typeKey) warnings.push('type'); ty = TYPE_MAP.unknown; }
  // A scheduled diagnosis is the CRM's own "Diagnostic Scheduled".
  const status = statusKey === 'scheduled' && typeKey === 'diagnosis' ? 'diag_scheduled' : st.status;

  const created = parseCreated(row.Created);
  if (!created && trim(row.Created)) warnings.push('created');
  const cents = parseMoneyCents(row['Quote Amount']);
  const email = trim(row.Email);
  const phone = trim(row.Phone);
  const src = trim(row.Source);

  return {
    hash: rowHash(row),
    warnings,
    pipeline: ty.pipeline,
    service: ty.service,
    status,
    archived: st.archived,
    name: trim(row.Name) || null,
    email: normEmail(email) || null,
    emailRaw: email,
    phone: phone || null,
    phoneNorm: normPhone(phone),
    address: trim(row.Address) || null,
    system: trim(row['Type of Piano']) || null,
    source: 'Airtable: ' + (src || 'unknown'),
    created,
    quotedCents: Number.isFinite(cents) ? cents : null,
    message: trim(row.Message) || null,
    // Message and Address already have columns; everything else goes here.
    notes: ['Imported from Airtable.', ...labeledLines(row, ['Message', 'Address'])].join('\n'),
    airtableStatus: trim(row.Status),
    airtableType: trim(row.Type),
    activityLines: labeledLines(row)
  };
}

// ------------------------------------------------------------------ SQL gen

// The marker is a JSON key inside leads.fields / activities.meta, so no schema
// change is needed. The hash is hex, so the LIKE pattern has no wildcards or
// quotes in it.
const marker = (h) => sqlStr(`%"airtable_import":"${h}"%`);

// Digits only, last 10, for a column. Mirrors normPhone for the usual ways a
// phone number is typed.
const PHONE_SQL = (col) =>
  `substr(replace(replace(replace(replace(replace(replace(${col}, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), -10)`;

// A lead that was in the CRM before this import with the same normalized email
// or phone. Leads this import created are excluded: two Airtable rows for one
// person are two jobs, and folding a booked job into a note on an old,
// archived one would hide it.
function matchWhere(m) {
  const conds = [];
  if (m.email) conds.push(`lower(trim(l.email)) = ${sqlStr(m.email)}`);
  if (m.phoneNorm) {
    conds.push(`(l.phone IS NOT NULL AND l.phone NOT GLOB '*[A-Za-z]*'` +
      ` AND length(${PHONE_SQL('l.phone')}) = 10 AND ${PHONE_SQL('l.phone')} = ${sqlStr(m.phoneNorm)})`);
  }
  if (!conds.length) return '0';
  return `coalesce(l.fields, '') NOT LIKE '%"airtable_import"%' AND (${conds.join(' OR ')})`;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export function buildRowSql(m) {
  const meta = JSON.stringify({ airtable_import: m.hash });
  const fields = JSON.stringify({
    airtable_import: m.hash, airtable_status: m.airtableStatus, airtable_type: m.airtableType
  });
  const createdSql = m.created ? sqlStr(m.created) : NOW;
  // The purge skips source "Airtable: ..." (functions/_lib/db.js), so the
  // honest import time is safe here.
  const archivedSql = m.archived ? NOW : 'NULL';
  const done = `EXISTS (SELECT 1 FROM leads WHERE fields LIKE ${marker(m.hash)})` +
    ` OR EXISTS (SELECT 1 FROM activities WHERE meta LIKE ${marker(m.hash)})`;
  const match = matchWhere(m);

  // 1. Someone we already hold: leave their lead untouched, add a note.
  const summary = 'Imported from Airtable: status ' + (m.airtableStatus || '(blank)') +
    (m.airtableType ? ', type ' + m.airtableType : '') +
    (m.created ? ', created ' + m.created.slice(0, 10) : '');
  const note =
`INSERT INTO activities (created_at, lead_id, contact_id, type, subject, body, actor, meta)
SELECT ${createdSql}, l.id, l.contact_id, 'note', 'Imported from Airtable',
       ${sqlStr([summary, ...m.activityLines].join('\n'))},
       ${sqlStr(ACTOR)}, ${sqlStr(meta)}
  FROM leads l
 WHERE NOT (${done})
   AND ${match}
 ORDER BY l.id DESC LIMIT 1;`;

  // 2. Otherwise a new lead.
  const lead =
`INSERT INTO leads
  (created_at, updated_at, pipeline, status, name, email, phone, service, system, address,
   message, source, fields, notes, quoted_cents, archived_at)
SELECT ${createdSql}, ${createdSql}, ${sqlStr(m.pipeline)}, ${sqlStr(m.status)}, ${sqlStr(m.name)},
       ${sqlStr(m.email || m.emailRaw)}, ${sqlStr(m.phone)}, ${sqlStr(m.service)}, ${sqlStr(m.system)},
       ${sqlStr(m.address)}, ${sqlStr(m.message)}, ${sqlStr(m.source)}, ${sqlStr(fields)}, ${sqlStr(m.notes)},
       ${sqlInt(m.quotedCents)}, ${archivedSql}
 WHERE NOT (${done})
   AND NOT EXISTS (SELECT 1 FROM leads l WHERE ${match});`;

  // 3. A note on the new lead, stamped "now". The outreach rules treat a note
  //    newer than the lead's last status change as a conversation, and skip
  //    quote check-ins and "tried to reach you" emails after one. That is the
  //    suppression for imported open leads (see docs/airtable-import.md).
  const act =
`INSERT INTO activities (created_at, lead_id, contact_id, type, subject, body, actor, meta)
SELECT ${NOW}, l.id, NULL, 'note', 'Imported from Airtable',
       ${sqlStr(['Imported from Airtable. Original fields:', ...m.activityLines].join('\n'))},
       ${sqlStr(ACTOR)}, ${sqlStr(meta)}
  FROM leads l
 WHERE l.fields LIKE ${marker(m.hash)}
   AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.meta LIKE ${marker(m.hash)});`;

  return [note, lead, act].join('\n');
}

export function buildSql(rows) {
  const mapped = rows.map(mapRow);
  const head = [
    '-- Generated by tools/airtable-import.mjs. One-time Airtable lead import.',
    '-- Safe to re-run: every statement checks for its own marker first.',
    '-- Contains client data. Do not commit or share this file.',
    ''
  ];
  return { sql: head.concat(mapped.map((m) => buildRowSql(m)), ['']).join('\n'), mapped };
}

// ------------------------------------------------------------------ main

export function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const input = args[0] || path.join(os.homedir(), 'Downloads', 'Leads-PPTAll.csv');
  const output = args[1] || path.join(os.homedir(), 'Downloads', 'ppt-airtable-import.sql');
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..') + path.sep;
  if (path.resolve(output).startsWith(repo) || path.resolve(input).startsWith(repo)) {
    console.error('Refusing to read or write client data inside the repo.');
    return 1;
  }
  const rows = parseCsv(fs.readFileSync(input, 'utf8'));
  const { sql, mapped } = buildSql(rows);
  fs.writeFileSync(output, sql, { mode: 0o600 });
  const by = (f) => mapped.reduce((a, m) => { const k = f(m); a[k] = (a[k] || 0) + 1; return a; }, {});
  const n = (f) => mapped.filter(f).length;
  console.log(`Read ${rows.length} rows; wrote ${output}`);
  console.log('open:', n((m) => !m.archived), 'archived:', n((m) => m.archived));
  console.log('by status:', JSON.stringify(by((m) => m.status)));
  console.log('by pipeline:', JSON.stringify(by((m) => m.pipeline)));
  console.log('unreadable Created:', n((m) => m.warnings.includes('created')));
  console.log('unknown Status/Type:', n((m) => m.warnings.includes('status') || m.warnings.includes('type')));
  console.log('no email and no phone:', n((m) => !m.email && !m.phoneNorm));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
