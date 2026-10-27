// Which columns each tab shows.
//
// A column is {k: field, label, type, w: min width}. `type` decides what the
// cell renders -- an input, a dropdown, a button, read-only text -- and lives
// in grid.js. Adding a column here is enough; adding a new `type` needs a
// branch there too.

import { D, view, REF_LABEL, TYPE_LABEL, can } from './state.js';

// Every column a custom table may show, by key. functions/_lib/tablefilter.js
// has the same keys as TABLE_COLUMNS; tests/tables.test.mjs keeps them equal.
export const CATALOG = {
  phone: {k:'phone', label:'Phone', type:'phone', w:170},
  status: {k:'status', label:'Status', type:'select', opts:D.setStatuses, labels:D.statusLabels, w:130},
  scheduled_at: {k:'scheduled_at', label:'Scheduled', type:'when', w:180},
  created_at: {k:'created_at', label:'Received', type:'date', w:120},
  updated_at: {k:'updated_at', label:'Last changed', type:'date', w:120},
  category: {k:'category', label:'Category', type:'select', opts:D.categories || [], labels:D.categoryLabels || {}, blank:true, w:150},
  system: {k:'system', label:'Piano / system', type:'text', w:170},
  service: {k:'service', label:'Service', type:'text', w:150},
  city: {k:'city', label:'City', type:'text', w:120},
  address: {k:'address', label:'Address', type:'text', w:210},
  email: {k:'email', label:'Email', type:'text', w:210},
  message: {k:'message', label:'What they said', type:'long', w:260},
  notes: {k:'notes', label:'Notes', type:'text', w:260},
  referral_status: {k:'referral_status', label:'Referral', type:'refer', opts:D.refStatuses, labels:REF_LABEL, blank:true, w:140},
  referral_paid_at: {k:'referral_paid_at', label:'$' + D.fee + ' paid', type:'paid', w:80},
  customer_type: {k:'customer_type', label:'Type', type:'select', opts:['homeowner','business','dealer'], labels:TYPE_LABEL, blank:true, w:110},
  pipeline: {k:'pipeline', label:'Pipeline', type:'select', opts:['repair','tuning'], w:100},
  source: {k:'source', label:'Source', type:'ro', w:180},
  assigned_to: {k:'assigned_to', label:'Assignee', type:'ro', w:170},
  quoted_cents: {k:'quoted_cents', label:'Quoted', type:'money', w:100}
};

export const DEFAULT_TABLE_COLUMNS = ['phone', 'status', 'scheduled_at', 'created_at', 'category',
  'system', 'service', 'city', 'email', 'message', 'notes', 'pipeline'];

export const COLS = [
  {k:'id', label:'', type:'pick', w:34},
  {k:'name', label:'Name', type:'name', w:240}
];
if (view !== 'table') COLS.push(CATALOG.phone, CATALOG.status);

if (view === 'table') {
  // The table's own columns, in its order. Unknown keys (an older page, a
  // hand-edited row) are skipped rather than drawn as empty columns.
  var chosen = (D.table && D.table.config && D.table.config.columns) || DEFAULT_TABLE_COLUMNS;
  chosen.forEach(function(k){
    // The quote is money: the server leaves it out for a role without
    // invoices, so the column would only ever be blank.
    if (k === 'quoted_cents' && !can('invoices.read')) return;
    if (CATALOG[k]) COLS.push(CATALOG[k]);
  });
} else if (view === 'archive') {
  COLS.push(
    {k:'archived_at', label:'Archived', type:'date', w:120},
    {k:'archived_at', label:'Deletes in', type:'purgein', w:110},
    {k:'created_at', label:'Received', type:'date', w:120},
    {k:'city', label:'City', type:'text', w:120},
    {k:'service', label:'Service', type:'text', w:150},
    {k:'id', label:'', type:'archiveacts', w:190}
  );
} else if (view === 'referrals') {
  COLS.push(
    {k:'id', label:'Referral #', type:'ref', w:95},
    {k:'referred_at', label:'Sent', type:'date', w:120},
    {k:'referral_status', label:'Outcome', type:'select', opts:D.refStatuses, labels:REF_LABEL, w:140},
    {k:'referral_paid_at', label:'$' + D.fee + ' paid', type:'paid', w:80},
    {k:'referral_invoice_id', label:'Invoice', type:'inv', w:150},
    {k:'address', label:'Address', type:'text', w:220},
    {k:'system', label:'Piano', type:'text', w:170},
    {k:'notes', label:'Notes', type:'text', w:280}
  );
} else {
  COLS.push(
    {k:'scheduled_at', label:'Scheduled', type:'when', w:180},
    {k:'created_at', label:'Received', type:'date', w:120},
    {k:'system', label:'Piano / system', type:'text', w:170},
    {k:'service', label:'Service', type:'text', w:150},
    {k:'city', label:'City', type:'text', w:120},
    {k:'address', label:'Address', type:'text', w:210},
    {k:'email', label:'Email', type:'text', w:210},
    {k:'message', label:'What they said', type:'long', w:260},
    {k:'notes', label:'Notes', type:'text', w:260}
  );
  if (view !== 'repair') {
    COLS.push(
      {k:'referral_status', label:'Referral', type:'refer', opts:D.refStatuses, labels:REF_LABEL, blank:true, w:140},
      {k:'referral_paid_at', label:'$' + D.fee + ' paid', type:'paid', w:80}
    );
  }
  COLS.push(CATALOG.category, CATALOG.customer_type, CATALOG.pipeline);
}
