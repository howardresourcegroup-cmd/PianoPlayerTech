// The row of counters above the grid.

import { D } from './state.js';
import { el } from './dom.js';

export function renderStats(){
  var box = document.getElementById('stats');
  if (box.hidden) return;
  var r = D.ref, owed = (r.booked - r.paid) * D.fee;
  // "Didn't book" and a raw paid count live in the filter; five boxes keep
  // the grid above the fold on a phone.
  var items = [
    [r.sent, 'Referred'], [r.sent - r.booked - r.lost, 'Waiting to hear'], [r.booked, 'Booked'],
    ['$' + owed, 'Owed to you', 'owed'], ['$' + (r.paid * D.fee), 'Earned']
  ];
  box.textContent = '';
  items.forEach(function(it){
    box.appendChild(el('div', {className:'stat' + (it[2] ? ' ' + it[2] : '')},
      [el('b', {text:String(it[0])}), el('span', {text:it[1]})]));
  });
}

// Recount after a change, from rows we can see plus the server's totals.
export function bumpRef(before, after){
  function add(r, s){
    if (!r.referred_at) return;
    D.ref.sent += s;
    if (r.referral_status === 'booked') D.ref.booked += s;
    if (r.referral_status === 'no_booking') D.ref.lost += s;
    if (r.referral_status === 'booked' && r.referral_paid_at) D.ref.paid += s;
  }
  add(before, -1); add(after, 1); renderStats();
}
