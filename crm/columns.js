// Which columns each tab shows.
//
// A column is {k: field, label, type, w: min width}. `type` decides what the
// cell renders -- an input, a dropdown, a button, read-only text -- and lives
// in grid.js. Adding a column here is enough; adding a new `type` needs a
// branch there too.

import { D, view, REF_LABEL } from './state.js';

export const COLS = [
  {k:'id', label:'', type:'pick', w:34},
  {k:'name', label:'Name', type:'name', w:240},
  {k:'phone', label:'Phone', type:'phone', w:170},
  {k:'status', label:'Status', type:'select', opts:D.setStatuses, labels:D.statusLabels, w:130}
];

if (view === 'archive') {
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
  COLS.push({k:'pipeline', label:'Pipeline', type:'select', opts:['repair','tuning'], w:100});
}
