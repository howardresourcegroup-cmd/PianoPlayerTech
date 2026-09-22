# CRM upgrade: data model and client architecture

Design, 2026-09-22. Covers Phases 1 and 2 of the Zoho-style CRM upgrade.

## Why

`/leads` records one row per form submission and nothing else. There is no
contact, so one person submitting three forms is three unrelated rows and
there is no customer history. There are no activities, so follow-ups live in
memory. There are no payments or technician payouts, so the money is tracked
outside the system.

Phases 1 and 2 build the foundation the rest needs. Neither changes what the
dashboard looks like. That is deliberate: if the refactor and the migration
land invisibly, any later breakage is obviously caused by the later work.

## Decisions taken

- **Client stays vanilla**, split into ES modules served as Pages assets. No
  framework, no build step, no `package.json`.
- **Multi-user data model now, single-user UI now.** Ownership and assignment
  are modelled properly so contractors can be added without a migration, but
  no user-management screens are built yet.
- **Piano Gallery and World Class are the same company**, under two names.
  The relationship runs both ways and both flows are money owed *to* this
  business, billed as one invoice each month. See *Two directions of money*.

## Two conflicts in the request, resolved

**"Archived" is not a status.** Archiving is already a timestamp,
`leads.archived_at`, which drives the Archive tab and the 30-day purge. Making
it also a status creates two sources of truth that can disagree — a lead whose
status says Archived but which is not archived, or the reverse. `archived_at`
stays the mechanism; Archived is dropped from the status list.

**"Referred" is added as a status.** The requested list omits it, but
referral handoff is core to the business and four live leads carry it today.
Dropping it would either lose that state or force it into a status that means
something else.

Final list, in pipeline order:

```
New · Contacted · Waiting on Customer · Quote Sent · Referred
Scheduled · Booked · Completed · Invoice Sent · Paid · Closed · Lost
```

Statuses live in a table, not a constant, so they can be renamed and reordered
without a deploy.

### Migrating today's statuses

| Today | Becomes | Live rows |
|-------|---------|-----------|
| `new` | New | most |
| `called` | Contacted | some |
| `referred` | Referred | 4 |
| `booked` | Booked | — |
| `closed` | Completed | — |

`closed` maps to Completed rather than Closed: in this data it has meant "the
work is done", not "abandoned". Lost is the status for abandoned leads and
nothing migrates into it.

## Data model

Additive. No existing column is dropped or retyped, and `leads` keeps every
column it has, so the running dashboard is unaffected until code reads the new
ones.

```sql
-- A person. One per human, not one per enquiry.
CREATE TABLE contacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT,
  name        TEXT,
  phone       TEXT,
  phone_norm  TEXT,          -- last 10 digits; what dedupe matches on
  email       TEXT,
  email_norm  TEXT,          -- lowercased
  address     TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  preferred_contact TEXT,    -- 'phone' | 'email' | 'sms'
  notes       TEXT
);
CREATE INDEX idx_contacts_phone ON contacts(phone_norm);
CREATE INDEX idx_contacts_email ON contacts(email_norm);

-- Anything that happened, or is due to happen, on a lead.
-- Status changes are activities too, which is what makes the timeline
-- complete rather than a second parallel history table.
CREATE TABLE activities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  lead_id      INTEGER,
  contact_id   INTEGER,
  type         TEXT NOT NULL,  -- call|email|sms|note|task|appointment|followup|status
  subject      TEXT,
  body         TEXT,
  due_at       TEXT,           -- set = it is a follow-up or appointment
  completed_at TEXT,
  actor        TEXT,           -- the Access email that did it
  meta         TEXT            -- JSON; for status: {"from":"New","to":"Contacted"}
);
CREATE INDEX idx_activities_lead ON activities(lead_id, created_at DESC);
CREATE INDEX idx_activities_due  ON activities(due_at)
  WHERE due_at IS NOT NULL AND completed_at IS NULL;

-- Money received. An invoice's balance is derived from these, never stored.
CREATE TABLE payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  invoice_id   INTEGER,
  contact_id   INTEGER,
  lead_id      INTEGER,
  amount_cents INTEGER NOT NULL,
  method       TEXT,
  paid_at      TEXT,
  note         TEXT
);

-- Whoever does work or trades work with this business: a contractor who is
-- paid a percentage, or a partner who both sends and buys work.
CREATE TABLE people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  name        TEXT NOT NULL,   -- e.g. 'Piano Gallery'
  aka         TEXT,            -- other names for the same company, comma-separated
  email       TEXT,
  phone       TEXT,
  kind        TEXT NOT NULL,   -- 'contractor' | 'partner' | 'owner'
  default_pct INTEGER,         -- contractor's cut, percent of sale, e.g. 90
  bills_monthly INTEGER NOT NULL DEFAULT 0,  -- partner: one invoice per month
  active      INTEGER NOT NULL DEFAULT 1
);

-- Statuses in a table so they can be renamed and reordered without a deploy.
CREATE TABLE statuses (
  key      TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  sort     INTEGER NOT NULL,
  is_open  INTEGER NOT NULL DEFAULT 1,  -- counts as live work
  is_won   INTEGER NOT NULL DEFAULT 0
);

-- A saved view: filters, sort and visible columns, per person.
CREATE TABLE views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT,             -- Access email, or NULL for shared
  name       TEXT NOT NULL,
  config     TEXT NOT NULL,    -- JSON {filters, sort, columns}
  sort       INTEGER NOT NULL DEFAULT 0
);
```

And on `leads`, all nullable:

```sql
ALTER TABLE leads ADD COLUMN contact_id       INTEGER;
ALTER TABLE leads ADD COLUMN assigned_to      TEXT;     -- Access email
ALTER TABLE leads ADD COLUMN person_id        INTEGER;  -- who does the work
ALTER TABLE leads ADD COLUMN lead_source      TEXT;
ALTER TABLE leads ADD COLUMN piano_make       TEXT;
ALTER TABLE leads ADD COLUMN piano_model      TEXT;
ALTER TABLE leads ADD COLUMN estimated_cents  INTEGER;
ALTER TABLE leads ADD COLUMN quoted_cents     INTEGER;
ALTER TABLE leads ADD COLUMN tech_pct         INTEGER;  -- contractor's cut (outbound)
-- Set when the work is performed FOR a partner rather than an end customer.
-- These are the technician jobs that join referral fees on the monthly
-- partner invoice; such a job's payer is the partner, not a consumer contact.
ALTER TABLE leads ADD COLUMN partner_id       INTEGER;  -- people.id (inbound)
ALTER TABLE leads ADD COLUMN state            TEXT;
ALTER TABLE leads ADD COLUMN zip              TEXT;
CREATE INDEX idx_leads_contact  ON leads(contact_id);
CREATE INDEX idx_leads_assigned ON leads(assigned_to);
```

## Two directions of money

The earlier draft of this spec had this wrong, and it changes the schema, so
it is written out explicitly.

**Inbound — the partner owes this business.** Piano Gallery (also called World
Class) generates two kinds of receivable:

1. **Referral fees.** A tuning lead handed to them that they book earns
   `REFERRAL_FEE`. This model is *not* retired.
2. **Technician work.** Jobs this business performs *for* them. The partner is
   the payer; there may be no consumer contact at all.

Both appear as lines on **one invoice per month**, which is what
`people.bills_monthly` marks. The existing referral invoicing already
aggregates booked referrals into a monthly bill; this extends the same invoice
with technician-work lines rather than inventing a second mechanism.

**Outbound — this business owes a contractor.** A job performed by someone
else, such as Christian, pays them `tech_pct` of the sale:

```
Sale $150 · contractor 90% → contractor $135 · business $15
```

These are two different relationships and must not share one "payout" field.
A single `people` row can in principle be both, so direction is a property of
the *job*, not of the person: `partner_id` set means they are paying us,
`person_id` with `tech_pct` means we are paying them.

### Derived, never stored

Amount paid, amount owed, technician payout and profit are **computed**, not
columns:

- paid = `SUM(payments.amount_cents)` for the lead
- owed = `quoted_cents - paid`
- contractor payout = `quoted_cents * tech_pct / 100` (outbound, when `person_id` is set)
- profit = `quoted_cents - contractor payout`
- partner owes us = referral fees for booked referrals + `quoted_cents` on
  jobs where `partner_id` is set, minus payments received from that partner

Storing them invites the classic CRM bug where the balance and the payments
disagree and nobody knows which is right.

## Contact deduplication

The risky part of this whole design: merging two people who are not the same
person is worse than leaving duplicates, and it is hard to undo.

**Match rule.** Normalise phone to its last 10 digits and email to lowercase.
Two leads belong to the same contact when their `phone_norm` matches **and**
their names are compatible, or when `email_norm` matches exactly.

"Compatible" means one name is empty, the names are equal ignoring case and
punctuation, or one is a prefix of the other ("Dana" / "Dana Whitfield"). A
shared household phone with two clearly different names — "Dana Whitfield" and
"Marcus Bell" — does **not** auto-merge. It is recorded as a possible
duplicate for a person to link by hand.

**Migration is a dry run first.** The migration prints every proposed cluster
for review and only applies on a second, explicit run. With 36 leads this is
reviewable by eye, and that review happens before anything is written.

**On new leads,** `/api/lead` links to an existing contact on an exact
`phone_norm` or `email_norm` match, and otherwise creates one. A near-match is
flagged on the record rather than merged.

## Client architecture

The client is a 690-line string inside `_lib/grid.js`. Record pages with tabs,
timelines, saved views and bulk actions do not fit there.

It becomes real files under `public/crm/`, served as Pages assets and loaded
as ES modules:

```
public/crm/app.js        entry, hash router
public/crm/api.js        fetch wrappers for /leads actions
public/crm/grid.js       the list
public/crm/record.js     the detail view
public/crm/activities.js timeline and follow-ups
public/crm/filters.js    filters and saved views
public/crm/ui.js         el(), formatting, shared widgets
```

**This requires one CSP change**, from `script-src 'nonce-…'` to
`script-src 'self'`. That is a real reduction in strictness: today only the one
inline block with the right nonce can run; afterwards, any script served from
this origin can. It remains safe because the origin serves only files from this
repository and `default-src 'none'` still blocks every external source. The
existing rule that customer text reaches the DOM through `textContent` and
never `innerHTML` is what actually stops injected markup, and it does not
change.

`_routes.json` must keep `/crm/*` served as static assets rather than routed
through the function.

The browser harness keeps working: it already mounts the real client code, and
it gets simpler when that code is files rather than an extracted string.

## What does not change

- `/api/lead` keeps accepting submissions in exactly the format the public
  forms send.
- The `leads` table keeps every column, so an old deployment still works.
- Referral history, invoices, the archive and the purge all keep working.
- Cloudflare Access and `ACCESS_EMAILS` are untouched.

## Testing

- **Dedupe** gets the most tests: same phone with compatible names merges;
  same phone with clearly different names does not; email match merges; no
  contact for a lead with neither phone nor email.
- **Migration** runs against a copy of real data, and is idempotent.
- **Derived money** is checked against payments rather than trusted.
- **Activities** ordering, overdue vs upcoming boundaries, and timezone.
- Every existing test keeps passing. The refactor is only correct if nothing
  visible changes.

## Phases after this

3. Record detail view · 4. Statuses and activities · 5. List power
6. Money · 7. Dashboard · 8. Automations and style
