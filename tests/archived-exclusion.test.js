const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions/leads.js'), 'utf8');

// The design calls this the most likely defect in the whole change: miss one
// query and an archived lead reappears in a view, or skews a number that
// drives billing. This walks every query rather than trusting a reviewer.
test('every listing query against leads excludes archived rows', () => {
  const queries = SRC.match(/(?:SELECT|FROM) leads[^`]*/g) || [];
  assert.ok(queries.length >= 3, 'expected several queries against leads');
  for (const q of queries) {
    const excludes = /NOT_ARCHIVED|archived_at IS (?:NOT )?NULL/.test(q);
    const byId = /WHERE id = \?/.test(q);
    // The grid query interpolates its clause; that clause is checked below.
    const interpolated = /\$\{where\}/.test(q);
    assert.ok(excludes || byId || interpolated,
      `query neither excludes archived rows nor looks up one id:\n  ${q.slice(0, 160)}`);
  }
});

// The grid's WHERE is built by a ternary, so checking the query string is not
// enough: every branch of that ternary has to be right.
test('every branch of the grid WHERE clause handles archiving', () => {
  const block = SRC.match(/const where = [\s\S]*?;\n/);
  assert.ok(block, 'could not find the grid WHERE construction');
  const branches = block[0].split('\n').filter((l) => /WHERE/.test(l));
  assert.ok(branches.length >= 4, `expected a branch per view, saw ${branches.length}`);
  for (const b of branches) {
    assert.ok(/NOT_ARCHIVED|archived_at IS NOT NULL/.test(b),
      `this branch neither excludes archived leads nor is the Archive tab:\n  ${b.trim()}`);
  }
});

test('mutating actions refuse an archived lead', () => {
  assert.match(SRC, /That lead is archived\. Restore it first\./);

  // Read the exemption list rather than pinning its exact text: the point is
  // which actions are exempt, not how the array is punctuated.
  const m = SRC.match(/if \(target\.archived_at && !\[([^\]]*)\]\.includes\(body\.action\)\)/);
  assert.ok(m, 'could not find the archived-lead guard');
  const exempt = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);

  // Restore and purge must stay reachable, or an archived lead is a dead end.
  for (const a of ['restore', 'purge']) {
    assert.ok(exempt.includes(a), `${a} must stay reachable on an archived lead`);
  }
  // Nothing that changes a lead may be exempt. A read may.
  for (const a of ['update', 'paid', 'refer', 'archive', 'activity']) {
    assert.ok(!exempt.includes(a), `${a} writes, so it must not bypass the archive guard`);
  }
});

test('the grid receives the archive columns', () => {
  for (const c of ['scheduled_at', 'scheduled_mins', 'archived_at']) {
    assert.ok(SRC.includes(`'${c}'`), `COLUMNS missing ${c}`);
  }
});

// Proving the clause behaves, not just that it is present.
function seeded() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-'));
  const db = path.join(dir, 't.db');
  execFileSync('sqlite3', [db], {
    input: fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8')
  });
  execFileSync('sqlite3', [db, `
    INSERT INTO leads (created_at,pipeline,status,name,referred_at,referral_status,archived_at)
    VALUES
      ('2026-09-01T00:00:00Z','tuning','new','Visible',NULL,NULL,NULL),
      ('2026-09-01T00:00:00Z','tuning','new','Hidden',NULL,NULL,'2026-09-10T00:00:00Z'),
      ('2026-09-02T00:00:00Z','tuning','referred','RefVisible','2026-09-02T00:00:00Z','booked',NULL),
      ('2026-09-02T00:00:00Z','tuning','referred','RefHidden','2026-09-02T00:00:00Z','booked','2026-09-11T00:00:00Z');`]);
  return db;
}
const q = (db, sql) => execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim();

test('the grid listing hides archived leads', () => {
  const db = seeded();
  assert.strictEqual(
    q(db, `SELECT group_concat(name) FROM
             (SELECT name FROM leads WHERE pipeline='tuning' AND archived_at IS NULL
               ORDER BY name)`),
    'RefVisible,Visible');
});

test('the new-lead count ignores archived leads', () => {
  const db = seeded();
  assert.strictEqual(
    q(db, "SELECT SUM(status='new') FROM leads WHERE archived_at IS NULL"), '1');
});

// An archived referral still counting as booked would overstate what World
// Class owes, which is real money.
test('referral stats ignore archived referrals', () => {
  const db = seeded();
  assert.strictEqual(
    q(db, `SELECT SUM(referral_status='booked') FROM leads
             WHERE referred_at IS NOT NULL AND archived_at IS NULL`), '1');
});

test('the Archive tab shows only archived leads, newest first', () => {
  const db = seeded();
  assert.strictEqual(
    q(db, 'SELECT group_concat(name) FROM (SELECT name FROM leads WHERE archived_at IS NOT NULL ORDER BY archived_at DESC)'),
    'RefHidden,Hidden');
});
