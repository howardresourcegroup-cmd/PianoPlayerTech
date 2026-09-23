// The bar that appears when rows are ticked.
//
// Every action here changes many leads at once, which is exactly the kind of
// thing that is easy to do by accident and hard to undo. So each one names
// the number and the change before it happens, and Archive -- the one that
// takes rows out of view -- says where they go and that they come back.
//
// After a change the affected rows are re-read from the server's answer
// rather than assumed: the reply reports how many actually changed, which is
// not always how many were asked for.

import { D, view, state } from './state.js';
import { el } from './dom.js';
import { post } from './api.js';

const label = (k) => (D.statusLabels && D.statusLabels[k]) || k;

function plural(n, one, many){ return n + ' ' + (n === 1 ? one : many); }

/**
 * Draw the bar for the current selection.
 *
 * @param onDone called after a successful change, with the server's reply
 *               and the ids that were sent
 */
export function renderBulkBar(onDone){
  var bar = document.getElementById('bulkbar');
  if (!bar) return;
  var ids = [...state.selected];
  bar.textContent = '';
  bar.hidden = ids.length === 0;
  if (!ids.length) return;

  bar.appendChild(el('span', {className:'count', text: plural(ids.length, 'lead selected', 'leads selected')}));

  var msg = el('span', {className:'bulkmsg'});

  function run(payload, confirmText, done, value){
    if (confirmText && !confirm(confirmText)) return;
    Array.prototype.forEach.call(bar.querySelectorAll('button,select'), function(c){ c.disabled = true; });
    msg.textContent = 'Working…';
    post(Object.assign({action:'bulk', ids:ids}, payload)).then(function(j){
      onDone(j, ids, done, value);
    }, function(e){
      Array.prototype.forEach.call(bar.querySelectorAll('button,select'), function(c){ c.disabled = false; });
      msg.textContent = e.message;
    });
  }

  if (view === 'archive') {
    bar.appendChild(el('button', {className:'go sm', type:'button', text:'Restore',
      on:{click:function(){ run({op:'restore'}, null, 'restore'); }}}));
  } else {
    // Status
    var st = el('select', {'aria-label':'Set status for the selected leads'});
    st.appendChild(el('option', {value:'', text:'Set status…'}));
    (D.setStatuses || []).forEach(function(k){
      st.appendChild(el('option', {value:k, text:label(k)}));
    });
    st.addEventListener('change', function(){
      if (!st.value) return;
      var to = st.value;
      st.value = '';
      run({op:'status', value:to},
        'Set ' + plural(ids.length, 'lead', 'leads') + ' to ' + label(to) + '?', 'status', to);
    });
    bar.appendChild(st);

    // Pipeline
    var pl = el('select', {'aria-label':'Move the selected leads to a pipeline'});
    pl.appendChild(el('option', {value:'', text:'Move to…'}));
    [['repair', 'Repair & Pneumatic'], ['tuning', 'Tuning']].forEach(function(p){
      pl.appendChild(el('option', {value:p[0], text:p[1]}));
    });
    pl.addEventListener('change', function(){
      if (!pl.value) return;
      var to = pl.value;
      pl.value = '';
      run({op:'pipeline', value:to},
        'Move ' + plural(ids.length, 'lead', 'leads') + ' to ' + to + '?', 'pipeline', to);
    });
    bar.appendChild(pl);

    bar.appendChild(el('button', {className:'ghost sm', type:'button', text:'Archive',
      on:{click:function(){
        run({op:'archive'},
          'Archive ' + plural(ids.length, 'lead', 'leads') + '? They leave this list and are ' +
          'deleted permanently after about ' + D.purgeDays + ' days. You can restore them before then.',
          'archive');
      }}}));
  }

  bar.appendChild(el('button', {className:'linkbtn', type:'button', text:'Clear',
    on:{click:function(){ state.selected.clear(); onDone(null, [], 'clear'); }}}));
  bar.appendChild(msg);
}

// What to say afterwards, including the case nobody plans for: some of them
// did not change.
export function bulkSummary(j){
  if (!j) return '';
  var out = plural(j.changed || 0, 'lead updated', 'leads updated');
  if (j.skipped) out += ', ' + j.skipped + ' skipped';
  return out;
}
