# Lead flow audit: form to lead (2026-10-23)

Every public form that creates a lead was traced from the page through
`ppt-tracking.js` (the only code that sends a form to `/api/lead`, by
`sendBeacon` when the form is submitted) into `functions/api/lead.js` and the
`leads` table. Hand-entered leads go through `functions/_lib/newlead.js` and
were checked too.

Each form has an automated test in `tests/lead-flow.test.mjs`. The test reads
the form's real field names, hidden values and select options from the HTML,
fills the form in, and runs the real `ppt-tracking.js` submit handler in a
sandbox. It then posts what the handler sent to the real handler against
SQLite and checks:

- the stored row: pipeline, category, status, source, service, the column
  each answer belongs in, and every answer in `fields`;
- one owner alert and one customer confirmation, with the right wording;
- which seeded table the lead lands in;
- that an identical resubmission adds nothing.

A guard test fails if a lead-sending form exists that has no case.

## Inventory

| Form | Page | Endpoint(s) | Pipeline / category | Table |
|---|---|---|---|---|
| Contact (no id) | `/` | Formspree + `/api/lead` | repair / blank | Repair |
| Technician application `#apply-form` | `/` | Formspree only (after fix) | not a lead | none |
| Inquiry (no id) | `/antique-player-piano` | Formspree + `/api/lead` | repair / pneumatic | Pneumatic |
| Photo upload `#photo-form` | `/antique-player-piano` | `/api/photos` (emails photos) | not a lead | none (a note is added to the matching lead) |
| Inquiry | `/disklavier-power-supply-repair` | Formspree + `/api/lead` | repair / electronic | Repair |
| Inquiry | `/disklavier-repair` | Formspree + `/api/lead` | repair / electronic | Repair |
| Trade enquiry | `/for-technicians` | Formspree + `/api/lead` | repair / electronic | Repair |
| `#detailing-form` | `/piano-cleaning` | Formspree (fetch) + `/api/lead` | repair / acoustic | Repair |
| `#repair-form` | `/piano-repair` | Formspree (fetch) + `/api/lead` | repair / acoustic | Repair |
| `#teacher-form` | `/piano-teachers` | Formspree (fetch) + `/api/lead` | tuning / blank (a partner, not a job) | Tuning |
| Tuning inquiry ×4 | `/piano-tuning-{atlanta,cumming-ga,gainesville-ga,marietta-ga}` | Formspree + `/api/lead` | tuning / tuning | Tuning |
| Inquiry | `/pianodisc-repair`, `/qrs-repair`, `/spirio-repair` | Formspree + `/api/lead` | repair / electronic | Repair |
| `#quizLead` (diagnostic) | `/player-diagnostic` | Formspree (fetch) + `/api/lead` | repair / pneumatic or electronic, from the answers | Pneumatic or Repair |
| `#diagnosis-intake` | `/player-repair` | Formspree (fetch) + `/api/lead` | repair / electronic, or pneumatic if the system named is | Repair or Pneumatic |
| Mail-in inquiry | `/player-unit-mail-in-repair` | Formspree + `/api/lead` | repair / electronic | Repair |
| `#quizLead` | `/quiz` | Formspree (fetch) + `/api/lead` | tuning or repair, from the recommendation | Tuning or Repair |
| `#tuning-booking-form` | `/tuning` | Formspree (fetch, JSON) + `/api/lead` | tuning / tuning | Tuning |

## Findings

| # | Form | Endpoint | What was wrong | What was fixed | Test |
|---|---|---|---|---|---|
| 1 | Technician application (`index.html#apply-form`) | `/api/lead` | Job applications were sent to the CRM as **repair leads**. The owner got a "NEW REPAIR" alert. The applicant got "Thanks for getting in touch about your player piano… someone will call you within 30 minutes". | Added `data-no-airtable`. The application still goes to Formspree. | *the job application and the photo upload never become leads* |
| 2 | Every lead form | `/api/lead` | **No spam handling at all.** `ppt-tracking.js` stripped any honeypot field before sending, and no form had one. A bot filling a form created a lead, an alert, and a confirmation email to whatever address it typed. | Added a hidden `_gotcha` honeypot to all 20 lead forms and the job application, which Formspree also honours. The tracking script sends `hp: 1` when it is filled. `/api/lead` answers 204 and sends no emails for `hp` or a filled `_gotcha`. The row is still stored, already archived and closed, with a note saying why, and a log line is written. A real person caught by autofill can be restored from the Archive tab, and the archive purge clears the rest after 30 days. The endpoint also now returns 400 on a non-object body, where it used to throw. | *a bot that fills the honeypot…*, and the honeypot check in *every form on the site that sends a lead has a case here* |
| 3 | `/tuning`, `/piano-repair`, `/piano-cleaning`, `/piano-teachers` | Formspree (fetch) | **Validation errors were never shown.** These four forms showed the thank-you or success message whatever Formspree answered, including a refusal such as a bad email. Only a network failure showed an error. | Each now checks `res.ok`. On a refusal it keeps the form and shows Formspree's message, or "please check the form or call…". `/player-repair` and the quizzes already did this. | *every form that posts with fetch shows a refusal instead of a false success* |
| 4 | All repair-pipeline forms (cleaning, piano repair, home page contact, teacher sign-up) | `/api/lead` | The customer confirmation said "about **your player piano**" for every repair lead, including a cleaning quote, an ordinary piano repair and a general question. A teacher partner was thanked for "tuning your piano". | The wording now follows the category. Player work says "your player piano", tuning says "tuning your piano", partners get "referring your students", and everything else gets "your piano". The owner alert subject now names the category, e.g. `NEW REPAIR (Pneumatic player) — …`. | every per-form case checks the confirmation wording |
| 5 | Every lead form | `/api/lead` | **No reliable way to tell pneumatic work apart.** The Type "Player Repair" is sent by four pages, and three of them are electronic (Disklavier power supply, mail-in units, trade boards). The pipeline is repair for all of them. | Added `leads.category`, set on intake by `functions/_lib/category.js` from what the customer wrote and the page they used, and backfilled conservatively by the migration. See docs/custom-tables.md. | every per-form case checks the category and table; tests/category.test.mjs |
| 6 | Every lead form | `/api/lead` | **Double submits made duplicate leads.** A double click on a native form, or a resubmit, stored a second row and sent a second alert and confirmation. | An exact repeat of the same page and fields within 10 minutes is answered 204, and nothing is stored or sent. The check and the insert are one statement (`INSERT … SELECT … WHERE NOT EXISTS`), so two submits that arrive together cannot both store. Emails go out only when a row was written. A changed resubmission is still a new lead. | each per-form case resubmits; *a changed resubmission is a new lead* |
| 7 | Every lead form | `/api/lead` | **Returning customers were never linked.** Web leads were stored with no `contact_id`, so the record view did not show the person's other jobs, invoices or history. | A new lead is linked to an existing contact only on strong evidence: the same email or phone, **and** a name on both sides that agrees, and only when exactly one contact fits. Web input is unauthenticated, so a known email or phone with a blank or different name is not linked. Contacts are never created or merged here. | *the same person a second time is linked to their contact; a stranger is not* |
| 8 | Photo upload | `/api/photos` | **Photos never reached the lead.** They are emailed to the inbox only, because there is no file storage. Nothing in the CRM said they had arrived. | After a successful send, a note is added only when exactly one live lead from the last 30 days has that email. It is worded as unverified ("sent … using this lead's email address (not verified)") and marked `meta.auto`, so automated emails do not count it as a conversation. The photos themselves are still only in the email. | *photos from the website leave a note on that customer's lead* |
| 9 | Every lead form | `/api/lead` | Deploying code that writes a new column before the migration would have made every insert fail, so leads would only have been emailed. | The insert retries without `category`/`contact_id` if the database does not have them. The dashboard also reads around a missing `category` column. | *a lead is kept even on a database from before the category column* |
| 10 | `/tuning`, `/piano-repair`, `/piano-cleaning`, `/piano-teachers`, `/player-repair`, `/quiz`, `/player-diagnostic` | `/api/lead` | These forms post to Formspree themselves, and the CRM copy was sent on submit, before Formspree answered. Once finding 3 showed the refusal, the corrected resubmit made a second lead, one of them with the bad email. | The forms carry `data-lead-after-ok`. `ppt-tracking.js` skips them on submit, and each page hands every Formspree outcome to `window.pptAfterFormspree(form, status)`, with status 0 for a network failure. The CRM copy is skipped **only** when Formspree refuses the input (400 or 422). On success, an outage (5xx), a quota or rate limit (429) or a network failure it is still sent, because the CRM is the safety net for a Formspree failure. The page message says what is true in each case: a refusal shows Formspree's reason; 429 or 5xx says the details reached us but could not be confirmed, and to call if not contacted within the hour; no answer says it could not be confirmed and to try again or call. A corrected or repeated submit after a failure is an exact repeat, so the dedupe keeps one lead. A browser with the old script cached still sends on submit, as before. (An earlier version of this fix sent the copy only on success, which would have lost the lead whenever Formspree failed; fixed in review.) | *a form Formspree refuses never reaches the CRM*, *when Formspree answers 503 / 500 / 429 / nothing, the lead is still stored*, *every form that posts to Formspree itself hands every outcome to pptAfterFormspree* |

## Checked and found correct

- **Every field is saved.** `fields` holds every non-blank answer except the
  `_`-prefixed Formspree plumbing. The tests compare `fields` with the
  form's own answers exactly. Values are capped at 2,000 characters and 40
  fields, and no current form comes near that.
- **Columns.** name, email, phone, city (`city`, `location` or `area`),
  address, system (`system` or `piano`), service (the form's `service_type`
  or `lead_type`, or the quiz's `recommended`) and message (`message`,
  `notes`, `issue` or `quiz_summary`) map as `lead.js` intends for every
  form.
- **Status** is `new` and **source** is `<path> #<form id>` for every form.
- **Pipeline:** tuning pages, the tuning booking and the teacher sign-up are
  `tuning`. Everything else is `repair`.
- **Emails fire once:** one alert to `LEAD_NOTIFY_EMAIL` and one confirmation
  (every lead form requires an email). Neither can fail the request.

## Not changed (noted)

- The four `/piano-tuning-*` pages post to a different Formspree form
  (`xzdlraeq`) from the rest (`xeebglab`). This is presumably deliberate.
- `/api/lead` always answers 204, by design, so a lead can never be lost to
  a browser quirk. Validation is the browser's `required` and Formspree's.
  The CRM cannot reject a lead back to the customer.
- The technician application (`index.html#apply-form`) still posts natively
  to Formspree (`xeebglab`), the same form address as the repair enquiries.
  It reaches the owner as the Formspree notification email, as it did
  before this branch. It no longer creates a CRM lead or sends the
  applicant a customer confirmation.
- The photo upload form has no honeypot. It requires real image files and is
  rate-limited and origin-checked.
- `ppt-tracking.js` may be cached by browsers. Until a visitor's cache
  refreshes, the old script still sends leads but strips the honeypot, so
  a bot caught by it still reaches the CRM. Formspree drops it either way.
  The server also refuses a direct post that carries a filled `_gotcha`.
