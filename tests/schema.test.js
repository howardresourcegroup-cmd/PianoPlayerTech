const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function freshDb(sqlFile = 'db/schema.sql') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-'));
  const file = path.join(dir, 't.db');
  execFileSync('sqlite3', [file], {
    input: fs.readFileSync(path.join(ROOT, sqlFile), 'utf8')
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
  assert.strictEqual(
    query(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"),
    'settings'
  );
});

test('schema.sql creates the indexes the new queries need', () => {
  const db = freshDb();
  const idx = query(db, "SELECT name FROM sqlite_master WHERE type='index'").split('\n');
  assert.ok(idx.includes('idx_leads_scheduled'), 'idx_leads_scheduled missing');
  assert.ok(idx.includes('idx_leads_archived'), 'idx_leads_archived missing');
});

test('the new columns are nullable, so existing rows survive', () => {
  const db = freshDb();
  execFileSync('sqlite3', [db,
    "INSERT INTO leads (created_at,pipeline,status,name) " +
    "VALUES ('2026-09-01T00:00:00Z','tuning','new','Existing row')"]);
  assert.strictEqual(
    query(db, "SELECT archived_at IS NULL AND scheduled_at IS NULL FROM leads"),
    '1'
  );
});

test('the migration file is safe to run twice', () => {
  const db = freshDb();
  const sql = fs.readFileSync(
    path.join(ROOT, 'db/2026-09-22-add-scheduling-and-archive.sql'), 'utf8');
  execFileSync('sqlite3', [db], { input: sql });
  execFileSync('sqlite3', [db], { input: sql });
  assert.strictEqual(
    query(db, "SELECT count(*) FROM sqlite_master WHERE name='settings'"), '1');
});

test('the migration brings a pre-2026-09-22 database up to date', () => {
  // A database created before today: the three columns do not exist yet.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-old-'));
  const db = path.join(dir, 'old.db');
  execFileSync('sqlite3', [db], { input: `
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
      pipeline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', name TEXT);
    INSERT INTO leads (created_at,pipeline,status,name)
      VALUES ('2026-09-01T00:00:00Z','tuning','new','Before the migration');` });

  for (const alter of [
    'ALTER TABLE leads ADD COLUMN scheduled_at TEXT',
    'ALTER TABLE leads ADD COLUMN scheduled_mins INTEGER',
    'ALTER TABLE leads ADD COLUMN archived_at TEXT'
  ]) execFileSync('sqlite3', [db, alter]);

  execFileSync('sqlite3', [db], {
    input: fs.readFileSync(
      path.join(ROOT, 'db/2026-09-22-add-scheduling-and-archive.sql'), 'utf8')
  });

  const cols = query(db, "SELECT name FROM pragma_table_info('leads')").split('\n');
  for (const c of ['scheduled_at', 'scheduled_mins', 'archived_at']) {
    assert.ok(cols.includes(c), `leads.${c} missing after migration`);
  }
  // The existing row is untouched.
  assert.strictEqual(query(db, 'SELECT name FROM leads'), 'Before the migration');
});

test('a second ALTER reports duplicate column, which means already-applied', () => {
  const db = freshDb();
  assert.throws(
    () => execFileSync('sqlite3', [db, 'ALTER TABLE leads ADD COLUMN archived_at TEXT'],
      { stdio: 'pipe' }),
    /duplicate column name/i
  );
});
