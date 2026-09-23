// Saved views: the filter you use every Monday, kept.
//
// A view is the whole state of the list -- the search box, the status
// dropdown, the sort and the page size -- under a name. Applying one sets
// all of those and redraws, which is why it lives next to the filter bar
// rather than in a menu somewhere.
//
// Views are tied to the tab they were saved on. A Referrals view has
// is:unbilled in it and would mean nothing on Repair, so it is not offered
// there.

import { D, view, state } from './state.js';
import { el, q, sf } from './dom.js';
import { post } from './api.js';
import { paintChips } from './filters.js';

// Live list, replaced as views are saved and deleted.
var views = (D.views || []).slice();

// What is on screen right now.
export function currentConfig(){
  return {
    q: q.value, sf: sf.value, sortKey: state.sortKey, sortDir: state.sortDir,
    pageSize: state.pageSize, tab: view
  };
}

function sameAsCurrent(c){
  var now = currentConfig();
  return c.q === now.q && c.sf === now.sf && c.sortKey === now.sortKey &&
         c.sortDir === now.sortDir && c.pageSize === now.pageSize;
}

function apply(c, onChange){
  q.value = c.q || '';
  sf.value = c.sf || '';
  state.sortKey = c.sortKey || null;
  state.sortDir = c.sortDir === -1 ? -1 : 1;
  state.pageSize = typeof c.pageSize === 'number' ? c.pageSize : 100;
  state.page = 0;
  paintChips();
  onChange();
}

export function renderViews(onChange){
  var box = document.getElementById('views');
  if (!box) return;
  box.textContent = '';

  var mine = views.filter(function(v){ return !v.config.tab || v.config.tab === view; });

  mine.forEach(function(v){
    var on = sameAsCurrent(v.config);
    var wrap = el('span', {className:'vchip' + (on ? ' on' : '')});
    wrap.appendChild(el('button', {className:'vname', type:'button', text:v.name,
      title:'Apply this view', on:{click:function(){ apply(v.config, onChange); }}}));
    wrap.appendChild(el('button', {className:'vdel', type:'button', text:'×',
      title:'Delete this view', 'aria-label':'Delete the view ' + v.name,
      on:{click:function(){
        if (!confirm('Delete the saved view "' + v.name + '"? The leads are not affected.')) return;
        post({action:'viewDelete', viewId:v.id}).then(function(){
          views = views.filter(function(x){ return x !== v; });
          renderViews(onChange);
        }, function(e){ alert(e.message); });
      }}}));
    box.appendChild(wrap);
  });

  // Only worth offering when there is something to save.
  var cfg = currentConfig();
  var worthSaving = cfg.q || cfg.sf || cfg.sortKey;
  if (worthSaving && !mine.some(function(v){ return sameAsCurrent(v.config); })) {
    box.appendChild(el('button', {className:'vsave', type:'button', text:'+ Save this view',
      title:'Keep this search and filter under a name',
      on:{click:function(){ save(onChange); }}}));
  }
}

function save(onChange){
  var name = prompt('Name this view:', suggestName());
  if (name == null) return;
  name = name.trim();
  if (!name) return;
  post({action:'viewSave', name:name, config:currentConfig()}).then(function(j){
    views.push(j.view);
    renderViews(onChange);
  }, function(e){ alert(e.message); });
}

// A name you would have typed anyway, so saving is one keystroke.
function suggestName(){
  var c = currentConfig();
  var bits = [];
  if (c.q) bits.push(c.q);
  if (c.sf && c.sf !== 'open') bits.push((D.statusLabels && D.statusLabels[c.sf]) || c.sf);
  else if (c.sf === 'open') bits.push('not closed');
  return bits.join(' · ').slice(0, 60) || 'My view';
}
