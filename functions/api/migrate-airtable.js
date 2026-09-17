// ONE-SHOT: copy existing Airtable leads into D1, then delete this file.
//
// Airtable is being retired. This exists only so the leads already captured
// there survive the move — running it is the last thing Airtable is used for.
//
// Run once:
//   curl -X POST https://pianoplayertech.com/api/migrate-airtable \
//        -H "X-Admin-Password: <your ADMIN_PASSWORD>"
//
// It refuses to run a second time unless you pass ?force=1, so an accidental
// repeat cannot duplicate every customer.

const enc = new TextEncoder();

function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ADMIN_PASSWORD || !safeEqual(request.headers.get('X-Admin-Password') || '', env.ADMIN_PASSWORD)) {
    return new Response('unauthorized', { status: 401 });
  }
  if (!env.DB) return new Response('no D1 binding named DB', { status: 503 });
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID) {
    return new Response('Airtable env vars are gone — nothing to migrate', { status: 400 });
  }

  const force = new URL(request.url).searchParams.get('force') === '1';
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM leads').first();
  if (existing && existing.n > 0 && !force) {
    return json({ skipped: true, reason: `leads table already has ${existing.n} rows; add ?force=1 to run anyway` });
  }

  const table = encodeURIComponent(env.AIRTABLE_TABLE || 'Leads');
  let offset = '';
  let imported = 0;
  const failures = [];

  do {
    const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${table}?pageSize=100${offset ? `&offset=${offset}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
    if (!res.ok) {
      return json({ imported, error: `Airtable read failed: ${res.status}`, detail: await res.text().catch(() => '') }, 502);
    }
    const data = await res.json();

    for (const rec of (data.records || [])) {
      const f = rec.fields || {};
      const type = String(f.Type || '');
      try {
        await env.DB.prepare(
          `INSERT INTO leads
             (created_at, pipeline, status, name, email, phone, service, system, city, message, source, fields, notes)
           VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, '', ?, ?, ?, 'Imported from Airtable')`
        ).bind(
          rec.createdTime || new Date().toISOString(),
          /tuning/i.test(type) ? 'tuning' : 'repair',
          f.Name || '', f.Email || '', f.Phone || '',
          type, f['Type of Piano'] || '',
          f.Message || '', f.Source || '',
          JSON.stringify(f)
        ).run();
        imported++;
      } catch (err) {
        failures.push({ id: rec.id, error: err && err.message });
      }
    }
    offset = data.offset || '';
  } while (offset);

  // Historic leads land as 'closed' so they do not masquerade as people
  // waiting on a callback. They are there for history, not for the queue.
  return json({ imported, failures, note: "imported rows are marked 'closed' so they don't look like new work" });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
