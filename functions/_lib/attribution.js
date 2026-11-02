// Where a lead came from: the `lead_source` and `attribution` columns.
//
// `leads.source` says which page and form. That is not the same question: a
// tuning form on /tuning could have been reached from an ad, a Google search
// or a teacher's recommendation, and those are worth very different money.
//
// ppt-tracking.js remembers how the visitor arrived and sends it beside the
// form's answers, never among them, so `fields` stays exactly what the person
// typed. `attribution` keeps the raw detail, click ids included, for matching
// a paid job back to an ad later. `lead_source` is the short label a person
// reads and filters on.

const KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'referrer', 'landing'];

const MAX_VALUE = 200;
const MAX_LABEL = 120;

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// Rebuilt from known keys rather than stored as sent: this came from a browser.
export function cleanAttribution(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of KEYS) {
    const v = clip(raw[k], MAX_VALUE);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

const SITES = [
  [/(^|\.)google\./, 'Google search'],
  [/(^|\.)bing\.com$/, 'Bing search'],
  [/(^|\.)yahoo\.com$/, 'Yahoo search'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo search'],
  [/(^|\.)(facebook\.com|fb\.com)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram']
];

function fromReferrer(host) {
  for (const [re, label] of SITES) if (re.test(host)) return label;
  return `Website: ${host.replace(/^www\./, '')}`;
}

/**
 * The label for a lead, or null when nothing is known.
 *
 * A teacher comes first because a teacher is owed money for the booking, and
 * the family may well have clicked an ad on the way to the form. After that,
 * what was measured beats what was remembered: a click id says an ad was
 * clicked; "Google search" from the dropdown cannot tell an ad from a result.
 *
 * @param attr   the cleaned attribution, or null
 * @param fields what the form sent
 */
export function leadSource(attr, fields) {
  const a = attr || {};
  const f = fields || {};
  const heard = clip(f.heard_about, MAX_LABEL);
  const who = clip(f.referred_by, MAX_LABEL);
  const tech = clip(f.referring_tech, MAX_LABEL);
  let label = null;
  if (/teacher/i.test(heard)) label = who ? `Teacher: ${who}` : 'Piano teacher';
  else if (tech) label = `Technician: ${tech}`;
  else if (a.gclid || a.gbraid || a.wbraid) label = 'Google Ads';
  else if (a.fbclid) label = 'Facebook';
  else if (a.utm_source) label = [a.utm_source, a.utm_medium].filter(Boolean).join(' / ');
  else if (heard) label = who ? `${heard}: ${who}` : heard;
  else if (a.referrer) label = fromReferrer(a.referrer);
  else if (a.landing) label = 'Direct';
  return label ? label.slice(0, MAX_LABEL) : null;
}
