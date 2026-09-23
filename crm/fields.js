// Pure helpers about a lead's fields.
//
// Nothing here touches the DOM or the page payload, so it can be imported by
// a test runner. That is the whole reason it is a separate file: the same
// lesson export.js taught, which is that logic living in a module that reads
// the document at import time cannot be tested at all.

/**
 * The address to show, with the city appended only when it is not already
 * part of the address.
 *
 * A submitted address usually contains the city, so naively joining the two
 * produced "88 Peachtree Ln, Marietta, GA 30060, Marietta".
 */
export function placeOf(r) {
  const addr = String((r && r.address) == null ? '' : r.address).trim();
  const city = String((r && r.city) == null ? '' : r.city).trim();
  if (!addr) return city;
  if (!city) return addr;
  return addr.toLowerCase().includes(city.toLowerCase()) ? addr : addr + ', ' + city;
}

/**
 * What the job is, in one line.
 */
export function jobOf(r) {
  return [r && r.service, r && r.system].filter(Boolean).join(' · ');
}

/**
 * Is this scheduled time in the past on a lead nobody has closed out?
 * Shared by the table cell and the phone card so they cannot disagree.
 */
export const FINISHED = ['completed', 'closed', 'paid', 'lost'];

export function isPastDue(r, now) {
  if (!r || !r.scheduled_at) return false;
  const t = new Date(r.scheduled_at).getTime();
  if (isNaN(t)) return false;
  const when = now instanceof Date ? now.getTime() : Date.now();
  return t < when && !FINISHED.includes(r.status);
}
