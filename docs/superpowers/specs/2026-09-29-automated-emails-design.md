# Automated emails in the leads dashboard

Date: 2026-09-29
Status: design approved by the owner in conversation

## Why

The business gets a handful of leads a month, each worth hundreds to
thousands of dollars. Three moments are routinely missed: a quote that goes
quiet, a finished job that could have produced a review, and a tuning that is
due again. This adds email for those three moments, and nothing else.

The dashboard already uses "follow-up" to mean a task the owner owes someone.
To keep the two apart, this feature is called **Emails** everywhere.

## Decisions the owner made

| Question | Decision |
|---|---|
| Follow-ups or broadcasts | Automatic follow-ups only. No bulk sends. |
| Send on its own or wait | Per type: Off, Ask me first, Automatic. All start on Ask me first. |
| What wakes it up | Opening the dashboard. There is no timer. |
| Postal address | Not chosen yet. Sending is blocked until one is entered. |

## The three emails

| Kind | Trigger | Default delay | Not sent when |
|---|---|---|---|
| `quote_checkin` | Status is `quoted` | 4 days after it became `quoted` | Status changed, or a call, email, SMS, note or appointment was logged after the quote |
| `review_request` | Status is `completed`, `invoiced` or `paid` | 1 day after it became `completed` | Lead archived |
| `tuning_reminder` | Pipeline `tuning`, and the referral was booked or the lead completed | 12 months after the tuning | Lead archived |

"Became" is read from the newest `status` activity whose meta names that
status. A lead with no such activity falls back to `updated_at`.

The tuning date is `scheduled_at`, else `referred_at`, else the completion
time. The reminder repeats yearly; each year is its own cycle.

### The backlog rule

Turning this on must not email every old lead. A lead is only due inside a
window after its trigger: 30 days for the check-in and the review request,
60 days after the anniversary for the reminder. Anything older is ignored.

## Safeguards

- No email to an address on the unsubscribe list. Checked at draft time and
  again at send time.
- One row per lead, kind and cycle, enforced by a unique index.
- At most 20 sends in a calendar day (UTC).
- Sending requires a postal address in settings. Drafting does not.
- A lead with no email, or an email that fails the shape check, is skipped.
- Every send, skip and failure is written to the lead's timeline.

## Unsubscribe

Each email carries a link to `/unsubscribe?e=<email>&t=<token>`. The token is
an HMAC-SHA256 of the normalised email under a secret held in the `settings`
table, created on first use. Nobody can unsubscribe an address they were not
emailed at.

- `GET` shows a page with one button. It changes nothing, because mail
  scanners follow links.
- `POST` records the unsubscribe. The `List-Unsubscribe` and
  `List-Unsubscribe-Post` headers point here, so a mail client's own
  unsubscribe button works in one click.

## Data

Two new tables. Nothing existing is altered.

```sql
CREATE TABLE IF NOT EXISTS outreach (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  lead_id     INTEGER NOT NULL,
  contact_id  INTEGER,
  kind        TEXT NOT NULL,
  cycle       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL,   -- draft | sent | skipped | failed
  decided_at  TEXT,
  decided_by  TEXT,
  error       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_once ON outreach(lead_id, kind, cycle);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach(status, created_at);

CREATE TABLE IF NOT EXISTS unsubscribes (
  email_norm  TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  source      TEXT
);
```

Configuration is one JSON value in `settings` under `outreach_config`:
postal address, sender name, and for each kind its mode, delay, subject and
body.

## Components

| File | Responsibility |
|---|---|
| `functions/_lib/outreach.js` | Rules, templates, config, the unsubscribe token, draft and send |
| `functions/unsubscribe.js` | The public unsubscribe page |
| `functions/leads.js` | The Emails view, and the actions `outreachSend`, `outreachSkip`, `outreachConfig`, `outreachTest` |
| `functions/_lib/grid.js` | The Emails tab |
| `crm/outreach.js` | The queue and the settings, in the browser |
| `db/2026-09-29-automated-emails.sql`, `db/schema.sql` | The two tables |

## Wording

Templates use `{first_name}`, `{instrument}` and `{sender}`. Defaults are
plain and make no claim the business has not made. The owner edits them in
settings, and can edit any single draft before sending it.

## Failure

- The dashboard must load even if this feature throws. The run is wrapped,
  logged and reported through the existing alert path.
- A failed send is recorded as `failed` with the provider's message, and can
  be sent again from the queue.
- With the tables missing, the Emails tab says so and every other tab works.

## Testing

`tests/outreach.test.mjs`, against a real SQLite file built from
`db/schema.sql`, with the email provider stubbed. No test sends mail.

Covered: each trigger and each stop condition; the backlog window; the
unique index; the daily cap; the address gate; unsubscribe token accepts the
right address and rejects another; `GET` changes nothing; template filling
escapes what a customer typed.

## Rollout

1. Build on branch `automated-emails`.
2. Show the owner the three drafts.
3. Apply `db/2026-09-29-automated-emails.sql` to production, with approval.
4. Merge. Nothing can send until the address is entered.

## Not in scope

Broadcasts, open and click tracking, SMS, and a timer.
