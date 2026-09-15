#!/usr/bin/env node
/**
 * PianoPlayerTech site health check.
 *
 * Every rule here exists because the corresponding failure actually happened
 * on this site, and none of them surface at runtime: Cloudflare Pages serves
 * its 404 with a 200 status, so a missing image or a dead link fails silently
 * in production. The only way to catch them is before the deploy.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const errors = [];
const warnings = [];

const html = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Formspree endpoints we have deliberately migrated away from. quiz.html sat on
// a dead one for weeks because nothing checked.
const DEAD_FORM_ENDPOINTS = ['mnjlobjg'];

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
   .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘').replace(/&nbsp;/g, ' ')
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

for (const file of html) {
  const s = read(file);

  // --- internal links resolve to a real file -------------------------------
  for (const m of s.matchAll(/href="(\/[^":#?]*\.html)"/g)) {
    const target = m[1].replace(/^\//, '');
    if (!exists(target)) errors.push(`${file}: link to /${target} — file does not exist`);
  }

  // --- referenced local assets exist ---------------------------------------
  for (const m of s.matchAll(/(?:src|href)="(?!https?:|\/\/|mailto:|tel:|#|data:)\/?([^":?#]+\.(?:png|jpe?g|avif|webp|svg|gif|js|css|ico|woff2?))"/g)) {
    const target = decodeURIComponent(m[1]);
    if (!exists(target)) errors.push(`${file}: missing asset ${target}`);
  }

  // --- no form points at a retired endpoint --------------------------------
  for (const dead of DEAD_FORM_ENDPOINTS) {
    if (s.includes(dead)) errors.push(`${file}: posts to RETIRED Formspree endpoint "${dead}"`);
  }

  // --- every form actually has somewhere to go -----------------------------
  for (const m of s.matchAll(/<form\b([^>]*)>/g)) {
    const attrs = m[1];
    const hasAction = /action="[^"]+"/.test(attrs);
    const hasId = /id="[^"]+"/.test(attrs); // JS-driven forms are wired by id
    if (!hasAction && !hasId) errors.push(`${file}: <form> with neither action nor id`);
  }

  // --- SEO basics -----------------------------------------------------------
  const noindex = /name="robots"[^>]*noindex/.test(s);
  const title = s.match(/<title>([\s\S]*?)<\/title>/);
  const desc = s.match(/<meta name="description" content="([^"]*)"/);
  const canon = /<link rel="canonical"/.test(s);
  const h1 = (s.match(/<h1[\s>]/g) || []).length;

  if (!title) errors.push(`${file}: no <title>`);
  else {
    const t = decode(title[1].replace(/\s+/g, ' ').trim());
    if (t.length > 60) warnings.push(`${file}: title ${t.length} chars (>60, truncates in results)`);
  }
  if (!noindex) {
    if (!desc) errors.push(`${file}: no meta description`);
    else if (decode(desc[1]).length > 158)
      warnings.push(`${file}: description ${decode(desc[1]).length} chars (>158, truncates)`);
    if (!canon) errors.push(`${file}: no canonical`);
  }
  if (h1 !== 1) errors.push(`${file}: ${h1} <h1> tags (expected exactly 1)`);

  // --- structured data parses ----------------------------------------------
  for (const m of s.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); }
    catch (e) { errors.push(`${file}: invalid JSON-LD — ${e.message}`); }
  }
}

// --- sitemap agrees with reality -------------------------------------------
if (exists('sitemap.xml')) {
  const sm = read('sitemap.xml');
  for (const m of sm.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = new URL(m[1]);
    const slug = url.pathname.replace(/^\/|\/$/g, '');
    if (slug === '') continue; // site root -> index.html
    if (!exists(`${slug}.html`))
      errors.push(`sitemap.xml: lists /${slug} but ${slug}.html does not exist`);
  }
  for (const f of html) {
    const slug = f.replace(/\.html$/, '');
    const s = read(f);
    if (/name="robots"[^>]*noindex/.test(s)) {
      if (sm.includes(`/${slug}<`)) errors.push(`sitemap.xml: lists /${slug} but the page is noindex`);
    }
  }
}

const out = (label, list) => {
  if (!list.length) return;
  console.log(`\n${label} (${list.length}):`);
  for (const e of list) console.log('  ' + e);
};

console.log(`Checked ${html.length} pages.`);
out('WARNINGS', warnings);
out('ERRORS', errors);

if (errors.length) {
  console.log(`\nFAILED — ${errors.length} error(s).`);
  process.exit(1);
}
console.log(`\nPASSED${warnings.length ? ` (${warnings.length} warning(s))` : ''}.`);
