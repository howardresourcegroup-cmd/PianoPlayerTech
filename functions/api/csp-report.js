// CSP violation sink.
//
// The site ships Content-Security-Policy-Report-Only, which is only useful if
// the reports land somewhere a human can read. Without a report endpoint the
// violations exist solely in each visitor's browser console, where nobody sees
// them — so the policy can never be safely tightened to enforcing.
//
// Reports show up in `wrangler pages deployment tail`, or in the Cloudflare
// dashboard under Workers & Pages -> pianoplayertech -> Logs.

const MAX_BODY_BYTES = 8 * 1024;

export async function onRequestPost(context) {
  const { request } = context;

  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 204 });
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 204 });
  }

  // Browsers send either the legacy `csp-report` shape or the Reporting API array.
  const reports = Array.isArray(body) ? body : [body];

  for (const r of reports.slice(0, 10)) {
    const d = r['csp-report'] || r.body || r;
    const directive = d['effective-directive'] || d.effectiveDirective || d['violated-directive'] || '?';
    const blocked = d['blocked-uri'] || d.blockedURL || '?';
    const doc = d['document-uri'] || d.documentURL || '?';
    // One line per violation so it greps cleanly out of the tail.
    console.log(`csp-violation directive=${directive} blocked=${blocked} page=${doc}`);
  }

  // Always 204 — a report endpoint must never give a probe anything to work with.
  return new Response(null, { status: 204 });
}
