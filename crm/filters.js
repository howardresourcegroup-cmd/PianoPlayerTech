// The search box and the status dropdown, which narrow what the grid shows
// without asking the server for anything.

import { D, view } from './state.js';
import { el, q, sf } from './dom.js';

export const FILTERS = view === 'referrals'
  ? [['', 'All referrals'], ['ref:sent', 'Waiting to hear'], ['ref:booked', 'Booked'],
     ['ref:unpaid', 'Booked, not paid'], ['ref:paid', 'Paid'], ['ref:no_booking', "Didn't book"]]
  : [['', 'Every status'], ['open', 'Not closed']].concat(D.statuses.map(function(s){ return [s, s]; }));

// Called from app.js rather than run on import: a module that touches the
// page while it is still being imported is a module whose order matters.
export function initFilters(){
  FILTERS.forEach(function(f){ sf.appendChild(el('option', {value:f[0], text:f[1]})); });
}

export function passes(r){
  var f = sf.value;
  if (f === 'open' && r.status === 'closed') return false;
  if (f && f.indexOf('ref:') === 0) {
    var want = f.slice(4);
    if (want === 'unpaid') { if (r.referral_status !== 'booked' || r.referral_paid_at) return false; }
    else if (want === 'paid') { if (!r.referral_paid_at) return false; }
    else if (r.referral_status !== want) return false;
  } else if (f && f !== 'open' && r.status !== f) return false;
  var s = q.value.trim().toLowerCase();
  if (!s) return true;
  return ['name','phone','email','city','address','system','service','message','notes','id']
    .some(function(k){ return String(r[k] == null ? '' : r[k]).toLowerCase().indexOf(s) >= 0; });
}
