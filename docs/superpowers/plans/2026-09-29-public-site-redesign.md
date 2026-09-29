# Public Site Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the public site one stylesheet, a high-end look, and one clear action per service page.

**Architecture:** A shared `site.css` and `site.js` are loaded on every public page. Five key pages are rebuilt on the shared stylesheet with no inline styles. Every other page keeps its inline block and takes the new look from `site.css`, which loads after it and redefines the shared tokens and class names.

**Tech Stack:** Static HTML, plain CSS, plain JavaScript, Cloudflare Pages. Tests run on Node's built-in runner (`node --test`). No build step, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-29-public-site-redesign-design.md`

## Global Constraints

- No invented proof: no testimonials, counts, years or certifications unless the owner supplied them.
- The word "certified" does not appear on any public page.
- Piano photos under `Images/` are not presented as restoration work.
- URLs, `<title>`, meta description, canonical and JSON-LD are unchanged on every page.
- Every form keeps its `action`, hidden fields, field `name`s and ids. `data-no-conversion` stays on `#apply-form`.
- Exactly one `<h1>` per page.
- Pricing, verbatim: full restoration "$8,000 to $15,000" typical labor; pneumatic repairs quoted per job; electronic diagnosis "$100" flat; repair labor "$125" per hour; tuning "$200" with travel included.
- Service areas, verbatim: pneumatic "Georgia, Florida, Alabama, South Carolina, North Carolina, Tennessee"; electronic in-home "metro Atlanta and North Georgia"; mail-in "anywhere in the US"; tuning "all of Georgia".
- Contrast meets WCAG AA. Focus is visible. Tap targets are at least 44px.
- `main` deploys. Nothing is merged to `main` without the owner's go-ahead.

## File Structure

| File | Responsibility |
|---|---|
| `site.css` (create) | Tokens, base, shared components, the layer that restyles legacy class names |
| `site.js` (create) | Mobile nav toggle, current-page marker |
| `tests/site.test.js` (create) | Guards the architecture and the form contract |
| `tests/fixtures/form-contract.json` (create) | Form actions and field names recorded from `main` |
| `index.html`, `antique-player-piano.html`, `player-repair.html`, `player-unit-mail-in-repair.html`, `tuning.html` (rebuild) | Key pages, on `site.css` only |
| every other public `*.html` (modify) | Link `site.css` and the new font after the inline block |

Rebuilt pages: `REBUILT = [index, antique-player-piano, player-repair, player-unit-mail-in-repair, tuning]`.
Public pages: every `*.html` in the repo root.

## Shared class names (the interface between tasks)

New components are prefixed `pp-` so they never collide with legacy names.

| Class | Element |
|---|---|
| `pp-header`, `pp-nav`, `pp-nav-toggle`, `pp-nav-phone`, `pp-btn`, `pp-btn--primary`, `pp-btn--ghost` | Header and buttons |
| `pp-hero`, `pp-hero__eyebrow`, `pp-hero__title`, `pp-hero__lede`, `pp-hero__actions`, `pp-facts` | Hero |
| `pp-section`, `pp-section--paper`, `pp-section--raised`, `pp-wrap`, `pp-eyebrow`, `pp-title`, `pp-lede` | Sections |
| `pp-paths`, `pp-path`, `pp-path--minor` | Home page path chooser |
| `pp-steps`, `pp-step` | Numbered process |
| `pp-grid`, `pp-card`, `pp-tag` | Card grids |
| `pp-price`, `pp-price__amount`, `pp-price__unit` | Pricing |
| `pp-areas` | Service area list |
| `pp-faq` | FAQ wrapper around `<details>` |
| `pp-contact`, `pp-form`, `pp-note` | Contact block and form |
| `pp-footer`, `pp-footer__cols` | Footer |
| `pp-actionbar` | Fixed bottom bar on phones |

---

### Task 1: Guard tests and the form contract

**Files:**
- Create: `tests/site.test.js`, `tests/fixtures/form-contract.json`

**Produces:** a failing test suite that the later tasks turn green.

- [ ] **Step 1:** Record the form contract from the current pages: for each rebuilt page, every form's `id`, `action`, and the sorted list of field `name`s. Save as `tests/fixtures/form-contract.json`.
- [ ] **Step 2:** Write `tests/site.test.js` with these tests:
  - every public page links `/site.css`, and the link comes after the last `</style>` if the page has one;
  - every rebuilt page has no `<style>` block and loads `/site.js`;
  - every rebuilt page's forms match the contract exactly;
  - `#apply-form` on `index.html` still has `data-no-conversion`;
  - no public page contains "certified" (case-insensitive);
  - `antique-player-piano.html` contains "$8,000" and does not contain "$100" or "$125";
  - every rebuilt page has exactly one `pp-hero` and one `pp-btn--primary` inside it.
- [ ] **Step 3:** Run `node --test tests/site.test.js`. Expected: the contract, certified and pricing tests pass; the `site.css`, `<style>`, `site.js` and `pp-hero` tests fail.
- [ ] **Step 4:** Commit.

### Task 2: `site.css`, `site.js`, and the layer on every page

**Files:**
- Create: `site.css`, `site.js`
- Modify: every public `*.html` (head only)

**Produces:** the class names in the table above; the new look on all legacy pages.

- [ ] **Step 1:** Write `site.css` in this order: tokens, reset and base, typography, buttons, header, hero, sections, components, forms, footer, action bar, legacy layer, reduced-motion.
- [ ] **Step 2:** Write `site.js`: toggle `#mobileNav`/`pp-nav` open state from the toggle button, set `aria-expanded`, close on outside click and on Escape.
- [ ] **Step 3:** In every public page's head, replace the Google Fonts link with the Fraunces + Inter link and add `<link rel="stylesheet" href="/site.css">` immediately before `</head>`.
- [ ] **Step 4:** Run `node --test tests/site.test.js`. Expected: the `site.css` link test passes.
- [ ] **Step 5:** View `piano-tuning-atlanta.html`, `disklavier-repair.html`, `quiz.html`, `thank-you.html` and `privacy-policy.html` at 375px and desktop. Expected: new palette and type, no sideways scroll, no overlapping text.
- [ ] **Step 6:** Run `node .github/scripts/check-site.js`. Expected: PASSED. Commit.

### Tasks 3 to 7: Rebuild one page each

Order: `player-unit-mail-in-repair.html`, `antique-player-piano.html`, `player-repair.html`, `tuning.html`, `index.html`.

For each page:

- [ ] **Step 1:** Keep the head's `<title>`, meta, canonical, Open Graph and JSON-LD as they are. Remove the inline `<style>` block. Keep the tracking scripts.
- [ ] **Step 2:** Rebuild the body on the page pattern in the spec, using only `pp-` classes. Carry over the existing copy for problem lists and FAQ. Keep each form's fields exactly.
- [ ] **Step 3:** Add `<script src="/site.js" defer></script>` and remove the copy-pasted nav script. Keep any page-specific script (the home page application form, the tuning booking form).
- [ ] **Step 4:** Run `node --test tests/site.test.js` and `node .github/scripts/check-site.js`. Expected: that page's tests pass, site check PASSED.
- [ ] **Step 5:** View at 375px, 768px and desktop. Expected: primary action visible without scrolling on a phone, no sideways scroll.
- [ ] **Step 6:** Commit.

Page-specific requirements:

| Page | Primary action | Must include |
|---|---|---|
| `player-unit-mail-in-repair.html` | "Tell us what you've got" to `#contact` | What we repair, three-step process, "quoted per unit after testing", return-shipping-only promise |
| `antique-player-piano.html` | "Send photos for a free identification" to `#contact` | Triage ("What kind of player piano do you have?"), repairs quoted per job, full restoration "$8,000 to $15,000", six states, `mailto:` for photos |
| `player-repair.html` | "Book the $100 diagnosis" | Systems serviced, $100 and $125 pricing, in-home area, mail-in link for everyone else |
| `tuning.html` | "Book a tuning" to the booking form | Partner named (World Class Piano Tuners), $200 travel included, all of Georgia, the booking form and its script untouched |
| `index.html` | Path chooser | Restoration and electronic repair as the two large paths, tuning as the minor path, service areas, FAQ, contact form, the job application form and its script |

### Task 8: Full verification

- [ ] **Step 1:** Run `npm run check`. Expected: lint clean, all tests pass, harness check passes.
- [ ] **Step 2:** Run `node .github/scripts/check-site.js`. Expected: PASSED with no warnings.
- [ ] **Step 3:** Keyboard pass on each rebuilt page: Tab reaches every link, button and field, focus is visible.
- [ ] **Step 4:** Contrast check on body text, muted text and brass-on-dark, brass-deep-on-paper. Expected: all at or above 4.5:1 for text.
- [ ] **Step 5:** Show the owner the local preview. Merge to `main` only on their go-ahead.
