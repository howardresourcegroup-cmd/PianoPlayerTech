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
//
// Nothing above touches the page while it is being imported. Every module
// exports functions; this file decides when they run. That is what keeps
// grid.js and record.js free to import each other.

import { view } from './state.js';
import { dlg, q, sf } from './dom.js';
import { initFilters } from './filters.js';
import { renderStats } from './stats.js';
import { render } from './grid.js';
import { initInvoices } from './invoices.js';

// Clicking the backdrop closes the dialog. A click inside it has a different
// target, so this does not fire on the form.
dlg.addEventListener('click', function(e){ if (e.target === dlg) dlg.close(); });

if (view === 'invoices') {
  initInvoices();
} else {
  initFilters(render);
  q.addEventListener('input', render);
  sf.addEventListener('change', render);
  renderStats();
  render();
}
