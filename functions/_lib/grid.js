// The dashboard: the HTML shell and the client-side grid application.
//
// Every customer-supplied value reaches the DOM through textContent or
// .value, never innerHTML, so nothing a form submits can run as markup.
// The script is served inline under a CSP nonce; `<` is escaped in the JSON
// payload so no value a customer typed can close the script tag.

import { escape_, page } from './html.js';
import { REFERRAL_FEE, PURGE_DAYS } from './db.js';

export const VIEWS = { repair: 'Repair & Pneumatic', tuning: 'Tuning',
  referrals: 'Referrals', all: 'All', invoices: 'Invoices', emails: 'Emails', archive: 'Archive',
  users: 'Users' };

// The permission each tab needs. leads.js checks it on the server; here it
// only decides which tabs are drawn.
export const TAB_PERMS = {
  repair: 'leads.read', tuning: 'leads.read', referrals: 'leads.read', all: 'leads.read',
  archive: 'leads.read', invoices: 'invoices.read', emails: 'outreach.read', users: 'users.manage'
};

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

  // Who is signed in, and as what. Without `me` (older callers, tests of
  // the shell alone) every tab is drawn, as it always was.
  const me = extra.me || null;
  const perms = me ? me.perms || [] : null;
  const tabs = Object.keys(VIEWS).filter((k) => !perms || perms.includes(TAB_PERMS[k]));

  // The owner's own tables come first, in their saved order. Every role
  // sees them; leads.read, which every role has, is what opens one.
  const current = view === 'table' && extra.table ? extra.table.id : null;
  const tables = (!perms || perms.includes('leads.read')) ? (extra.tables || []) : [];
  const tableTab = (t) => {
    const c = t.config || {};
    return `<a class="tab ttab${c.color ? ` tc-${escape_(c.color)}` : ''}${t.id === current ? ' on' : ''}" href="/leads?t=${Number(t.id)}" data-table="${Number(t.id)}">${
      c.icon ? `<span class="ticon" aria-hidden="true">${escape_(c.icon)}</span>` : ''}${escape_(t.name)}</a>`;
  };
  const manage = !perms || perms.includes('settings.write')
    ? '<button class="tab tabmanage" type="button" id="tablesbtn" title="Make, rename, reorder or delete tables">+ Tables</button>' : '';
  const tableStrip = tables.length || manage
    ? `${tables.map(tableTab).join('')}${manage}<span class="tabsep" aria-hidden="true"></span>` : '';
  const title = view === 'table' && extra.table ? extra.table.name : VIEWS[view];
  const exportHref = view === 'table' && extra.table ? `/leads?t=${Number(extra.table.id)}&amp;export=csv` : `/leads?p=${view}&amp;export=csv`;
  const whoLine = me
    ? `<span class="whoami muted" id="whoami"><strong>${escape_(me.name || me.email)}</strong> · ${escape_(me.roleName || me.role)} &nbsp;</span>`
    : extra.who ? `<span class="muted">${escape_(extra.who)} &nbsp;</span>` : '';

  const top = `
    <div class="top">
      <h1>Leads</h1>
      <span id="upcoming" hidden></span>
      <form method="post">${whoLine}
        <input type="hidden" name="action" value="logout">
        <button class="linkbtn" type="submit">Sign out</button></form>
    </div>
    <nav class="tabs" id="tabs">${tableStrip}${tabs.map(tab).join('')}</nav>`;

  if (view === 'users') {
    return page(title, `${top}
    <div class="banner" id="banner" hidden></div>
    <div id="users"></div>
    <dialog id="dlg"><div class="dlg" id="dlgbody"></div></dialog>
    <script type="application/json" id="data">${data}</script>`, null, nonce, '/crm/app.js');
  }

  const broken = view === 'table' && extra.table && extra.table.broken
    ? `<div class="banner warnbar">This table's filter no longer checks out (${escape_(extra.table.broken)}), so it shows nothing until it is edited.</div>` : '';
  return page(title, `${top}
    <div class="stats" id="stats" ${view === 'repair' || view === 'table' ? 'hidden' : ''}></div>${broken}
    <div class="banner" id="banner" hidden></div>
    <div class="tools" id="tools">
      <input type="search" id="q" placeholder="Search, or try city:marietta or is:unbilled" aria-label="Search">
      <select id="sf" aria-label="Filter"></select>
      <span class="muted" id="shown"></span>
      ${view === 'table' && (!perms || perms.includes('settings.write')) ? '<button class="linkbtn" type="button" id="edittable">Edit this table</button>' : ''}
      ${!perms || perms.includes('leads.export') ? `<a href="${exportHref}">Export all</a>
      <button class="linkbtn" type="button" id="exportfiltered" hidden></button>` : ''}
      ${!perms || perms.includes('leads.create') ? '<button class="linkbtn" type="button" id="newlead">New lead</button>' : ''}
    </div>
    <div class="quick" id="quick"></div>
    <div class="views" id="views"></div>
    <div class="bulkbar" id="bulkbar" hidden></div>
    <div class="gridwrap"><table><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table>
      <div class="cards" id="cards" hidden></div>
      <div class="empty" id="empty" hidden>Nothing here yet.</div></div>
    <div class="pager" id="pager"></div>
    <dialog id="dlg"><div class="dlg" id="dlgbody"></div></dialog>
    <script type="application/json" id="data">${data}</script>`, null, nonce, '/crm/app.js');
}

// Client side. Every customer-supplied value goes into the page through
// textContent or .value — never innerHTML — so nothing a form submits can
// run as markup.

