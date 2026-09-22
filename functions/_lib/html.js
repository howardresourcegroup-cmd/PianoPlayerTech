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
    'Content-Security-Policy':
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
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

export function page(title, inner, js, nonce) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escape_(title)} · PianoPlayerTech</title><style>${CSS}</style></head>
<body><div class="wrap">${inner}</div>${js ? `<script nonce="${nonce}">${js}</script>` : ''}</body></html>`;
}

