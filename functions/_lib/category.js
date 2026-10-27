// What kind of work a lead is: the `category` column.
//
// The pipeline answers "who does this and how is it paid" (tuning goes to
// World Class for a referral fee, repair is ours). It cannot answer "is this
// a pneumatic player", and the Type the forms send cannot either: four
// different pages send service_type "Player Repair", and only one of them
// (/antique-player-piano) is about pneumatic players. The other three are
// the Disklavier power-supply page, the mail-in unit page and the board
// repair page for technicians, all electronic. So the category is worked out
// from what the customer actually told us and which page they were on, in
// that order, and left blank when the two disagree.
//
// Blank is a real answer here. A wrong "pneumatic" sends a $1,500 electronic
// job to the wrong list; a blank one shows up in Repair, where it gets read.

export const CATEGORIES = ['tuning', 'electronic', 'pneumatic', 'acoustic'];

export const CATEGORY_LABELS = {
  tuning: 'Tuning',
  electronic: 'Electronic player',
  pneumatic: 'Pneumatic player',
  acoustic: 'Piano repair & care'
};

// Unambiguous pneumatic words. "Aeolian" and "Gulbransen" are left out on
// purpose: both names are also on ordinary pianos, and an "Aeolian spinet"
// is not a player. "QRS" is left out of the conflict list below because QRS
// also makes paper rolls, so "QRS rolls" is pneumatic.
export const PNEUMATIC_RE = /pneumatic|ampico|duo[- ]?art|welte|paper rolls?|player rolls?|roll[- ]operated|reproducing (?:grand|piano|player)|pianola|foot[- ]?pump|pump(?:ed|ing)? (?:the )?pedals|bellows|suction|tracker ?bar|nickelodeon/i;

// Electronic player systems. The strong set is what makes a pneumatic word
// ambiguous rather than overriding it; QRS on its own is not in it.
// \b around the short ones: "humidity" contains "midi".
const ELECTRONIC_STRONG_RE = /disklavier|enspire|piano ?disc|pianomation|spirio|\bceus\b|solenoid|power supply|driver board|floppy|\bmidi\b/i;
const ELECTRONIC_RE = /disklavier|enspire|piano ?disc|pianomation|spirio|\bceus\b|solenoid|power supply|driver board|floppy|\bmidi\b|\bqrs\b|player system/i;

// Ordinary-piano work: repair, regulation, cleaning.
const ACOUSTIC_RE = /piano repair|piano detailing|detailing|cleaning|regulation|voicing|sticking keys?|broken string|in-home assessment/i;

// The page a lead came from, without ".html", a trailing slash or the form id.
export function pagePath(source) {
  const s = String(source == null ? '' : source).trim().split(/\s+#/)[0].split(/[?#]/)[0];
  return s.replace(/\.html$/i, '').replace(/\/+$/, '').toLowerCase() || '/';
}

const PNEUMATIC_PAGES = ['/antique-player-piano'];
const ELECTRONIC_PAGES = ['/disklavier-repair', '/disklavier-power-supply-repair', '/pianodisc-repair',
  '/qrs-repair', '/spirio-repair', '/player-repair', '/player-unit-mail-in-repair', '/for-technicians',
  '/player-system-install'];
const ACOUSTIC_PAGES = ['/piano-repair', '/piano-cleaning', '/piano-detailing', '/piano-voicing-regulation'];

// Pages whose leads are always repair-pipeline work, whatever words the form
// sends. The voicing page's path and service name contain "voicing", which
// the pipeline rule in functions/api/lead.js reads as tuning; a detailing or
// voicing quote that offers "add a tuning" would read as tuning too. These
// are jobs we quote and do ourselves, so they belong in Repair.
export const REPAIR_PAGES = ['/piano-detailing', '/piano-voicing-regulation', '/player-system-install'];
const PARTNER_RE = /referral partner/i;

/**
 * The category for a lead, or null when it cannot be told.
 *
 * @param lead {pipeline, source, service, system, message}
 * @param extra any other text the customer sent (quiz summary, notes...)
 */
export function classifyCategory(lead, extra = '') {
  const l = lead || {};
  const page = pagePath(l.source);
  const service = String(l.service || '');

  // A teacher signing up to refer students is a partner, not a job.
  if (PARTNER_RE.test(service)) return null;
  // Tuning work is tuning, whatever piano it is on: it goes to World Class.
  if (l.pipeline === 'tuning') return 'tuning';

  const said = [service, l.system, l.message, extra].filter(Boolean).join(' \n ');
  const pneu = PNEUMATIC_RE.test(said);
  const strongElec = ELECTRONIC_STRONG_RE.test(said);
  if (pneu && strongElec) return null;     // "Ampico ... Disklavier": a human decides
  if (pneu) return 'pneumatic';
  // The antique page is about pneumatic players. A Disklavier named there is
  // a contradiction, not an answer; a bare "QRS" there is most likely rolls.
  if (PNEUMATIC_PAGES.includes(page)) return strongElec ? null : 'pneumatic';
  if (ELECTRONIC_RE.test(said)) return 'electronic';
  if (ELECTRONIC_PAGES.includes(page)) return 'electronic';
  if (ACOUSTIC_PAGES.includes(page) || ACOUSTIC_RE.test(service)) return 'acoustic';
  return null;
}

export function isCategory(v) {
  return CATEGORIES.includes(v);
}
