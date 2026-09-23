// CSV export.
//
// A spreadsheet is where this data goes to be read by a human and, more
// importantly, by an accountant. The escaping rules are not cosmetic: a
// comma in an address silently shifts every later column, and a name that
// starts with '=' is executed by Excel.

import test from 'node:test';
import assert from 'node:assert';
import { csvCell, toCsv, EXPORT_COLUMNS } from '../crm/export.js';

test('an ordinary value is written as-is', () => {
  assert.strictEqual(csvCell('Dana Whitfield'), 'Dana Whitfield');
  assert.strictEqual(csvCell(42), '42');
});

test('nothing becomes empty, not the word null', () => {
  assert.strictEqual(csvCell(null), '');
  assert.strictEqual(csvCell(undefined), '');
});

// The one that silently corrupts a spreadsheet rather than failing loudly.
test('a comma is quoted, so later columns do not shift', () => {
  assert.strictEqual(csvCell('88 Peachtree Ln, Marietta, GA'), '"88 Peachtree Ln, Marietta, GA"');
});

test('a quote is doubled and the cell is quoted', () => {
  assert.strictEqual(csvCell('He said "no"'), '"He said ""no"""');
});

test('a newline is quoted, so one lead stays one row', () => {
  assert.strictEqual(csvCell('line one\nline two'), '"line one\nline two"');
  assert.strictEqual(csvCell('line one\r\nline two'), '"line one\r\nline two"');
});

// Excel and Sheets execute a cell starting with =, +, - or @.
test('a formula-looking value is neutralised', () => {
  assert.strictEqual(csvCell('=1+1'), "'=1+1");
  assert.strictEqual(csvCell('=HYPERLINK("http://evil","click")'),
    '"\'=HYPERLINK(""http://evil"",""click"")"');
  assert.strictEqual(csvCell('+1 770 555 0142'), "'+1 770 555 0142");
  assert.strictEqual(csvCell('-5'), "'-5");
  assert.strictEqual(csvCell('@handle'), "'@handle");
});

test('a value that merely contains = is left alone', () => {
  assert.strictEqual(csvCell('a=b'), 'a=b');
});

test('a file has a header row and CRLF endings', () => {
  const csv = toCsv([{ id: 1, name: 'Dana' }], ['id', 'name']);
  assert.strictEqual(csv, 'id,name\r\n1,Dana\r\n');
});

test('an empty list still produces a usable header', () => {
  assert.strictEqual(toCsv([], ['id', 'name']), 'id,name\r\n');
});

test('a missing field becomes an empty cell, keeping the columns aligned', () => {
  const csv = toCsv([{ id: 1 }], ['id', 'name', 'city']);
  assert.strictEqual(csv, 'id,name,city\r\n1,,\r\n');
});

test('the export carries the fields an accountant would ask for', () => {
  for (const c of ['id', 'created_at', 'name', 'phone', 'email', 'status',
                   'referral_status', 'referral_paid_at', 'referral_invoice_id']) {
    assert.ok(EXPORT_COLUMNS.includes(c), `missing ${c}`);
  }
});
