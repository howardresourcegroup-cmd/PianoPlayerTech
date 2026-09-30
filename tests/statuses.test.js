// The status vocabulary, and the migration that reshapes it.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIGRATION = 'db/2026-09-30-statuses-and-customer-type.sql';

function dbFrom(sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-st-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], { input: sql });
  return file;
}
const run = (file, sql) => execFileSync('sqlite3', [file, sql], { encoding: 'utf8' }).trim();
const keys = (file) => run(file, 'SELECT key FROM statuses ORDER BY sort').split('\n');

const WANT = ['new', 'needs_contact', 'waiting', 'diag_scheduled', 'diagnosis', 'quoted', 'referred',
  'booked', 'in_repair', 'completed', 'invoiced', 'paid', 'closed', 'lost'];

test('a fresh database has the agreed statuses in the agreed order, and a customer type column', () => {
  const db = dbFrom(fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8'));
  assert.deepStrictEqual(keys(db), WANT);
  const cols = run(db, "SELECT name FROM pragma_table_info('leads')").split('\n');
  assert.ok(cols.includes('customer_type'));
});

test('the migration takes the old vocabulary to the new one without losing a lead', () => {
  // The schema as it was before this change, from git, so the test keeps
  // proving the migration works on what production actually has.
  const old = execFileSync('git', ['show', 'ec16f25:db/schema.sql'], { cwd: ROOT, encoding: 'utf8' });
  const db = dbFrom(old);
  run(db, `INSERT INTO leads (id, created_at, pipeline, status) VALUES
    (1,'2026-01-01','repair','scheduled'), (2,'2026-01-01','repair','contacted'), (3,'2026-01-01','tuning','closed')`);
  execFileSync('sqlite3', [db], { input: fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8') });
  assert.deepStrictEqual(keys(db), WANT);
  assert.strictEqual(run(db, 'SELECT status FROM leads WHERE id = 1'), 'booked');
  assert.strictEqual(run(db, 'SELECT status FROM leads WHERE id = 2'), 'waiting');
  assert.strictEqual(run(db, 'SELECT COUNT(*) FROM leads'), '3');
  const cols = run(db, "SELECT name FROM pragma_table_info('leads')").split('\n');
  assert.ok(cols.includes('customer_type'));
});
