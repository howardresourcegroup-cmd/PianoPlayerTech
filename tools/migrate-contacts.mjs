// Build contacts from the existing leads.
//
//   node tools/migrate-contacts.mjs          dry run: print what it WOULD do
//   node tools/migrate-contacts.mjs --apply  write the contacts and link leads
//
// The dry run is the point. Merging two people who are not the same person
// loses data and is hard to undo, so nothing is written until a human has
// read the proposed clusters.
//
// Reads and writes the live database through wrangler. CLOUDFLARE_API_TOKEN
// is unset for each call: it is set at the macOS level via launchctl, it
// overrides the OAuth login, and it has no D1 permission.

import { execFileSync } from 'node:child_process';
import { clusterLeads } from '../functions/_lib/dedupe.js';

const DB = 'pianoplayertech-leads';
const ACCOUNT = '39798a42943e2b246263c85913c83895';
const APPLY = process.argv.includes('--apply');

function d1(sql) {
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
  delete env.CLOUDFLARE_API_TOKEN;
  const out = execFileSync('wrangler',
    ['d1', 'execute', DB, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  return parsed[0].results || [];
}

const esc = (v) => v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;

const leads = d1(`SELECT id, name, phone, email, address, city, created_at, contact_id
                    FROM leads ORDER BY id`);
console.log(`Read ${leads.length} leads.\n`);

const already = leads.filter((l) => l.contact_id != null).length;
if (already) {
  console.log(`${already} leads already have a contact_id. They are left alone.\n`);
}
const todo = leads.filter((l) => l.contact_id == null);
if (!todo.length) { console.log('Nothing to migrate.'); process.exit(0); }

const { clusters, flagged } = clusterLeads(todo);

const merges = clusters.filter((c) => c.leadIds.length > 1);
console.log('='.repeat(70));
console.log(`${clusters.length} contacts from ${todo.length} leads` +
            ` (${merges.length} of them merge more than one lead)`);
console.log('='.repeat(70) + '\n');

if (merges.length) {
  console.log('MERGES -- these leads become one contact each:\n');
  for (const c of merges) {
    console.log(`  ${c.contact.name || '(no name)'}  [leads ${c.leadIds.join(', ')}]`);
    console.log(`     phone ${c.contact.phone || '-'}   email ${c.contact.email || '-'}`);
    for (const id of c.leadIds) {
      const l = todo.find((x) => x.id === id);
      console.log(`     - #${id} ${l.created_at.slice(0, 10)}  ` +
                  `"${l.name || ''}"  ${l.phone || ''}  ${l.email || ''}`);
    }
    console.log('');
  }
} else {
  console.log('No leads merge: every one looks like a separate person.\n');
}

if (flagged.length) {
  console.log('-'.repeat(70));
  console.log('FLAGGED -- NOT merged. Same phone, different names.');
  console.log('Link them by hand later if they really are one person.\n');
  for (const f of flagged) console.log(`  leads ${f.leadIds.join(' + ')}: ${f.reason}`);
  console.log('');
}

const singles = clusters.length - merges.length;
console.log(`${singles} leads become a contact of their own.\n`);

if (!APPLY) {
  console.log('='.repeat(70));
  console.log('DRY RUN -- nothing was written.');
  console.log('Re-run with --apply once the merges above look right.');
  console.log('='.repeat(70));
  process.exit(0);
}

console.log('Applying...\n');
const now = new Date().toISOString();
let made = 0;

for (const c of clusters) {
  const k = c.contact;
  d1(`INSERT INTO contacts
        (created_at, updated_at, name, phone, phone_norm, email, email_norm,
         address, city, state, zip)
      VALUES (${esc(now)}, ${esc(now)}, ${esc(k.name)}, ${esc(k.phone)},
              ${esc(k.phone_norm)}, ${esc(k.email)}, ${esc(k.email_norm)},
              ${esc(k.address)}, ${esc(k.city)}, ${esc(k.state)}, ${esc(k.zip)})`);
  const row = d1('SELECT last_insert_rowid() AS id')[0];
  const contactId = row.id;
  d1(`UPDATE leads SET contact_id = ${contactId}
       WHERE id IN (${c.leadIds.join(',')}) AND contact_id IS NULL`);
  made++;
}

console.log(`Created ${made} contacts and linked ${todo.length} leads.`);
const check = d1(`SELECT (SELECT COUNT(*) FROM contacts) AS contacts,
                         (SELECT COUNT(*) FROM leads) AS leads,
                         (SELECT COUNT(*) FROM leads WHERE contact_id IS NULL) AS unlinked`)[0];
console.log(`Now: ${check.contacts} contacts, ${check.leads} leads, ` +
            `${check.unlinked} still unlinked.`);
