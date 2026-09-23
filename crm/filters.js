// What narrows the grid: the search box, the status dropdown, and the row
// of quick filters.
//
// The three compose with AND, which is what people expect from a filter bar:
// picking "Booked" and typing "marietta" means booked leads in Marietta, not
// one or the other.
//
// A quick filter is not a fourth mechanism -- it writes a query into the
// search box. That keeps one code path, and it is also how somebody learns
// the grammar: click "Not billed yet", see `is:unbilled` appear, edit it.

import { D, view } from './state.js';
import { el, q, sf } from './dom.js';
import { makeMatcher } from './search.js';

const label = (k) => (D.statusLabels && D.statusLabels[k]) || k;

// The status dropdown. Built from the pipeline's own vocabulary, so adding
// a status to the database is enough -- no deploy.
export const FILTERS = view === 'referrals'
  ? [['', 'All referrals'], ['ref:sent', 'Waiting to hear'], ['ref:booked', 'Booked'],
     ['ref:unpaid', 'Booked, not paid'], ['ref:paid', 'Paid'], ['ref:no_booking', "Didn't book"]]
  : [['', 'Every status'], ['open', 'Not closed']]
      .concat((D.statuses || []).map(function(s){ return [s, label(s)]; }));

// Canned queries. Each is a real search, shown in the box when clicked.
const QUICK = view === 'referrals'
  ? [['', 'All'], ['is:unbilled', 'Not billed yet'], ['is:unpaid', 'Owed to you'],
     ['is:paid', 'Paid'], ['-is:booked', "Haven't booked"]]
  : view === 'archive'
  ? [['', 'All'], ['has:email', 'Has an email'], ['is:referred', 'Was referred']]
  : [['', 'All'], ['is:open', 'Live work'], ['is:new', 'New'],
     ['is:referred', 'Referred'], ['is:unbilled', 'Not billed yet'],
     ['-has:phone', 'No phone number']];

export function initFilters(onChange){
  FILTERS.forEach(function(f){ sf.appendChild(el('option', {value:f[0], text:f[1]})); });

  var bar = document.getElementById('quick');
  if (!bar) return;
  QUICK.forEach(function(f){
    var b = el('button', {className:'chip', type:'button', text:f[1], title: f[0] || 'Everything'});
    b.addEventListener('click', function(){
      // Toggle: clicking the active chip clears it.
      q.value = (q.value.trim() === f[0]) ? '' : f[0];
      paintChips();
      onChange();
    });
    b.dataset.query = f[0];
    bar.appendChild(b);
  });
  paintChips();
  q.addEventListener('input', paintChips);
}

// A chip lights up when the box holds exactly its query, so it reflects the
// state rather than pretending to own it.
export function paintChips(){
  var bar = document.getElementById('quick');
  if (!bar) return;
  var cur = q.value.trim();
  Array.prototype.forEach.call(bar.children, function(b){
    var on = b.dataset.query === cur || (!b.dataset.query && !cur);
    b.className = 'chip' + (on ? ' on' : '');
  });
}

export function passes(r){
  var f = sf.value;
  if (f === 'open') {
    var open = D.openStatuses || [];
    if (open.length ? open.indexOf(r.status) < 0 : r.status === 'closed') return false;
  } else if (f && f.indexOf('ref:') === 0) {
    var want = f.slice(4);
    if (want === 'unpaid') { if (r.referral_status !== 'booked' || r.referral_paid_at) return false; }
    else if (want === 'paid') { if (!r.referral_paid_at) return false; }
    else if (r.referral_status !== want) return false;
  } else if (f && r.status !== f) return false;

  return matcher(r);
}

// Rebuilt when the query changes rather than per row: parsing a query once
// for 5,000 rows is the difference between typing feeling instant and not.
var matcher = makeMatcher('');
export function refreshMatcher(){ matcher = makeMatcher(q.value); }
