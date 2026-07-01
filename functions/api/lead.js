// Lead capture -> Airtable (PPT base).
//
// Receives a small JSON beacon from any site form (see ppt-tracking.js) and
// writes one record to Airtable. The Airtable token lives server-side as a
// Cloudflare secret, so it is never exposed in the browser.
//
// Configure in Cloudflare Pages -> your project -> Settings ->
// Environment variables (Production, and Preview if you use it):
//   AIRTABLE_TOKEN    (secret) Personal Access Token with the
//                     data.records:write scope, granted access to the PPT base.
//                     Create one at https://airtable.com/create/tokens
//   AIRTABLE_BASE_ID  the PPT base id, looks like appXXXXXXXXXXXXXX.
//                     Find it at https://airtable.com/api (open the PPT base).
//   AIRTABLE_TABLE    (optional) table name; defaults to "Leads".
//
// Recommended "Leads" table fields (extras on the form are preserved in
// Details, so this list never has to change as forms evolve):
//   Name (single line text), Email (email), Phone (phone number),
//   Message (long text), Source (single line text), Details (long text)
//
// Until the env vars are set the endpoint no-ops with 204, so shipping this
// never affects the live forms.

// Temporary diagnostic: GET /api/lead reports whether the runtime can see the
// env vars, WITHOUT leaking the token. Remove once Airtable is confirmed.
export async function onRequestGet(context) {
  const { env } = context;
  const out = {
    hasToken: Boolean(env.AIRTABLE_TOKEN),
    tokenLen: env.AIRTABLE_TOKEN ? String(env.AIRTABLE_TOKEN).length : 0,
    hasBaseId: Boolean(env.AIRTABLE_BASE_ID),
    baseIdPrefix: env.AIRTABLE_BASE_ID ? String(env.AIRTABLE_BASE_ID).slice(0, 3) : '',
    table: env.AIRTABLE_TABLE || 'Leads (default)'
  };
  if (env.AIRTABLE_TOKEN && env.AIRTABLE_BASE_ID) {
    try {
      const table = encodeURIComponent(env.AIRTABLE_TABLE || 'Leads');
      const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${table}?maxRecords=1`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
      out.airtableProbe = { status: res.status, body: (await res.text()).slice(0, 400) };
    } catch (e) {
      out.airtableProbe = { threw: String(e) };
    }
  }
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID) {
    return new Response(null, { status: 204 }); // not configured yet
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const fields = (body && body.fields) || {};

  // Case-insensitive lookup across whatever the form happened to name things.
  const pick = (...keys) => {
    for (const key of keys) {
      for (const name of Object.keys(fields)) {
        if (name.toLowerCase() === key && String(fields[name]).trim()) {
          return String(fields[name]).trim();
        }
      }
    }
    return '';
  };

  // Full, human-readable dump of every submitted field, so nothing is lost.
  const details = Object.keys(fields)
    .map((k) => `${k}: ${fields[k]}`)
    .join('\n');

  const record = {
    fields: {
      Name: pick('name', 'full_name'),
      Email: pick('email'),
      Phone: pick('phone', 'tel'),
      Message: pick('message', 'notes', 'issue', 'details'),
      Source: body.source || body.page || '',
      Details: details
    }
  };

  // Drop blanks so typed Airtable columns (email/phone) never reject the write.
  for (const key of Object.keys(record.fields)) {
    if (record.fields[key] === '') delete record.fields[key];
  }

  const table = encodeURIComponent(env.AIRTABLE_TABLE || 'Leads');
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${table}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ records: [record], typecast: true })
  });

  if (!res.ok) {
    // Surface the reason for debugging; the browser beacon ignores the response.
    const detail = await res.text().catch(() => '');
    return new Response(`airtable error ${res.status}: ${detail}`, { status: 502 });
  }

  return new Response(null, { status: 204 });
}
