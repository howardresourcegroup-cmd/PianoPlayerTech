# Automated Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draft and send three follow-up emails from the leads dashboard, with the owner in control of each.

**Architecture:** One module holds the rules, the templates and the unsubscribe token as pure functions, with thin database and email wrappers around them. The dashboard runs it when opened. A public endpoint handles unsubscribes.

**Tech Stack:** Cloudflare Pages Functions, D1, Resend, plain browser modules. Tests on Node's runner against SQLite. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-29-automated-emails-design.md`

## Global Constraints

- The feature is called "Emails". "Follow-up" already means a task in this dashboard.
- Kinds: `quote_checkin`, `review_request`, `tuning_reminder`. Modes: `off`, `ask`, `auto`. Default mode `ask`.
- Default delays: 4 days, 1 day, 12 months. Windows: 30 days, 30 days, 60 days.
- Daily cap: 20 sends. Sending requires a postal address.
- No test sends mail. The first real send is a test the owner triggers.
- Customer text reaches the DOM through `textContent` or `.value`, never `innerHTML`.
- Nothing is applied to the production database or merged to `main` without the owner's go-ahead.

## Interfaces

`functions/_lib/outreach.js` exports:

| Name | Signature |
|---|---|
| `KINDS` | `['quote_checkin', 'review_request', 'tuning_reminder']` |
| `DEFAULT_CONFIG` | `{ address, sender, kinds: { [kind]: { mode, delay, subject, body } } }` |
| `cleanConfig(raw)` | returns a config with only known keys and clamped values |
| `loadConfig(env)`, `saveConfig(env, raw, now)` | read and write `outreach_config` |
| `normEmail(s)` | lower-cased, trimmed, or `''` if not an address |
| `fill(template, lead, config)` | returns the text with placeholders filled |
| `dueFor(lead, facts, config, nowIso)` | returns `[{ kind, cycle }]`; `facts` is `{ statusAt, lastTouchAt }` |
| `unsubToken(env, email)`, `unsubValid(env, email, token)` | the HMAC and its check |
| `unsubUrl(env, origin, email)` | the link for an email |
| `renderEmail(env, origin, row, config)` | the provider payload, with footer and headers |
| `draftDue(env, nowIso)` | inserts drafts for everything due; returns the count |
| `sendOne(env, origin, id, actor, nowIso, edits)` | sends one row; returns `{ ok, error }` |
| `runOutreach(env, origin, nowIso)` | `draftDue`, then `sendOne` for every draft whose kind is `auto` |

## Tasks

### Task 1: Tables
- [ ] Add both tables to `db/schema.sql` and to `db/2026-09-29-automated-emails.sql`.
- [ ] Run `node --test tests/schema.test.js`. Expected: pass.

### Task 2: Rules and templates (pure)
- [ ] Write the tests for `normEmail`, `cleanConfig`, `fill` and `dueFor` in `tests/outreach.test.mjs`. Run them. Expected: fail, module missing.
- [ ] Write those functions. Run. Expected: pass.

### Task 3: Unsubscribe
- [ ] Write tests: the token accepts its own address and rejects another; `GET` changes nothing; `POST` records it; a bad token is refused.
- [ ] Write `unsubToken`, `unsubValid`, `unsubUrl` and `functions/unsubscribe.js`. Run. Expected: pass.

### Task 4: Draft and send
- [ ] Write tests: a due lead is drafted once; an unsubscribed address is not; the cap stops the twenty-first; no address blocks sending; a provider failure is recorded as `failed`; `auto` sends and `ask` waits.
- [ ] Write `renderEmail`, `draftDue`, `sendOne`, `runOutreach`. Run. Expected: pass.

### Task 5: Dashboard
- [ ] Add the `emails` view to `grid.js` and `leads.js`, and the four actions.
- [ ] Write `crm/outreach.js` and wire it in `crm/app.js`.
- [ ] Run `npm run check`. Expected: lint clean, all tests pass, harness passes.

### Task 6: Verify
- [ ] Open the Emails tab against a local database with seeded leads. Expected: drafts listed, settings save, Send is blocked with a clear message while the address is empty.
- [ ] Show the owner the three drafts and the migration. Apply and merge only on their go-ahead.
