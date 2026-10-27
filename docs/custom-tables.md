# Custom tables

A table is your own tab of leads, like a Zoho view: a name, a set of rules,
the columns you want, a sort, and a colour or icon. Tables sit at the left
of the tab strip, in the order you choose. Everyone who can sign in sees
them. What each person can do with the leads inside is still set by their
role, so a viewer can read a table but not edit it, and a tech or viewer
never sees a quoted amount.

Only the owner (the `settings.write` permission) can make, change, reorder or
delete tables.

## Setting up: three steps, in this order

1. **Before deploying**, add the columns and fill in categories:

   ```
   npx wrangler d1 execute pianoplayertech-leads --remote --file db/2026-10-23-custom-tables.sql
   ```

   This adds `views.kind` (your saved views keep working) and a `category`
   on every lead. It also fills in `category` on existing leads where the
   answer is clear. The code that is live now ignores both columns, so this
   step is safe before the deploy.

   Then check the result:

   ```
   SELECT category, COUNT(*) FROM leads GROUP BY category;
   ```

   Expect many NULLs. A NULL category lands in Repair.

2. **Deploy** this branch.
3. **After the deploy**, create the three starting tables (Tuning, Repair,
   Pneumatic):

   ```
   npx wrangler d1 execute pianoplayertech-leads --remote --file db/2026-10-23-custom-tables-seed.sql
   ```

   The seed is a separate step because the code from before this branch
   shows every row of `views` as a saved-view chip. Seeded tables would
   appear as chips on every tab, and deleting one would delete the table.
   The seed only inserts when there are no tables at all, so it is safe to
   run again.

If step 1 is run twice, the second run stops at its first line with
"duplicate column name" and changes nothing. If a run ever stops part-way,
with `views.kind` added but `leads.category` missing, do not re-run the
file. Add the column by hand (`ALTER TABLE leads ADD COLUMN category
TEXT;`), then run the rest of the file from the `CREATE INDEX` lines on.

The new code also copes with the other order. If it is deployed before
step 1, the dashboard, saved views and the web forms keep working without
categories, and tables appear once both the migration and the seed have run.

## Making a table

1. Click **+ Tables** at the end of your tabs, then **+ New table**.
2. Give it a name.
3. Optionally pick a colour and an icon.
4. Add rules. A lead shows up only if it matches **every** rule. The fields
   you can filter on:

   | Field | Operators |
   |---|---|
   | Service / type, Source, City, Piano / system | is, is not, contains, doesn't contain, starts with, is blank, is not blank |
   | Pipeline, Category, Customer type | is any of, is none of, is blank, is not blank |
   | Status | is any of, is none of (pick several) |
   | Assignee | is (an email), is whoever is looking, is blank, is not blank |
   | Received, Last changed | on or after, before, between, in the last N days, is blank, is not blank |
   | Quoted amount (dollars) | more than, at least, less than, at most, between, is blank, is not blank |
   | Archived, Has a phone number, Has an email | yes / no |
   | Text search | contains (looks in name, email, phone, city, address, system, service, message and notes) |

   Archived leads stay out unless you add **Archived is yes**. A table with
   no rules shows every live lead.

5. Tick the columns you want and order them with the arrows. Name is always
   first. If you tick nothing, the table uses the standard set.
6. Pick a sort, or leave it on "New first, then newest".
7. Click **Make table**. You land on the new tab.

## Changing tables

- **Edit, rename:** open the table and click **Edit this table** next to the
  search box. You can also use **+ Tables** and then **Edit**.
- **Reorder:** in **+ Tables**, drag a row or use the ↑ ↓ arrows. The order
  saves immediately.
- **Duplicate:** makes "Copy of …" with the same rules, which is a quick way
  to start a variation.
- **Delete:** removes the tab only. The leads are not touched.

Saved views (the "+ Save this view" chips under the search box) still work.
Use them on a table tab for quick filters within it. A view saved on one
table is offered only on that table.

## The starting tables and categories

| Table | Rules |
|---|---|
| Tuning | Pipeline is any of Tuning |
| Repair | Pipeline is any of Repair, and Category is none of Pneumatic |
| Pneumatic | Category is any of Pneumatic |

Every live repair lead is in exactly one of Repair and Pneumatic. A lead
with a blank category goes to Repair, where someone will read it.

`category` is one of: Tuning, Electronic player, Pneumatic player, or Piano
repair & care. It can also be blank. You can change it in the Category
column of any grid, and the change is recorded in the lead's history.

How a new web lead gets its category (`functions/_lib/category.js`):

1. Tuning-pipeline leads are **Tuning**. A teacher signing up as a referral
   partner is left blank.
2. If anything the customer wrote names pneumatic work (pneumatic, Ampico,
   Duo-Art, Welte, paper rolls, pianola, foot pump, bellows, tracker bar…),
   it is **Pneumatic**. If they also name an electronic system (Disklavier,
   PianoDisc, Pianomation, Spirio, solenoid, power supply…), it is left
   blank for a person to decide.
3. A lead from the antique player page is **Pneumatic**, unless it names an
   electronic system, in which case it is left blank.
4. Anything naming an electronic system, or sent from an electronic-system
   page (Disklavier, PianoDisc, QRS, Spirio, /player-repair, mail-in units,
   /for-technicians), is **Electronic player**.
5. Piano repair and cleaning are **Piano repair & care**.
6. Anything else is left blank.

The Type "Player Repair" does **not** decide the category by itself. Four
pages send that Type, and only one of them is about pneumatic players.
Imported Airtable leads have only that Type to go on, so the backfill leaves
them blank unless the piano or the message names the system.

## Tables built on money

A table that filters or sorts on **Quoted amount** tells whoever opens it
which leads are above or below a price, even with the amount hidden. So a
role without invoices (tech, viewer) does not see that tab, and opening it
by link gives "Not for your role". The owner and managers see it as usual.
Only the owner is sent any table's rules; everyone else gets just the name,
colour, icon and columns.

## Safety

- The rules are checked against a fixed list of fields and operators. An
  unknown field, an unknown operator, an unknown status or a malformed
  value is refused with a message (HTTP 400). Nothing is silently dropped.
- A filter is also refused if it would bind more than 90 values, because
  D1 rejects statements with more than 100. A text search counts as 9, and
  each picked status or category counts as 1.
- The SQL is built only from fixed column names. Every value you type is
  passed as a parameter, so `'; DROP TABLE` is just text to search for.
- The filter runs on the server, so the page receives only the rows the
  table selects.
- Deleting a table never deletes leads. Imported Airtable leads are still
  never purged automatically.
