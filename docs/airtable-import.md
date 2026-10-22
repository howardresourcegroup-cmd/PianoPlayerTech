# One-time Airtable import

Brings the old Airtable "Leads" export (`Leads-PPTAll.csv`) into the CRM. The
CSV holds real client data: it is never copied into the repo or committed, and
the script prints counts only.

## Steps

1. Generate the SQL (writes outside the repo):

   ```
   node tools/airtable-import.mjs ~/Downloads/Leads-PPTAll.csv ~/Downloads/ppt-airtable-import.sql
   ```

   Both arguments default to those paths. The output file contains client
   data; do not commit or share it.

2. **Owner: run this once against production:**

   ```
   npx wrangler d1 execute pianoplayertech-leads --remote --file ~/Downloads/ppt-airtable-import.sql
   ```

It is safe to re-run. Every statement checks for a per-row marker first, so a
second run creates nothing.

## What it does

Each CSV row becomes one lead, unless that person is already in the CRM.

- **Already in the CRM** (a lead present before the import with the same
  lowercased email or the same last-10-digit phone, the app's own `normEmail`
  / `normPhone` rules): the existing lead is not modified. A note
  "Imported from Airtable: ..." is added to its timeline instead.
- **Two rows for the same person in the export** are two jobs and become two
  leads.
- **Otherwise** a new lead is inserted, with the original Created date when it
  parses (else the import time) and source `Airtable: <Source>`.

| Airtable Type | pipeline / service |
| --- | --- |
| Tuning | tuning / Piano Tuning |
| Player Repair | repair / Player Repair |
| Digital Keyboard Repair | repair / Digital Keyboard Repair |
| Diagnosis | repair / Diagnosis |
| Unknown | repair / (blank) |

| Airtable Status | CRM status | Archived |
| --- | --- | --- |
| Complete | completed | yes |
| No Tune | lost | yes |
| (blank) | new | yes |
| Scheduled | booked (diag_scheduled for Type Diagnosis) | no |
| In Repair | in_repair | no |
| Quoted | quoted | no |

Name, Email, Phone, Address, Message, Type of Piano (as `system`) and a plain
numeric Quote Amount (as `quoted_cents`) go in their own columns. Everything
else (No. of Pianos, Type of Piano, Details, Quote Amount as typed,
Appointment, Assignee, Tuner Paid/Referral Paid, Attachment Summary) is written
as labeled lines in the lead's internal `notes` and in an "Imported from
Airtable" note on its timeline. Attachments themselves are not imported.
`Assignee` is text only; `assigned_to` is not set.

## No automated email

The import writes only `leads` and `activities` rows: no `outreach`,
`unsubscribes`, `contacts` or other rows.

- Archived leads are skipped by the email rules (`dueFor` returns nothing when
  `archived_at` is set).
- Open imported leads: only `quoted` could draft an email (a quote check-in).
  Each new lead gets a `note` activity stamped at import time, which the rules
  count as a conversation after the quote and so skip. `updated_at` is set to
  the original Created date, so there is no recent status change either.
- `booked`, `in_repair` and `diag_scheduled` are not triggers for any email.

## Archived leads and the 30-day purge

The CRM deletes archived leads 30 days after `archived_at`. To keep the
imported history, archived imports get `archived_at` about ten years out, so
the Archive tab's "Deletes in" column will look odd. To use the normal 30-day
clock instead, generate with `--purge-archived`. Restoring a lead from the
Archive tab clears `archived_at`.

## Checks

`tests/airtable-import.test.mjs` covers the mapping, SQL escaping, matching,
idempotency and email suppression using synthetic rows only.
