// Unsubscribe from our emails. Public: the person clicking has no login.
//
// The link carries the address and a token only we could have made for it,
// so nobody can unsubscribe an address they were not emailed at.
//
// GET shows a button and changes nothing. Mail scanners and link previews
// follow every link in an email; if following the link were enough, they
// would unsubscribe people who never asked. POST is what records it, and is
// also what a mail client's own Unsubscribe button sends.

import { normEmail, unsubValid, unsubscribe } from './_lib/outreach.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(title, inner, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>${esc(title)} | PianoPlayerTech</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/site.css">
</head>
<body>
<main id="main">
<section class="pp-section">
    <div class="pp-wrap">
        <p class="pp-eyebrow">PianoPlayerTech</p>
        ${inner}
    </div>
</section>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex'
    }
  });
}

const BAD = () => page('Link not recognised', `
        <h1 class="pp-title">That link is not recognised</h1>
        <p class="pp-lede">It may have been cut short when it was copied. To stop our emails, reply to any of them, or write to <a href="mailto:info@pianoplayertech.com">info@pianoplayertech.com</a>, and we will take you off the list.</p>`, 400);

async function read(request) {
  const url = new URL(request.url);
  let e = url.searchParams.get('e') || '';
  let t = url.searchParams.get('t') || '';
  if ((!e || !t) && request.method === 'POST') {
    try {
      const form = await request.formData();
      e = e || String(form.get('e') || '');
      t = t || String(form.get('t') || '');
    } catch { /* no readable body: the query string was all there was */ }
  }
  return { e: normEmail(e), t };
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return BAD();
  const { e, t } = await read(request);
  if (!e || !(await unsubValid(env, e, t))) return BAD();
  return page('Unsubscribe', `
        <h1 class="pp-title">Stop emails to this address?</h1>
        <p class="pp-lede">${esc(e)}</p>
        <form method="POST" action="/unsubscribe" class="pp-actions">
            <input type="hidden" name="e" value="${esc(e)}">
            <input type="hidden" name="t" value="${esc(t)}">
            <button type="submit" class="pp-btn pp-btn--primary">Yes, unsubscribe me</button>
        </form>
        <p class="pp-lede">You will still hear from us about work you have booked.</p>`);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return BAD();
  const { e, t } = await read(request);
  if (!e || !(await unsubValid(env, e, t))) return BAD();
  await unsubscribe(env, e, 'link', new Date().toISOString());
  return page('Unsubscribed', `
        <h1 class="pp-title">You are unsubscribed</h1>
        <p class="pp-lede">We will not send follow-up emails to ${esc(e)} again.</p>
        <p class="pp-lede">If that was a mistake, write to <a href="mailto:info@pianoplayertech.com">info@pianoplayertech.com</a> and we will put it right.</p>`);
}
