// How long an archived lead is kept, for the Archive tab's "Deletes in" cell.
//
// Leads imported from Airtable are never auto-deleted: purgeExpired in
// functions/_lib/db.js skips source "Airtable: ...", and this mirrors it for
// the display. Pure, so it can be tested without a DOM.

export const KEPT_LABEL = 'Kept (imported)';

export function isImported(r) {
  return String((r && r.source) || '').indexOf('Airtable:') === 0;
}

// { text, soon }
export function purgeLabel(r, purgeDays, nowMs) {
  if (isImported(r)) return { text: KEPT_LABEL, soon: false };
  const left = purgeDays - Math.floor((nowMs - new Date(r.archived_at).getTime()) / 86400000);
  return { text: left > 0 ? left + (left === 1 ? ' day' : ' days') : 'any time now', soon: left <= 3 };
}
