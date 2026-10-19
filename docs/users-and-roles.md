# Users and roles

Who may open the CRM at `/leads`, and what each of them may do there.

This is about people who **sign in**. The `people` table (contractors and
partners such as World Class) is a different thing and is unchanged.

Ported from HRG's platform (`api/internal/auth`: roles.go, users.go,
identity.go, access.go). The code is in:

- `functions/_lib/roles.js`: the roles and the permission matrix
- `functions/_lib/users.js`: the `users` table, the last-owner guard, the activity trail
- `functions/_lib/auth.js`: `identify()`, the gate every request goes through
- `functions/leads.js`: `VIEW_PERMS`, `ACTION_PERMS` and `BULK_PERMS`, which say what each route needs
- `crm/users.js`: the Users tab

## The four roles

| Role | One line (shown in the app) | In practice |
|---|---|---|
| **Owner** | Everything, including managing people | Everything. The only role that manages users, the calendar feed and saved views. |
| **Manager** | Leads, invoices, accounting and quotes | Everything except users and settings. |
| **Tech** | Leads only — status, notes and appointments | Reads and updates leads and jobs. Logs notes and calls and ticks off follow-ups. No invoices, payments, emails, settings or users. Reads contractors but cannot change them. |
| **Viewer** | Read-only. No invoices, no accounting | Reads leads and their history. Changes nothing and contacts nobody. |

Each role's permissions are listed in full. No role inherits from another,
so a permission added to one role is never quietly added to another.

## Permission matrix

Permissions are written `area.verb`. This table matches
`functions/_lib/roles.js` and `tests/roles.test.mjs`, and the test fails if
they drift apart.

| Area | Permission | Owner | Manager | Tech | Viewer |
|---|---|:-:|:-:|:-:|:-:|
| Leads and contacts | `leads.read` | ✓ | ✓ | ✓ | ✓ |
| | `leads.create` | ✓ | ✓ | | |
| | `leads.update` (fields, status, pipeline, schedule) | ✓ | ✓ | ✓ | |
| | `leads.archive` (archive and restore) | ✓ | ✓ | | |
| | `leads.delete` (purge an archived lead) | ✓ | ✓ | | |
| | `leads.export` (CSV) | ✓ | ✓ | | |
| | `leads.refer` (to World Class; may email them and the customer) | ✓ | ✓ | | |
| Notes and activities | `activities.read` | ✓ | ✓ | ✓ | ✓ |
| | `activities.write` (log a note, call or follow-up; tick it done) | ✓ | ✓ | ✓ | |
| | `activities.delete` | ✓ | ✓ | | |
| Invoices and payments | `invoices.read` | ✓ | ✓ | | |
| | `invoices.write` | ✓ | ✓ | | |
| | `invoices.void` | ✓ | ✓ | | |
| | `payments.write` (mark a referral paid) | ✓ | ✓ | | |
| Automated emails | `outreach.read` | ✓ | ✓ | | |
| | `outreach.send` (send, skip, send a test) | ✓ | ✓ | | |
| | `outreach.configure` | ✓ | ✓ | | |
| People (contractors) | `people.read` | ✓ | ✓ | ✓ | ✓ |
| | `people.write` | ✓ | ✓ | | |
| Settings, statuses, views | `settings.write` (calendar feed, shared saved views) | ✓ | | | |
| Users | `users.manage` | ✓ | | | |

The same matrix, one line per role:

- **owner**: every permission above
- **manager**: every permission except `settings.write` and `users.manage`
- **tech**: `leads.read`, `leads.update`, `activities.read`, `activities.write`, `people.read`
- **viewer**: `leads.read`, `activities.read`, `people.read`

No endpoint reads or writes the `people` table yet. `people.read` and
`people.write` are in place for when one does.

## Every route, and what it needs

The server checks the permission on every request. The client also hides
what a role cannot use, but that is only a convenience. When a check fails,
the API returns `403` JSON (`{"error": "Your role (Tech) can't do that…"}`)
and a page returns a friendly 403 page ("Not for your role"). A POST action
missing from `ACTION_PERMS` is refused with `400`, never let through.
`tests/permissions.test.mjs` fails if an action is added to `leads.js`
without an entry.

### `GET /leads` (pages)

| Tab (`?p=`) | Needs |
|---|---|
| `repair` (default), `tuning`, `referrals`, `all`, `archive` | `leads.read` |
| `invoices` | `invoices.read` |
| `emails` | `outreach.read` |
| `users` | `users.manage` |
| any tab with `&export=csv` | the tab's permission **and** `leads.export` |

Inside a page that opens:

- The referral invoice numbers and Stripe sync are loaded only with
  `invoices.read`.
- The calendar feed address is a bearer credential, so it is sent only with
  `settings.write`.

### `POST /leads` (JSON API, `action` in the body)

| Action | Needs |
|---|---|
| `record` | `leads.read` (the record's invoices are left out without `invoices.read`) |
| `create` | `leads.create` |
| `update` | `leads.update` |
| `archive`, `restore` | `leads.archive` |
| `purge` | `leads.delete` |
| `refer` | `leads.refer` |
| `bulk` with `op: status` or `pipeline` | `leads.update` |
| `bulk` with `op: archive` or `restore` | `leads.archive` |
| `activity`, `activityDone` | `activities.write` |
| `activityDelete` | `activities.delete` |
| `invoice` | `invoices.write` |
| `void` | `invoices.void` |
| `paid` | `payments.write` |
| `outreachSend`, `outreachSkip`, `outreachTest` | `outreach.send` |
| `outreachConfig` | `outreach.configure` |
| `calendarOn`, `calendarRotate`, `calendarOff` | `settings.write` |
| `viewSave`, `viewDelete` | `settings.write` |
| `userCreate`, `userUpdate` | `users.manage` |

The login and logout form posts are not dashboard actions. Logout is open to
anyone, and login exists only in password mode.

### Endpoints that are public on purpose

None of these runs as a signed-in user, so none of them checks a role. Each
one has its own protection:

| Endpoint | Why it is public | What protects it |
|---|---|---|
| `POST /api/lead` | The website's lead forms | Origin check, rate limit |
| `POST /api/photos` | The photo upload form | Origin required, rate limit, size limits |
| `POST /api/csp-report` | Browsers report CSP violations | Logs only |
| `GET/POST /unsubscribe` | Links in automated emails | Signed token per address |
| `GET /calendar/<token>.ics` | Calendar apps cannot sign in | Unguessable token, off until an owner turns it on |

Opening the dashboard also runs the automated-email check, under any role.
This was already the case: there is no timer, so a page load is what wakes
it up. It sends only the kinds an owner or manager has set to automatic. The
person who loaded the page does not send anything themselves.

## Who gets in

Under Cloudflare Access, a person needs **both** of these:

1. **Cloudflare Access** lets them through. This is the policy on the Access
   application, and it proves who they are.
2. **This app** knows them. Either their address is in `ACCESS_EMAILS`, or
   they have an **active** row in the `users` table.

Anyone else gets the page "You don't have access — ask the owner to add you."
A deactivated user is refused on their next request. They do not keep access
until their Google session expires. If the `users` table cannot be read, only
`ACCESS_EMAILS` gets in. That is the same group that got in before this
change.

### The bootstrap, so nobody is locked out

- **Every address in `ACCESS_EMAILS` is an active owner**, with or without a
  `users` row. A row for that address can give them a display name, but it
  can never demote them or deactivate them. To change their role, first take
  them out of `ACCESS_EMAILS` in Cloudflare Pages settings and redeploy.
- **The `ADMIN_PASSWORD` session is the owner.** It applies only when Access
  is not configured (no `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`), as before. Its
  changes are recorded as `admin`.
- Applying the migration therefore changes nothing for anyone who can sign
  in today. Everyone in `ACCESS_EMAILS` is still an owner.

> **A `@domain` entry in `ACCESS_EMAILS`** (for example
> `@pianoplayertech.com`) still admits the whole domain, as it always has,
> and so makes **everyone at that domain an owner**. To give someone at that
> domain a lesser role, replace the domain entry with exact addresses.

### The last-owner rule

A change that would leave nobody as an active owner is refused. That covers a
role change away from owner and deactivating an owner, including yourself.
Owners counted are active `owner` rows plus exact addresses in
`ACCESS_EMAILS`. Domain entries are not counted. The check runs in the same
`UPDATE` statement that makes the change, so two owners demoting each other
at the same moment cannot both succeed.

## Adding a user (owner)

1. Open **Leads → Users**.
2. Under **Add someone**, enter their email, a name and a role, then click
   **Add**.
3. **Let them through Cloudflare Access too.** The Users tab cannot do this
   for you: Cloudflare dashboard → **Zero Trust → Access → Applications** →
   the PianoPlayerTech leads application → **Policies** → edit the Allow
   policy → add their email (or an "Emails ending in" rule) → **Save**.
   Until you do, Access stops them before they reach the app.

On the same tab you can change a role from the dropdown, or **Deactivate** and
**Reactivate** someone. Rows are never deleted, so the activity log's
`actor` column always names someone on the list. Every add and change is
written to the activity log and listed under **Recent changes**. These rows
have no lead attached, so they never show in a lead's timeline.

To take someone's access away completely, deactivate them here **and**
remove them from the Access policy.

## Applying the migration (owner, once)

The `users` table is new. Run this once against production from the repo
root. It only creates the table, so it is safe to run again:

```sh
wrangler d1 execute pianoplayertech-leads --remote --file db/2026-10-18-users.sql
```

(If a `CLOUDFLARE_API_TOKEN` in your shell lacks D1 access, prefix it with
`env -u CLOUDFLARE_API_TOKEN`, as the other migrations in `db/` do.)

The repo has no `wrangler.toml`. The database name comes from the binding
documented at the top of `functions/leads.js` (`DB` → `pianoplayertech-leads`)
and the earlier migration headers.

Until the migration is applied, the Users tab says the table is missing, and
only `ACCESS_EMAILS` owners and the password session can sign in. That is
exactly who could sign in before.

## Tests

- `tests/roles.test.mjs`: the matrix above, cell by cell
- `tests/users.test.mjs`: the bootstrap (`ACCESS_EMAILS` and the password
  cookie), unknown and deactivated emails refused, the last-owner guard, the
  activity trail, and the migration
- `tests/permissions.test.mjs`: every action and tab is mapped, and
  representative routes return 403 for each role and change nothing

These tests use real Access tokens, signed with a key made up for each run,
and a real SQLite database built from `db/schema.sql`. Run them with
`npm test`.
