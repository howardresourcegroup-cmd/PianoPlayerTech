// The CRM client application: entry point and wiring.
//
// Served as a static asset and loaded as a module, rather than inlined into
// the page. It lived in a template literal until 2026-09-22, where no linter
// or syntax check could see it and a broken grid could ship unnoticed.
//
// Public by URL and deliberately so: this is interface code with no secrets
// in it. Every lead it displays still comes from /leads, behind Cloudflare
// Access.
//
// The modules:
//   state.js     the server's payload, and the few things that get reassigned
//   dom.js       element refs, `el`, formatting, the dialog helpers
//   api.js       POST /leads
//   columns.js   which columns each tab shows
//   filters.js   the search box and status dropdown
//   stats.js     the counters above the grid
//   grid.js      the leads table
//   record.js    the lead record and the referral form
//   invoices.js  Stripe invoicing and the Invoices tab
//   outreach.js  the Emails tab: the queue of drafted emails, and their settings
//   newlead.js   the New lead form, for a phone call or a walk-in
//
// Nothing above touches the page while it is being imported. Every module
// exports functions; this file decides when they run. That is what keeps
// grid.js and record.js free to import each other.

import { view } from './state.js';
import { dlg, q, sf, debounce } from './dom.js';
import { initFilters } from './filters.js';
import { renderStats } from './stats.js';
import { render } from './grid.js';
import { initInvoices } from './invoices.js';
import { renderUpcoming } from './upcoming.js';
import { state } from './state.js';
import { openLead } from './record.js';
import { initOutreach } from './outreach.js';
import { initNewLead } from './newlead.js';

// Clicking the backdrop closes the dialog. A click inside it has a different
// target, so this does not fire on the form.
dlg.addEventListener('click', function(e){ if (e.target === dlg) dlg.close(); });

// On a phone the tabs are one scrolling strip. Whatever tab this is, it
// should be visible without a swipe.
var onTab = document.querySelector('.tab.on');
if (onTab && onTab.scrollIntoView) onTab.scrollIntoView({block:'nearest', inline:'center'});

if (view === 'invoices') {
  initInvoices();
} else if (view === 'emails') {
  initOutreach();
} else {
  initFilters(render);
  // A chip or a dropdown is one decision, so it redraws at once. Typing is
  // many, so it waits for a pause.
  q.addEventListener('input', debounce(render, 120));
  sf.addEventListener('change', render);
  renderStats();
  render();
  initNewLead();
  // The follow-ups the server has been counting all along. Opening one is
  // only offered when the lead is on this tab -- the panel lists them all.
  renderUpcoming(function(leadId, probe){
    var r = state.rows.find(function(x){ return x.id === leadId; });
    if (probe) return !!r;
    if (r) openLead(r, 'activity');
    return true;
  });
}
