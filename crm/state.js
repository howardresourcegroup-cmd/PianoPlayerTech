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
  sortDir: 1,

  // Lead ids ticked for a bulk action. A Set because the question asked of
  // it, on every cell of every row, is "is this one selected".
  selected: new Set(),

  // Paging is over the filtered list, not the whole table: filtering to
  // four rows should show one page of four, not page three of nothing.
  page: 0,
  pageSize: 100
};

// How many rows at once. 'All' exists because this table is usually small
// and paging a 37-row list is theatre.
export const PAGE_SIZES = [50, 100, 250, 0];

export const REF_LABEL = { sent: 'Sent — waiting', booked: 'Booked', no_booking: "Didn't book" };
export const INV_LABEL = { open: 'Unpaid', paid: 'Paid', void: 'Void', uncollectible: 'Uncollectible', draft: 'Draft' };
