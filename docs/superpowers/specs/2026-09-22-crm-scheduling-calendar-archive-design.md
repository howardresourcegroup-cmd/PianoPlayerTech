# CRM: scheduling, calendar feed, archive, and style overhaul

Design, 2026-09-22.

## Why

The `/leads` dashboard records leads and hands tuning work to World Class. It
cannot say when a job happens, it cannot get anything onto a phone's calendar,
it cannot remove a row, and it is a wide fixed table that is unusable on the
device its owner carries to jobs.

Four changes, in one pass because they share a schema migration and a
refactor:

1. **Scheduling** — a date and time on a lead.
2. **Calendar feed** — a subscribable `.ics` so scheduled work, callbacks and
   referral follow-ups appear on a phone.
3. **Archive** — remove a lead from the working views, permanently after 30
   days.
4. **Style** — light theme with dark support, a phone layout, and stronger
   visual priority.

## Non-goals

- Two-way calendar sync. The feed is read-only; the CRM stays the source of
  truth. Rejected during brainstorming: OAuth, refresh tokens and webhook
  handling on Workers is more machinery than this earns.
- Multi-user scheduling, technician assignment, or availability.
- Any change to the public marketing pages, the lead intake endpoint
  (`functions/api/lead.js`), or Stripe invoicing.

## Constraints discovered

**Pages Functions have no cron triggers.** Confirmed in Cloudflare's migration
guide, which lists Cron Triggers among the features Workers has and Pages does
not. The 30-day purge therefore cannot be a scheduled job. It runs
opportunistically on dashboard load, inside `context.waitUntil()` so it never
delays a response. Consequence, accepted by the owner: if nobody opens the CRM
for 45 days, records purge on the next open rather than on day 30. The purge
is a floor on retention, not a ceiling.

If a guaranteed purge schedule ever matters — a data-retention promise to
customers, say — the fix is migrating the project from Pages to Workers, which
Cloudflare now treats as the primary path and which brings Cron Triggers with
it. That is a separate piece of work and explicitly out of scope here.

**A calendar client cannot authenticate.** No cookies, no Cloudflare Access,
no OAuth. The only mechanism that works is an unguessable URL. The feed
therefore exposes customer names, addresses and phone numbers to anyone
holding the link. This is the central risk of the feature and is mitigated,
not eliminated — see *Calendar feed security*.

## Data model

Additive only. No column is dropped or retyped, so an old deployment keeps
working against the new schema during the rollout.

```sql
ALTER TABLE leads ADD COLUMN scheduled_at   TEXT;     -- ISO-8601 UTC, job start
ALTER TABLE leads ADD COLUMN scheduled_mins INTEGER;  -- length; NULL means 90
ALTER TABLE leads ADD COLUMN archived_at    TEXT;     -- ISO-8601 UTC; set = archived

CREATE INDEX IF NOT EXISTS idx_leads_scheduled ON leads(scheduled_at)
  WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_archived  ON leads(archived_at);

-- Small key/value store. Holds the calendar token so it can be rotated from
-- the dashboard without a redeploy.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);
```

`scheduled_at` and `archived_at` are ISO-8601 UTC strings, matching
`created_at`. That format sorts lexicographically, so range comparisons use a
JS-computed cutoff string rather than SQLite's `datetime()` — mixing the two
is how the `Z` suffix silently breaks comparisons.

### The main correctness risk

Every existing query must gain `archived_at IS NULL`:

- the grid query in `onRequestGet` (all five views)
- the per-pipeline new-lead counts
- the referral stats aggregate
- the CSV export (shares the grid rows)
- both calendar feed queries

Missing one leaks archived leads back into a view or skews a number that
drives billing. This is the single most likely defect in the whole change and
every one of these gets a test.

Mutating actions (`update`, `paid`, `refer`, `invoice`) reject an archived
lead with a clear message rather than silently succeeding on an invisible row.

## Scheduling

`scheduled_at` is editable from the grid and the lead detail modal via a
`datetime-local` input. The browser supplies local wall-clock time; it is
converted to UTC on save and rendered back in the viewer's zone. The business
operates in `America/New_York`, but nothing hard-codes that — the conversion
is whatever zone the browser is in.

Validation: the server parses the value and rejects anything `Date` cannot
read, storing the normalised ISO string rather than the submitted text.
`EDITABLE` currently maps a field to a maximum length, with `0` meaning
"validated as an enum"; `scheduled_at` needs a third kind, a parsed-and-
normalised field, so that map grows a type rather than a number.

A "Scheduled" column and a filter — Today, This week, Upcoming, Unscheduled —
sit alongside the existing status filter.

## Calendar feed

Route: `functions/calendar/[token].js`, served as
`text/calendar; charset=utf-8`.

### Events

Three kinds, all derived — nothing about the feed is stored:

| Kind | When | Condition |
|------|------|-----------|
| Job | `scheduled_at`, lasting `scheduled_mins` (default 90) | `scheduled_at` set |
| Callback | 30 minutes after `created_at`, 15 minutes long | `status = 'new'` |
| Referral follow-up | 7 days after `referred_at`, 15 minutes long | `referral_status = 'sent'` |

A job carries `LOCATION` set to the address so the phone can navigate to it,
and `DESCRIPTION` with the phone number and what the customer said. A callback
and a follow-up carry the phone number and the reason.

`UID` is stable and derived: `lead-<id>-job@pianoplayertech.com`,
`-callback@`, `-referral@`. Stability is what makes a reschedule *update* the
existing event instead of adding a second one — the most common defect in
hand-rolled feeds.

Because the feed is `METHOD:PUBLISH`, an event simply disappearing from the
output removes it on the subscriber's next refresh. No `STATUS:CANCELLED`
bookkeeping is needed.

### Format

RFC 5545 compliance is not optional — Google Calendar and Apple Calendar fail
differently and quietly when it is wrong:

- CRLF line endings throughout
- lines folded at 75 octets, continued with a leading space, folding on octet
  boundaries rather than character boundaries
- `\\`, `;`, `,` and newline escaped in every text value
- UTC timestamps with a `Z` suffix
- `VERSION:2.0`, `PRODID`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`
- `X-WR-CALNAME:PianoPlayerTech`, plus `REFRESH-INTERVAL;VALUE=DURATION:PT15M`
  and `X-PUBLISHED-TTL:PT15M` as refresh hints

Subscribers poll on their own schedule regardless of those hints — Google in
particular can lag hours. The feed is a convenience, not a guarantee of
timeliness, and the dashboard stays authoritative.

### Security

The URL is a bearer credential for customer PII.

- 32 bytes from `crypto.getRandomValues`, base64url-encoded
- stored in `settings` under `calendar_token`
- compared with the existing constant-time `safeEqual`
- a bad or missing token returns **404**, not 403, so the endpoint does not
  confirm that a calendar exists
- `Cache-Control: private, no-store` and `X-Robots-Tag: noindex`
- the token is never written to a log line
- the dashboard shows the subscribe URL behind a click-to-reveal, with a
  **Rotate** action that generates a new token and immediately invalidates the
  old one; rotating breaks existing subscriptions by design, and the UI says so

Residual risk, stated plainly: anyone who obtains the URL — a shared screen, a
synced calendar on a lost phone, a browser history — reads every customer's
name, address and phone number until the token is rotated. This is inherent to
calendar subscription and is the reason the feature is opt-in rather than on
by default.

## Archive

An `archived_at` timestamp hides a lead from every working view. An **Archive**
tab lists archived leads with **Restore** and **Delete now**, showing how many
days remain before automatic purge.

Purge, on dashboard load, inside `waitUntil`:

```sql
DELETE FROM leads WHERE archived_at IS NOT NULL AND archived_at < ?
```

bound to `now - 30 days` as an ISO string.

Archiving is one click with an undo affordance in the tab; purging — manual or
automatic — is irreversible and the UI says so without hedging.

## Style

**Theme.** The palette is already CSS custom properties on `:root`, so this is
a values change plus a media query, not a rewrite. Light becomes the default;
`@media (prefers-color-scheme: dark)` restores today's dark brown-and-gold.
Gold stays the accent in both. Contrast targets WCAG AA for body text.

**Phone layout.** Below 760px the table becomes a list of cards: name and
status on top, then the details that matter, then thumb-sized Call, Refer,
Schedule and Archive actions. The desktop table is unchanged above that width.
The switch is a `matchMedia` branch in the render function, re-rendering on
change, rather than CSS that tries to reflow a `<table>` into blocks.

**Priority.** New leads, overdue callbacks and money owed carry real visual
weight, so the dashboard says what to do rather than presenting every row as
equal. An overdue callback — a `new` lead older than 60 minutes — gets a
distinct accent, and the count appears in the stats row.

## Refactor

`functions/leads.js` is ~1,600 lines and this change would push it past 2,500.
It splits into `functions/_lib/`:

| Module | Holds |
|--------|-------|
| `auth.js` | sessions, Cloudflare Access, `safeEqual`, `emailAllowed` |
| `db.js` | column lists, the archived-exclusion helper, migrations note |
| `html.js` | `page`, `escape_`, header helpers |
| `css.js` | the stylesheet |
| `grid.js` | the client script |
| `ics.js` | feed generation and RFC 5545 escaping/folding |
| `stripe.js` | invoicing |

`leads.js` becomes the route handler.

**To verify before relying on it:** that Cloudflare Pages does not route
underscore-prefixed paths under `functions/`. `functions/_middleware.js` is
special-cased, which is suggestive but not proof that `_lib/` is excluded. If
it does route them, the modules move outside `functions/` and are imported by
relative path instead. This is a task, not an assumption.

## Testing

No test framework exists; CI runs `check-site.js` and `node --check`.

**A gap worth closing first:** the client script lives inside a template
literal, so `node --check` cannot see it. A syntax error there ships. The
harness built while fixing the referral bug — extract `CSS` and `GRID_JS`,
mount them in a page with fixture leads, drive it in a browser — becomes
`tools/harness.js`, and CI gains a `node --check` of the extracted script.

Per area:

- **Schema and purge** — apply `db/schema.sql` to a local SQLite file, seed
  rows, assert the purge deletes only leads archived more than 30 days ago and
  is idempotent.
- **Archived exclusion** — one test per query listed above, each asserting an
  archived lead is absent.
- **`.ics`** — parse the output with a real iCalendar parser, assert event
  counts and fields for each kind, assert UID stability across a reschedule,
  and assert CRLF plus the 75-octet fold on a deliberately long address.
- **Token** — a wrong token 404s; a rotated token invalidates the previous one.
- **Timezone** — a wall-clock time entered in `America/New_York` round-trips
  to the same wall-clock time, across a DST boundary in both directions.
- **Layout** — the harness at 375px renders cards and at 1280px renders a
  table.

## Rollout

Each step deploys on its own and is useful alone:

1. Refactor into modules; add the `GRID_JS` syntax check to CI. No behaviour
   change — if anything moves visibly, the refactor is wrong.
2. Apply the schema migration. Additive, so the running deployment is
   unaffected.
3. Archive and purge.
4. Scheduling.
5. Calendar feed, token generation and rotation.
6. Style overhaul.

Visual change lands last, so that if something breaks during steps 1–5 it is
obvious which change caused it rather than being masked by everything looking
different.

## Open questions

- Default job length: 90 minutes is assumed for a tuning. Confirm, or make it
  a setting.
- Whether the callback reminder should fire for `repair` leads as well as
  `tuning`. Assumed yes — a repair lead going cold costs more.
