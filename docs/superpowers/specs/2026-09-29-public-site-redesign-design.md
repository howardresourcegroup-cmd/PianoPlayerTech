# Public site redesign

Date: 2026-09-29
Status: approved by owner in conversation ("make sure it's the best site in this industry… I trust ya")

## Why

The site treats every service as equal. A $25 tuning referral gets the same
card as an $8,000 to $15,000 restoration. Ads now send paid traffic to the
restoration and mail-in pages, so those pages have to earn the lead.

What each job is worth to the business:

| Service | Profit per job | Area | How it is priced |
|---|---|---|---|
| Pneumatic restoration | $800 to $1,000 | GA, FL, AL, SC, NC, TN, we travel | Quoted; full restoration typically $8,000 to $15,000 labor |
| Pneumatic repair | not stated | same | Quoted per job, discussed on contact |
| Electronic player unit, in-home | $100 to $500 | Metro Atlanta and North Georgia | $100 flat diagnosis (Georgia), $125/hr labor |
| Electronic player unit, mail-in | $100 to $500 | Anywhere in the US | Quoted per unit after bench test |
| Tuning (referral to World Class Piano Tuners) | $25 | All of Georgia | $200, travel included |

## Goals

1. A visitor knows within one screen which of the three paths is theirs.
2. Each key page pushes one action matched to the service.
3. The site looks like it belongs to a specialist who does five-figure work.
4. One stylesheet, so the next change is made once.

## Non-goals

- No invented proof. There are no job photos or reviews yet. No testimonials,
  counts, years, or certifications are written unless the owner supplies them.
- The piano photos under `Images/` are pianos that were for sale. They are
  not presented as restoration work.
- No photo upload in this phase (see Open items).
- No change to the CRM, `/api/lead`, tracking, URLs, titles, or canonical tags.
- Page copy that carries search value (FAQ, problem lists, city pages) is kept.

## What the field looks like

Reviewed 2026-09-29: pianoartisans.com, bensplayerservice.com,
alexanderpeppe.com, and the player-care.com directory.

- Technical sites are credible but dated, with no clear next step and no
  phone number in view.
- The one polished site sells heritage and emotion, and hides price.
- Mail-in rebuilders quote $850 to $999 for a Disklavier supply, stated in
  blog posts, not on a service page.

Nobody pairs a modern page with a stated process and stated pricing. That is
the position this design takes: the straight-talking specialist.

## Design

### Architecture

- `site.css`: design tokens, base, and every shared component. Loaded on all
  pages, after any inline `<style>`, so it wins at equal specificity.
- `site.js`: mobile nav, and marking the current nav item. Replaces the
  copy-pasted nav script on rebuilt pages.
- Rebuilt pages carry no inline `<style>` block. They use `site.css` only.
- Remaining pages keep their inline block and receive the new look through
  the layer: `site.css` redefines the existing tokens (`--gold`, `--ivory`,
  `--text`, …) and restyles the shared class names (`nav`, `.hero`,
  `.btn-primary`, `.section-title`, cards, forms, `footer`).

### Visual language

- Warm near-black ground, ivory text, brass used sparingly for actions and
  small labels. Light "paper" sections break up long pages and carry the
  dense reading (process, pricing, FAQ).
- Display face Fraunces, body Inter. Large, calm headings; short measure.
- Fewer boxes. Hairline rules and spacing separate content; cards are kept
  for choices the visitor has to make.
- Motion is limited to hover and focus states. `prefers-reduced-motion` is
  respected.
- Contrast meets WCAG AA. Every interactive element has a visible focus ring.
  Tap targets are at least 44px.

### Page pattern (rebuilt pages)

1. Header: logo, four links, phone as a text link, one brass button.
2. Hero: one-line promise, one supporting sentence, primary action,
   secondary action, three short facts.
3. "Is this you?" or triage: helps the visitor confirm they are in the right
   place, and routes them if not.
4. How it works: three or four numbered steps.
5. Pricing, stated plainly.
6. Service area.
7. FAQ (existing copy).
8. Contact: the form for that service, with the phone beside it.
9. Footer: grouped links, service areas in words.

A slim bar fixed to the bottom of phone screens holds the page's primary
action and a call button.

### Pages and their one action

| Page | Primary action | Secondary |
|---|---|---|
| `/` | Choose a path: restoration, electronic repair, tuning | Call |
| `/antique-player-piano` | Send photos for a free identification | Call |
| `/player-repair` | Book the $100 diagnosis | Mail-in if outside the area |
| `/player-unit-mail-in-repair` | Tell us what you've got | Call |
| `/tuning` | Book a tuning | Call |

Home page weighting: restoration and electronic repair are the two large
paths. Tuning is the third, smaller path.

### Photos for identification

The restoration form has no file field today, although the page invites
photos. Until upload exists, the page says exactly what works: fill in the
form, then email photos to info@pianoplayertech.com, with a `mailto:` link
that pre-fills the subject. The form's confirmation copy repeats it.

### Proof slots

Rebuilt pages include a clearly marked, commented-out block for a case study
and for a review. They render nothing until filled. This keeps the layout
ready without publishing empty or invented proof.

## Forms and tracking

Unchanged in behaviour. Every form keeps its `action`, hidden fields, field
`name`s and ids, so Formspree, `/api/lead`, and `ppt-tracking.js` keep
working. `data-no-conversion` stays on the job application form.

## Testing

- `node .github/scripts/check-site.js` passes (links, assets, forms, one
  `<h1>`, titles, descriptions, canonical, JSON-LD, sitemap).
- `npm test` and `npx eslint .` pass.
- Each rebuilt page is viewed at 375px, 768px and desktop widths: no
  sideways scroll, no overlapping text, primary action visible without
  scrolling on a phone.
- A sample of layered pages (a city tuning page, a brand repair page, the
  quiz, thank-you, privacy) is viewed at phone and desktop widths.
- Forms are checked to submit to the same endpoint with the same fields.
- Keyboard: every link, button and field reachable, focus visible.

## Rollout

Built on branch `site-redesign`. Shown to the owner in a local preview.
Merged to `main` only on the owner's go-ahead, because `main` deploys.

## Open items

1. Photo upload. Needs file storage on the Cloudflare side (an R2 bucket and
   a binding) and a change to `/api/lead`. Separate piece of work.
2. Proof. Job photos and reviews, when the owner has them.
3. Inline `<style>` blocks on the layered pages can be deleted page by page
   once each is confirmed to look right on `site.css` alone.
