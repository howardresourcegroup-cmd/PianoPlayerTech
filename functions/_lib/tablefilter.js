// The filter behind a custom table, and the SQL it becomes.
//
// A table is the owner's own tab: "every open pneumatic job", "tunings from
// Marietta this month". Its filter arrives from the browser as JSON, and this
// file is the only thing that turns it into SQL. Three rules make that safe:
//
//   1. Fields and operators are whitelisted. A field or operator that is not
//      listed below is refused with a message (the caller answers 400), never
//      ignored: a filter that silently drops a rule shows more than the owner
//      asked for, which on a shared screen is a leak, not a convenience.
//   2. Column names in the SQL come only from this file's constants. Nothing
//      the browser sends is ever spliced into a statement.
//   3. Every value is a bound parameter.
//
// Filters run on the server, where the tab's rows are fetched, so a role sees
// exactly the rows the table selects and nothing it would then have to hide.

import { CATEGORIES } from './category.js';
import { PIPELINES, CUSTOMER_TYPES } from './newlead.js';

export class FilterError extends Error {}

// params: D1 refuses a statement with more than 100 bound parameters, and
// SQLite (what the tests run) allows thousands, so the cap is checked here,
// at save time, with headroom for anything the query itself binds.
export const LIMITS = { rules: 20, values: 20, text: 200, name: 60, columns: 24, tables: 30, params: 90 };

// Lead text the "search" rule looks through.
const SEARCH_COLS = ['name', 'email', 'phone', 'city', 'address', 'system', 'service', 'message', 'notes'];

// field -> { type, col }. `col` is a literal column name, and the only place
// one comes from.
export const FIELDS = {
  service:       { type: 'text',   col: 'service',       label: 'Service / type' },
  pipeline:      { type: 'enum',   col: 'pipeline',      label: 'Pipeline', values: PIPELINES },
  category:      { type: 'enum',   col: 'category',      label: 'Category', values: CATEGORIES },
  status:        { type: 'status', col: 'status',        label: 'Status' },
  source:        { type: 'text',   col: 'source',        label: 'Source (page or import)' },
  assigned_to:   { type: 'person', col: 'assigned_to',   label: 'Assignee' },
  city:          { type: 'text',   col: 'city',          label: 'City' },
  system:        { type: 'text',   col: 'system',        label: 'Piano / system' },
  customer_type: { type: 'enum',   col: 'customer_type', label: 'Customer type', values: CUSTOMER_TYPES },
  created_at:    { type: 'date',   col: 'created_at',    label: 'Received' },
  updated_at:    { type: 'date',   col: 'updated_at',    label: 'Last changed' },
  quoted:        { type: 'money',  col: 'quoted_cents',  label: 'Quoted amount' },
  archived:      { type: 'bool',   col: 'archived_at',   label: 'Archived' },
  has_phone:     { type: 'bool',   col: 'phone',         label: 'Has a phone number' },
  has_email:     { type: 'bool',   col: 'email',         label: 'Has an email' },
  text:          { type: 'search', col: null,            label: 'Text search' }
};

export const OPS = {
  text:   ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'is_empty', 'not_empty'],
  enum:   ['in', 'not_in', 'is_empty', 'not_empty'],
  status: ['in', 'not_in'],
  person: ['is', 'is_me', 'is_empty', 'not_empty'],
  date:   ['after', 'before', 'between', 'last_days', 'is_empty', 'not_empty'],
  money:  ['gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty'],
  bool:   ['is'],
  search: ['contains']
};

// Columns a table may show, in the client's vocabulary (crm/columns.js has
// the same list as CATALOG; tests/tables.test.mjs keeps them in step).
export const TABLE_COLUMNS = [
  'phone', 'status', 'scheduled_at', 'created_at', 'updated_at', 'category', 'system', 'service',
  'city', 'address', 'email', 'message', 'notes', 'referral_status', 'referral_paid_at',
  'customer_type', 'pipeline', 'source', 'assigned_to', 'quoted_cents'
];

export const DEFAULT_COLUMNS = [
  'phone', 'status', 'scheduled_at', 'created_at', 'category', 'system', 'service', 'city',
  'email', 'message', 'notes', 'pipeline'
];

// sort key -> column. Same rule as FIELDS: the SQL only ever sees these.
export const SORTS = {
  created_at: 'created_at', updated_at: 'updated_at', scheduled_at: 'scheduled_at',
  name: 'name', status: 'status', city: 'city', service: 'service', pipeline: 'pipeline',
  category: 'category', quoted_cents: 'quoted_cents'
};

export const COLORS = ['', 'gold', 'blue', 'green', 'red', 'purple', 'teal', 'gray'];
export const ICONS = ['', '♪', '⚙', '✦', '★', '⚑', '◆', '●', '✎', '☎', '$', '⏱'];

const DAY = 86400000;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));
const nextDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') + DAY).toISOString().slice(0, 10);
const like = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function text(v, what) {
  if (typeof v !== 'string' && typeof v !== 'number') throw new FilterError(`${what} needs a value.`);
  const s = String(v).trim();
  if (!s) throw new FilterError(`${what} needs a value.`);
  if (s.length > LIMITS.text) throw new FilterError(`${what} is too long.`);
  return s;
}

function dollars(v, what) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 10000000) throw new FilterError(`${what} needs an amount in dollars.`);
  return Math.round(n * 100);
}

/**
 * Check one rule and return it in its canonical shape. Throws FilterError.
 * `statusKeys`, when given, is the status vocabulary to check against.
 */
export function cleanRule(raw, statusKeys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FilterError('A filter rule is malformed.');
  const field = String(raw.field || '');
  if (!own(FIELDS, field)) throw new FilterError(`"${field.slice(0, 40)}" is not a field a table can filter on.`);
  const def = FIELDS[field];
  const op = String(raw.op || '');
  if (!OPS[def.type].includes(op)) throw new FilterError(`"${op.slice(0, 40)}" is not an operator for ${def.label}.`);
  const what = def.label;
  const v = raw.value;

  if (op === 'is_empty' || op === 'not_empty' || op === 'is_me') return { field, op };

  switch (def.type) {
    case 'text':
    case 'search':
      return { field, op, value: text(v, what) };
    case 'person': {
      const s = text(v, what).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+$/.test(s)) throw new FilterError(`${what} needs an email address.`);
      return { field, op, value: s };
    }
    case 'enum':
    case 'status': {
      const list = Array.isArray(v) ? v : [v];
      if (!list.length || list.length > LIMITS.values) throw new FilterError(`Pick between 1 and ${LIMITS.values} values for ${what}.`);
      const out = [];
      for (const x of list) {
        const s = String(x == null ? '' : x);
        const ok = def.type === 'enum' ? def.values.includes(s)
          : /^[a-z_]{1,40}$/.test(s) && (!statusKeys || statusKeys.includes(s));
        if (!ok) throw new FilterError(`"${s.slice(0, 40)}" is not a ${what.toLowerCase()} value.`);
        if (!out.includes(s)) out.push(s);
      }
      return { field, op, value: out };
    }
    case 'date':
      if (op === 'last_days') {
        const n = typeof v === 'number' ? v : parseInt(String(v), 10);
        if (!Number.isInteger(n) || n < 1 || n > 3650 || String(n) !== String(v).trim()) {
          throw new FilterError(`${what}: give a number of days between 1 and 3650.`);
        }
        return { field, op, value: n };
      }
      if (op === 'between') {
        if (!Array.isArray(v) || v.length !== 2 || !isDate(v[0]) || !isDate(v[1]) || v[0] > v[1]) {
          throw new FilterError(`${what}: give two dates, earliest first (YYYY-MM-DD).`);
        }
        return { field, op, value: [v[0], v[1]] };
      }
      if (!isDate(v)) throw new FilterError(`${what} needs a date (YYYY-MM-DD).`);
      return { field, op, value: v };
    case 'money':
      if (op === 'between') {
        if (!Array.isArray(v) || v.length !== 2) throw new FilterError(`${what}: give two amounts.`);
        const a = dollars(v[0], what);
        const b = dollars(v[1], what);
        if (a > b) throw new FilterError(`${what}: the smaller amount goes first.`);
        return { field, op, value: [a / 100, b / 100] };
      }
      return { field, op, value: dollars(v, what) / 100 };
    case 'bool':
      if (v !== true && v !== false) throw new FilterError(`${what} is yes or no.`);
      return { field, op, value: v };
    default:
      throw new FilterError('A filter rule is malformed.');
  }
}

export function cleanRules(raw, statusKeys) {
  const rules = raw == null ? [] : raw;
  if (!Array.isArray(rules)) throw new FilterError('The filter rules must be a list.');
  if (rules.length > LIMITS.rules) throw new FilterError(`A table can have up to ${LIMITS.rules} rules.`);
  const clean = rules.map((r) => cleanRule(r, statusKeys));
  if (paramCount(clean) > LIMITS.params) {
    throw new FilterError('That filter is too big to run. Use fewer rules, fewer picked values or fewer text searches.');
  }
  return clean;
}

// How many values a rule list binds once compiled. Kept beside
// compileRules, and tests/tables.test.mjs checks the two agree.
export function paramCount(rules) {
  let n = 0;
  for (const r of rules) {
    const def = FIELDS[r.field];
    if (r.op === 'is_empty' || r.op === 'not_empty' || def.type === 'bool') continue;
    if (def.type === 'search') n += SEARCH_COLS.length;
    else if (def.type === 'enum' || def.type === 'status') n += r.value.length;
    else if (r.op === 'between') n += 2;
    else n += 1;
  }
  return n;
}

/**
 * A rule list as SQL: { sql, params }. The SQL is built only from this
 * file's constants; every value the rules carry is in `params`.
 * `me` is the signed-in email, for "assigned to me"; `now` is a Date.
 */
export function compileRules(rules, { me = '', now = new Date() } = {}) {
  const parts = [];
  const params = [];
  let archivedRule = false;

  for (const r of rules) {
    const def = FIELDS[r.field];
    const col = def.col;
    const blank = `COALESCE(TRIM(${col}), '') = ''`;
    if (r.op === 'is_empty') { parts.push(def.type === 'money' ? `${col} IS NULL` : `(${col} IS NULL OR ${blank})`); continue; }
    if (r.op === 'not_empty') { parts.push(def.type === 'money' ? `${col} IS NOT NULL` : `NOT (${col} IS NULL OR ${blank})`); continue; }

    switch (def.type) {
      case 'text':
        if (r.op === 'is') { parts.push(`${col} = ? COLLATE NOCASE`); params.push(r.value); }
        else if (r.op === 'is_not') { parts.push(`COALESCE(${col}, '') != ? COLLATE NOCASE`); params.push(r.value); }
        else if (r.op === 'contains') { parts.push(`${col} LIKE ? ESCAPE '\\'`); params.push(`%${like(r.value)}%`); }
        else if (r.op === 'not_contains') { parts.push(`COALESCE(${col}, '') NOT LIKE ? ESCAPE '\\'`); params.push(`%${like(r.value)}%`); }
        else if (r.op === 'starts_with') { parts.push(`${col} LIKE ? ESCAPE '\\'`); params.push(`${like(r.value)}%`); }
        break;
      case 'search': {
        parts.push('(' + SEARCH_COLS.map((c) => `COALESCE(${c}, '') LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
        for (let i = 0; i < SEARCH_COLS.length; i++) params.push(`%${like(r.value)}%`);
        break;
      }
      case 'enum':
      case 'status': {
        const marks = r.value.map(() => '?').join(', ');
        // NOT IN must keep rows with no value: "not pneumatic" includes the
        // leads nobody has categorised yet.
        parts.push(r.op === 'in' ? `${col} IN (${marks})` : `(${col} IS NULL OR ${col} NOT IN (${marks}))`);
        params.push(...r.value);
        break;
      }
      case 'person':
        if (r.op === 'is_me') {
          // Nobody signed in by email (the password session): nothing is theirs.
          if (me) { parts.push(`LOWER(${col}) = ?`); params.push(String(me).toLowerCase()); } else parts.push('0');
        }
        else { parts.push(`LOWER(${col}) = ?`); params.push(r.value); }
        break;
      case 'date':
        if (r.op === 'after') { parts.push(`${col} >= ?`); params.push(r.value); }
        else if (r.op === 'before') { parts.push(`${col} < ?`); params.push(r.value); }
        else if (r.op === 'between') { parts.push(`(${col} >= ? AND ${col} < ?)`); params.push(r.value[0], nextDay(r.value[1])); }
        else if (r.op === 'last_days') { parts.push(`${col} >= ?`); params.push(new Date(now.getTime() - r.value * DAY).toISOString()); }
        break;
      case 'money': {
        const cents = (d) => Math.round(d * 100);
        const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[r.op];
        if (sym) { parts.push(`${col} ${sym} ?`); params.push(cents(r.value)); }
        else { parts.push(`(${col} >= ? AND ${col} <= ?)`); params.push(cents(r.value[0]), cents(r.value[1])); }
        break;
      }
      case 'bool':
        if (r.field === 'archived') {
          archivedRule = true;
          parts.push(r.value ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
        } else {
          parts.push(r.value ? `NOT (${col} IS NULL OR ${blank})` : `(${col} IS NULL OR ${blank})`);
        }
        break;
    }
  }

  // Archived leads stay out unless the table asks for them, as on every
  // other tab.
  if (!archivedRule) parts.push('archived_at IS NULL');
  return { sql: parts.join(' AND '), params };
}

export function compileOrder(sort) {
  if (!sort || !own(SORTS, sort.key)) {
    return "ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, created_at DESC, id DESC";
  }
  const col = SORTS[sort.key];
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  // Blanks last either way: a list sorted by quote should open on quotes.
  return `ORDER BY (${col} IS NULL), ${col} ${dir}, id DESC`;
}

/**
 * Check a whole table definition from the browser. Throws FilterError.
 * Returns { name, config } with config = { rules, columns, sort, color, icon }.
 */
export function cleanTable(raw, statusKeys) {
  const t = (raw && typeof raw === 'object') ? raw : {};
  const name = String(t.name == null ? '' : t.name).trim().slice(0, LIMITS.name);
  if (!name) throw new FilterError('Give the table a name.');
  const c = (t.config && typeof t.config === 'object') ? t.config : t;

  const rules = cleanRules(c.rules, statusKeys);

  let columns = null;
  if (c.columns != null) {
    if (!Array.isArray(c.columns) || c.columns.length > LIMITS.columns) throw new FilterError('The column list is malformed.');
    columns = [];
    for (const k of c.columns) {
      if (!TABLE_COLUMNS.includes(k)) throw new FilterError(`"${String(k).slice(0, 40)}" is not a column a table can show.`);
      if (!columns.includes(k)) columns.push(k);
    }
    if (!columns.length) columns = null;
  }

  let sort = null;
  if (c.sort != null && c.sort !== '') {
    if (typeof c.sort !== 'object' || !own(SORTS, c.sort.key)) throw new FilterError('That is not a column a table can sort by.');
    if (!['asc', 'desc'].includes(c.sort.dir)) throw new FilterError('Sort is ascending or descending.');
    sort = { key: c.sort.key, dir: c.sort.dir };
  }

  const color = c.color == null ? '' : String(c.color);
  if (!COLORS.includes(color)) throw new FilterError('That is not one of the table colours.');
  const icon = c.icon == null ? '' : String(c.icon);
  if (!ICONS.includes(icon)) throw new FilterError('That is not one of the table icons.');

  return { name, config: { rules, columns, sort, color, icon } };
}
