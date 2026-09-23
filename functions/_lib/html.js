// Page shell, escaping and response headers for the private dashboard.
//
// escape_ is security-relevant: the dashboard renders text customers typed.
// Moved here verbatim -- do not "simplify" the character class.

import { CSS } from './css.js';

export function escape_(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function privateHeaders(nonce, type = 'text/html; charset=utf-8') {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store, private',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // script-src allows 'self' as well as the nonce: the dashboard's client
    // application is served from /crm/ as a real module, which a nonce cannot
    // cover. That is a genuine loosening -- any script this origin serves may
    // now run here -- and it is acceptable because default-src 'none' still
    // blocks every external source and the origin serves only this repo's
    // files. What actually stops a customer's text from running as markup is
    // that the client writes it with textContent, never innerHTML.
    // default-src 'none' means every directive that is not named here is
    // denied -- including img-src and manifest-src, which fall back to it.
    // The home-screen icon and the manifest are same-origin files, so they
    // get 'self' and nothing more. data: is allowed for images because a
    // favicon or an inline SVG may arrive that way; no remote origin is.
    'Content-Security-Policy':
      `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
      `img-src 'self' data:; manifest-src 'self'; ` +
      `connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
  };
}

export function newNonce() {
  return crypto.randomUUID().replace(/-/g, '');
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// `js` is an inline script for the small pages that need one; `moduleSrc` is
// a path under /crm/ for the dashboard's application.
export function page(title, inner, js, nonce, moduleSrc) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#17120e">
<!-- Installable from a phone's share sheet. The manifest is linked only
     from the CRM, never from the marketing pages, so "add to home screen"
     on the public site does not install a lead dashboard. -->
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="PPT Leads">
<link rel="apple-touch-icon" href="/Images/app/icon-180.png">
<title>${escape_(title)} · PianoPlayerTech</title><style>${CSS}</style></head>
<body><div class="wrap">${inner}</div>${
  js ? `<script nonce="${nonce}">${js}</script>` : ''}${
  moduleSrc ? `<script type="module" src="${moduleSrc}"></script>` : ''}</body></html>`;
}

