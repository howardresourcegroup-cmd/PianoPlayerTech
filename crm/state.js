// What every other module needs to agree on.
//
// `D` is the payload the server rendered into the page: the leads, the
// invoices, the status vocabularies, the referral counters. It is an object,
// so the modules that mutate it (D.ref after a referral changes, D.invoices
// after one is created) all see the same one.
//
// `state` exists because an ES module import is a read-only binding. The grid
// reassigns `rows` when a lead leaves the current tab, and the header
// reassigns the sort. Those cannot be exported as plain `let` and written
// from another file, so they live as properties on one shared object.

export const D = JSON.parse(document.getElementById('data').textContent);

export const view = D.view;

export const state = {
  // The leads on this tab. Replaced, not spliced, when one no longer belongs.
  rows: D.rows,
  // Which column the grid is sorted by, and which way. null means the order
  // the server sent, which already puts new leads first.
  sortKey: null,
  sortDir: 1
};

export const REF_LABEL = { sent: 'Sent — waiting', booked: 'Booked', no_booking: "Didn't book" };
export const INV_LABEL = { open: 'Unpaid', paid: 'Paid', void: 'Void', uncollectible: 'Uncollectible', draft: 'Draft' };
