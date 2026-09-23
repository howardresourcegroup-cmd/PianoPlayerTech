// The dashboard: the HTML shell and the client-side grid application.
//
// Every customer-supplied value reaches the DOM through textContent or
// .value, never innerHTML, so nothing a form submits can run as markup.
// The script is served inline under a CSP nonce; `<` is escaped in the JSON
// payload so no value a customer typed can close the script tag.

import { escape_, page } from './html.js';
import { REFERRAL_FEE, PURGE_DAYS } from './db.js';

export const VIEWS = { repair: 'Repair & Pneumatic', tuning: 'Tuning',
  referrals: 'Referrals', all: 'All', invoices: 'Invoices', archive: 'Archive' };

export const STATUSES = ['new', 'called', 'referred', 'booked', 'closed'];

// What a person may pick in the Status dropdown. 'referred' is missing on
// purpose: it is set only by the refer flow, which also stamps referred_at.
// Choosing it by hand used to set the status and nothing else, so the lead
// never reached the Referrals tab, the stats, or a World Class invoice.
export const SET_STATUSES = STATUSES.filter((s) => s !== 'referred');

export { REFERRAL_FEE };

export const REFERRAL_STATUSES = ['sent', 'booked', 'no_booking'];

export function dashboard(view, rows, counts, ref, extra, nonce) {
  const tab = (key) => {
    const n = counts[key] || 0;
    return `<a class="tab${key === view ? ' on' : ''}" href="/leads?p=${key}">${VIEWS[key]}${
      n ? `<span class="pill">${n}</span>` : ''}</a>`;
  };

  // Everything the grid needs, handed to the script as data. `<` is escaped
  // so no value a customer typed can close this script tag.
  // The vocabulary comes from the database when the caller loaded it, and
  // falls back to the constant otherwise. 'referred' is filtered out of what
  // a person may choose no matter where the list came from: it is set by the
  // refer flow, which also stamps referred_at, and picking it by hand used
  // to set the status alone and lose the referral.
  const vocab = (extra.statusList && extra.statusList.length)
    ? extra.statusList
    : STATUSES.map((k, i) => ({ key: k, label: k, sort: i * 10, is_open: k === 'closed' ? 0 : 1 }));
  const statuses = vocab.map((s) => s.key);
  const setStatuses = statuses.filter((k) => k !== 'referred');
  const statusLabels = {};
  for (const s of vocab) statusLabels[s.key] = s.label || s.key;
  const openStatuses = vocab.filter((s) => s.is_open).map((s) => s.key);

  const data = JSON.stringify({
    view, rows, statuses, setStatuses, statusLabels, openStatuses,
    refStatuses: REFERRAL_STATUSES, fee: REFERRAL_FEE, purgeDays: PURGE_DAYS, ref, ...extra
  }).replace(/</g, '\\u003c');

  return page(VIEWS[view], `
    <div class="top">
      <h1>Leads</h1>
      <form method="post">${extra.who ? `<span class="muted">${escape_(extra.who)} &nbsp;</span>` : ''}
        <input type="hidden" name="action" value="logout">
        <button class="linkbtn" type="submit">Sign out</button></form>
    </div>
    <nav class="tabs">${Object.keys(VIEWS).map(tab).join('')}</nav>
    <div class="stats" id="stats" ${view === 'repair' ? 'hidden' : ''}></div>
    <div class="banner" id="banner" hidden></div>
    <div class="tools" id="tools">
      <input type="search" id="q" placeholder="Search, or try city:marietta or is:unbilled" aria-label="Search">
      <select id="sf" aria-label="Filter"></select>
      <span class="muted" id="shown"></span>
      <a href="/leads?p=${view}&amp;export=csv">Export CSV</a>
    </div>
    <div class="quick" id="quick"></div>
    <div class="gridwrap"><table><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table>
      <div class="empty" id="empty" hidden>Nothing here yet.</div></div>
    <dialog id="dlg"><div class="dlg" id="dlgbody"></div></dialog>
    <script type="application/json" id="data">${data}</script>`, null, nonce, '/crm/app.js');
}

// Client side. Every customer-supplied value goes into the page through
// textContent or .value — never innerHTML — so nothing a form submits can
// run as markup.

