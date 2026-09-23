// The leads table: one row per lead, edited in place.
//
// Every cell writes straight to the server on change and flashes green or
// red. There is no save button and no dirty state, because a half-edited
// lead that looks saved is worse than a slow one.

import { D, view, state, INV_LABEL, PAGE_SIZES } from './state.js';
import { el, head, body, shown, empty, fmt, fmtLong, tel, flash } from './dom.js';
import { post } from './api.js';
import { COLS } from './columns.js';
import { passes, refreshMatcher } from './filters.js';
import { bumpRef } from './stats.js';
import { openLead, openRefer } from './record.js';
import { invById, renderBanner } from './invoices.js';
import { renderBulkBar, bulkSummary } from './bulkbar.js';

// The rows currently on screen, which is what "select all" means: ticking
// the header must never quietly select 5,000 leads you cannot see.
var visible = [];

function renderHead(){
  head.textContent = '';
  COLS.forEach(function(c, i){
    if (c.type === 'pick') {
      var all = visible.length > 0 && visible.every(function(r){ return state.selected.has(r.id); });
      var some = !all && visible.some(function(r){ return state.selected.has(r.id); });
      var box = el('input', {type:'checkbox', checked:all,
        'aria-label': all ? 'Clear the selection' : 'Select every row shown'});
      box.indeterminate = some;
      box.addEventListener('change', function(){
        visible.forEach(function(r){
          if (box.checked) state.selected.add(r.id); else state.selected.delete(r.id);
        });
        render();
      });
      var pth = el('th', {className:'sticky pickcol'}, [box]);
      pth.style.minWidth = c.w + 'px';
      head.appendChild(pth);
      return;
    }
    var th = el('th', {text: c.label + (state.sortKey === c.k ? (state.sortDir > 0 ? ' ▲' : ' ▼') : ''),
      className: (i === 0 ? 'sticky ' : '') + (state.sortKey === c.k ? 'sorted' : ''),
      on:{click:function(){ if (state.sortKey === c.k) state.sortDir = -state.sortDir; else { state.sortKey = c.k; state.sortDir = 1; } render(); }}});
    th.style.minWidth = c.w + 'px';
    head.appendChild(th);
  });
}

function cellSelect(r, c, td){
  var v = r[c.k] == null ? '' : r[c.k];
  var sel = el('select', {'aria-label':c.label});
  if (c.blank || !v) sel.appendChild(el('option', {value:'', text:'—'}));
  // A stored value nobody may choose any more — 'referred' — still has to
  // show on the leads that already carry it. Added disabled, so it displays
  // without being something you could pick for yourself.
  if (v && c.opts.indexOf(String(v)) < 0) {
    sel.appendChild(el('option', {value:String(v), disabled:true,
      text:(c.labels && c.labels[v]) || String(v)}));
  }
  c.opts.forEach(function(o){ sel.appendChild(el('option', {value:o, text:(c.labels && c.labels[o]) || o})); });
  sel.value = String(v);
  if (c.k === 'referral_status' && !r.referred_at) sel.disabled = true;
  sel.addEventListener('change', function(){
    if (!sel.value) { sel.value = String(r[c.k] || ''); return; }
    save(r, c.k, sel.value, td);
  });
  return sel;
}

function cell(r, c, i){
  var td = el('td', {className: i <= 1 ? 'sticky' : ''});
  td.style.minWidth = c.w + 'px'; td.style.maxWidth = (c.w + 80) + 'px';
  var v = r[c.k] == null ? '' : r[c.k];

  function input(){
    var inp = el('input', {value:String(v), 'aria-label':c.label});
    inp.addEventListener('change', function(){ save(r, c.k, inp.value, td); });
    return inp;
  }

  if (c.type === 'pick') {
    var box = el('input', {type:'checkbox', checked:state.selected.has(r.id), 'aria-label':'Select this lead'});
    box.addEventListener('change', function(){
      if (box.checked) state.selected.add(r.id); else state.selected.delete(r.id);
      // Redrawing the head keeps the select-all box honest, and the bar
      // appears or disappears with the selection.
      renderHead();
      renderBulkBar(afterBulk);
    });
    td.appendChild(box);
    td.className = 'sticky pickcol';
    return td;
  }

  if (c.type === 'name') {
    td.appendChild(el('div', {className:'namecell'}, [
      el('button', {className:'open', text:'Open', title:'Open the whole lead', type:'button',
        on:{click:function(){ openLead(r); }}}),
      view === 'archive' ? null : el('button', {className:'ghost sm arch', type:'button',
        text:'Archive', title:'Hide this lead; deleted permanently in about ' + D.purgeDays + ' days',
        on:{click:function(){ archiveAction(r, 'archive'); }}}),
      input()
    ]));
  } else if (c.type === 'phone') {
    td.appendChild(el('div', {className:'phonecell'}, [
      input(), tel(v) ? el('a', {href:'tel:' + tel(v), text:'call', title:'Call'}) : null
    ]));
  } else if (c.type === 'text') {
    td.appendChild(input());
  } else if (c.type === 'purgein') {
    var left = D.purgeDays -
      Math.floor((Date.now() - new Date(r.archived_at).getTime()) / 86400000);
    td.appendChild(el('div', {className:'ro' + (left <= 3 ? ' soon' : ''),
      text: left > 0 ? left + (left === 1 ? ' day' : ' days') : 'any time now'}));
  } else if (c.type === 'archiveacts') {
    td.appendChild(el('div', {className:'cellacts'}, [
      el('button', {className:'ghost sm', type:'button', text:'Restore',
        on:{click:function(){ archiveAction(r, 'restore'); }}}),
      el('button', {className:'danger', type:'button', text:'Delete now',
        on:{click:function(){ archiveAction(r, 'purge'); }}})
    ]));
  } else if (c.type === 'refer') {
    // Before a referral exists this column used to be a disabled dropdown —
    // the one control named "Referral", greyed out on exactly the leads you
    // want to refer. It is now the button that starts the referral.
    if (r.referred_at) {
      td.appendChild(cellSelect(r, c, td));
    } else if (r.pipeline === 'tuning') {
      td.appendChild(el('button', {className:'refergo', type:'button', text:'Refer →',
        title:'Send this lead to World Class',
        on:{click:function(){ openRefer(r); }}}));
    }
    // A repair lead gets nothing here: World Class takes tuning work. The
    // All tab mixes both pipelines, so this column would otherwise put a
    // prominent button on jobs that should never be handed over.
  } else if (c.type === 'select') {
    td.appendChild(cellSelect(r, c, td));
  } else if (c.type === 'paid') {
    var cb = el('input', {type:'checkbox', checked:!!v, 'aria-label':'Paid',
      title: r.referred_at ? (v ? 'Paid ' + fmtLong(v) : 'Mark as paid') : 'Not referred yet'});
    cb.disabled = !r.referred_at;
    cb.addEventListener('change', function(){
      var before = Object.assign({}, r);
      post({action:'paid', id:r.id, paid:cb.checked}).then(function(j){
        r.referral_paid_at = j.value;
        if (j.value) r.referral_status = 'booked';
        bumpRef(before, r); flash(td, true);
        if (j.value) render();
      }, function(e){ cb.checked = !cb.checked; flash(td, false); alert(e.message); });
    });
    td.appendChild(cb);
  } else if (c.type === 'inv') {
    var inv = v ? invById(v) : null;
    var billed = inv ? (inv.number || 'Invoice') + ' · ' + (INV_LABEL[inv.status] || inv.status)
      : (r.referral_status === 'booked' && !r.referral_paid_at ? 'Not billed yet' : '');
    td.appendChild(el('div', {className:'ro', text:billed, title:billed}));
  } else if (c.type === 'ref') {
    td.appendChild(el('div', {className:'ro', text:'PPT-' + r.id}));
  } else if (c.type === 'date') {
    td.appendChild(el('div', {className:'ro', text:fmt(v), title:fmtLong(v)}));
  } else {
    td.appendChild(el('div', {className:'ro', text:String(v), title:String(v)}));
  }
  return td;
}

function rowEl(r){
  var tr = el('tr', {className: r.status === 'new' ? 'is-new' : r.status === 'closed' ? 'done' : ''});
  COLS.forEach(function(c, i){ tr.appendChild(cell(r, c, i)); });
  return tr;
}

export function render(){
  refreshMatcher();
  var list = state.rows.filter(passes);
  if (state.sortKey) {
    list.sort(function(a, b){
      var x = a[state.sortKey] == null ? '' : String(a[state.sortKey]), y = b[state.sortKey] == null ? '' : String(b[state.sortKey]);
      if (!x && y) return 1; if (x && !y) return -1;
      return x.localeCompare(y, undefined, {numeric:true, sensitivity:'base'}) * state.sortDir;
    });
  }

  // Paging is over the filtered list. Filtering to four rows should show one
  // page of four, not page three of nothing -- so a page that no longer
  // exists falls back to the last one that does.
  var size = state.pageSize > 0 ? state.pageSize : list.length || 1;
  var pages = Math.max(1, Math.ceil(list.length / size));
  if (state.page >= pages) state.page = pages - 1;
  var from = state.page * size;
  visible = state.pageSize > 0 ? list.slice(from, from + size) : list;

  renderHead();
  body.textContent = '';
  var frag = document.createDocumentFragment();
  visible.forEach(function(r){ frag.appendChild(rowEl(r)); });
  body.appendChild(frag);
  empty.hidden = list.length > 0;
  renderBanner();
  renderBulkBar(afterBulk);
  renderPager(list.length, pages);

  var filtered = list.length !== state.rows.length;
  shown.textContent = !filtered && state.pageSize <= 0
    ? state.rows.length + (state.rows.length === 1 ? ' row' : ' rows')
    : (visible.length < list.length
        ? (from + 1) + '–' + (from + visible.length) + ' of ' + list.length
        : list.length + (filtered ? ' of ' + state.rows.length : (list.length === 1 ? ' row' : ' rows')));
}

function renderPager(total, pages){
  var box = document.getElementById('pager');
  if (!box) return;
  box.textContent = '';
  // Nothing to page through and nothing to choose: stay out of the way.
  if (total <= PAGE_SIZES[0] && state.pageSize === 100) { box.hidden = true; return; }
  box.hidden = false;

  var sizer = el('select', {'aria-label':'Rows per page'});
  PAGE_SIZES.forEach(function(n){
    sizer.appendChild(el('option', {value:String(n), text: n ? n + ' per page' : 'Show all'}));
  });
  sizer.value = String(state.pageSize);
  sizer.addEventListener('change', function(){
    state.pageSize = parseInt(sizer.value, 10);
    state.page = 0;
    render();
  });
  box.appendChild(sizer);

  if (pages > 1) {
    box.appendChild(el('button', {className:'ghost sm', type:'button', text:'‹ Previous',
      disabled: state.page === 0,
      on:{click:function(){ state.page--; render(); }}}));
    box.appendChild(el('span', {className:'muted', text:'Page ' + (state.page + 1) + ' of ' + pages}));
    box.appendChild(el('button', {className:'ghost sm', type:'button', text:'Next ›',
      disabled: state.page >= pages - 1,
      on:{click:function(){ state.page++; render(); }}}));
  }
}

// After a bulk change: drop the rows that left this tab, clear the tick
// boxes, and say what actually happened.
function afterBulk(j, ids, done, value){
  state.selected.clear();
  if (j) {
    var hit = {};
    ids.forEach(function(id){ hit[id] = true; });

    if (done === 'archive' || done === 'restore') {
      // Either way they no longer belong on this tab.
      state.rows = state.rows.filter(function(r){ return !hit[r.id]; });
    } else if (done === 'status' || done === 'pipeline') {
      // The server did it; carry it into the rows we are holding so the
      // grid shows the new value without a reload.
      state.rows.forEach(function(r){ if (hit[r.id]) r[done] = value; });
      if (done === 'pipeline' && (view === 'repair' || view === 'tuning') && value !== view) {
        state.rows = state.rows.filter(function(r){ return !hit[r.id]; });
      }
    }
  }
  render();
  if (j) {
    var note = document.getElementById('shown');
    var was = note.textContent;
    note.textContent = bulkSummary(j);
    setTimeout(function(){ if (note.textContent === bulkSummary(j)) note.textContent = was; }, 2500);
  }
}

function archiveAction(r, action){
  if (action === 'purge' &&
      !confirm('Delete ' + (r.name || 'this lead') +
               ' permanently? This cannot be undone.')) return;
  post({action:action, id:r.id}).then(function(){
    // It no longer belongs on this tab either way: archived leaves the
    // working views, restored leaves the Archive tab.
    state.rows = state.rows.filter(function(x){ return x !== r; });
    render();
  }, function(e){ alert(e.message); });
}

function save(r, field, value, td){
  var before = Object.assign({}, r);
  post({action:'update', id:r.id, field:field, value:value}).then(function(j){
    r[field] = j.value;
    if (field === 'referral_status' && j.value !== 'booked') r.referral_paid_at = null;
    if (field === 'referral_status') bumpRef(before, r);
    flash(td, true);
    // Moved to the other pipeline: it no longer belongs on this tab.
    if (field === 'pipeline' && (view === 'repair' || view === 'tuning') && j.value !== view) {
      state.rows = state.rows.filter(function(x){ return x !== r; });
    }
    if (field === 'status' || field === 'pipeline' || field === 'referral_status') render();
  }, function(e){ flash(td, false); alert(e.message); });
}
