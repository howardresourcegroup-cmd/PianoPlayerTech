// The leads table: one row per lead, edited in place.
//
// Every cell writes straight to the server on change and flashes green or
// red. There is no save button and no dirty state, because a half-edited
// lead that looks saved is worse than a slow one.

import { D, view, state, INV_LABEL, PAGE_SIZES } from './state.js';
import { el, head, body, shown, empty, fmt, fmtLong, fmtWhen, tel, flash } from './dom.js';
import { post } from './api.js';
import { COLS } from './columns.js';
import { passes, refreshMatcher } from './filters.js';
import { bumpRef } from './stats.js';
import { openLead, openRefer } from './record.js';
import { invById, renderBanner } from './invoices.js';
import { renderBulkBar, bulkSummary } from './bulkbar.js';
import { editableText, editableChoice, BLANK } from './edit.js';
import { cardFor, isPhone, onLayoutChange } from './cards.js';
import { isPastDue } from './fields.js';
import { renderViews } from './views.js';
import { loadWidths, addResizer } from './widths.js';
import { download } from './export.js';

// An ISO instant as the value a datetime-local input wants: local wall-clock
// time with no zone, which is why it cannot just be sliced off the ISO string.
function toLocalInput(iso){
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var p = function(n){ return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// The rows currently on screen, which is what "select all" means: ticking
// the header must never quietly select 5,000 leads you cannot see.
var visible = [];

// Column widths this browser remembers, keyed by column so the same column
// keeps its width when the tab changes shape.
var widths = loadWidths();
const colKey = (c, i) => c.k + ':' + i;

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
      return;   // the tick column is a fixed width; there is nothing to drag
    }
    var th = el('th', {text: c.label + (state.sortKey === c.k ? (state.sortDir > 0 ? ' ▲' : ' ▼') : ''),
      className: (i === 0 ? 'sticky ' : '') + (state.sortKey === c.k ? 'sorted' : ''),
      on:{click:function(){ if (state.sortKey === c.k) state.sortDir = -state.sortDir; else { state.sortKey = c.k; state.sortDir = 1; } render(); }}});
    var w = widths[colKey(c, i)] || c.w;
    th.style.minWidth = w + 'px';
    if (widths[colKey(c, i)]) th.style.maxWidth = w + 'px';
    addResizer(th, colKey(c, i), widths, render);
    head.appendChild(th);
  });
}

// A status or pipeline: a quiet pill until you click it.
function cellSelect(r, c, td){
  return editableChoice({
    value: r[c.k] == null ? '' : r[c.k],
    label: c.label,
    blank: !!c.blank,
    options: (c.opts || []).map(function(o){
      return { value: o, label: (c.labels && c.labels[o]) || o };
    }),
    allLabels: c.k === 'status' ? D.statusLabels : (c.labels || null),
    tone: c.k === 'status' ? statusTone : null,
    disabled: c.k === 'referral_status' && !r.referred_at,
    disabledReason: 'Not referred yet',
    save: function(v){ save(r, c.k, v, td); }
  });
}

// Colour carries meaning only where it earns it: work still open, work won,
// work lost. Everything else stays neutral so the exceptions stand out.
function statusTone(v){
  if (v === 'new') return 'is-newpill';
  if (v === 'paid' || v === 'completed') return 'is-won';
  if (v === 'lost' || v === 'closed') return 'is-done';
  return '';
}

function cell(r, c, i){
  var td = el('td', {className: i <= 1 ? 'sticky' : ''});
  var w = widths[colKey(c, i)] || c.w;
  td.style.minWidth = w + 'px';
  td.style.maxWidth = (widths[colKey(c, i)] ? w : w + 80) + 'px';
  var v = r[c.k] == null ? '' : r[c.k];

  function text(opts){
    return editableText(Object.assign({
      value: v, label: c.label,
      save: function(next){ save(r, c.k, next, td); }
    }, opts || {}));
  }

  if (c.type === 'pick') {
    var box = el('input', {type:'checkbox', checked:state.selected.has(r.id), 'aria-label':'Select this lead'});
    box.addEventListener('change', function(){
      if (box.checked) state.selected.add(r.id); else state.selected.delete(r.id);
      renderHead();
      renderBulkBar(afterBulk);
    });
    td.appendChild(box);
    td.className = 'sticky pickcol';
    return td;
  }

  if (c.type === 'name') {
    // The name is the row's handle: it opens the record. Editing it is the
    // rarer act, so it moves to the pencil that appears on hover.
    var name = el('button', {className:'namebtn', type:'button', text: v || '(no name)',
      title:'Open this lead', on:{click:function(){ openLead(r); }}});
    var pencil = el('button', {className:'inlineedit', type:'button', text:'✎',
      title:'Rename', 'aria-label':'Rename this lead'});
    var holder = el('div', {className:'namecell'}, [name, pencil]);
    pencil.addEventListener('click', function(){
      holder.textContent = '';
      var inp = el('input', {value:String(v), 'aria-label':'Name'});
      var done = false;
      function finish(commit){
        if (done) return; done = true;
        var next = inp.value;
        td.textContent = ''; td.appendChild(cell(r, c, i));
        if (commit && next !== String(v)) save(r, c.k, next, td);
      }
      inp.addEventListener('keydown', function(e){
        if (e.key === 'Escape') { done = true; td.textContent = ''; td.appendChild(cell(r, c, i)); }
        else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      });
      inp.addEventListener('blur', function(){ finish(true); });
      holder.appendChild(inp); inp.focus(); inp.select();
    });
    td.appendChild(holder);
    return td;
  }

  if (c.type === 'phone') {
    var wrap = el('div', {className:'cellv phonecell'});
    wrap.appendChild(text());
    if (tel(v)) wrap.appendChild(el('a', {className:'callico', href:'tel:' + tel(v),
      text:'call', title:'Call ' + (r.name || 'this lead')}));
    td.appendChild(wrap);
    return td;
  }

  if (c.type === 'text') { td.appendChild(text()); return td; }
  if (c.type === 'long') { td.appendChild(text({ multi: true })); return td; }

  if (c.type === 'when') {
    // Read as a date, edit as a picker. An unscheduled lead shows a dash,
    // not mm/dd/yyyy -- most leads have no date and that noise was on
    // every one of them.
    td.appendChild(editableWhen(r, td));
    return td;
  }

  if (c.type === 'purgein') {
    var left = D.purgeDays -
      Math.floor((Date.now() - new Date(r.archived_at).getTime()) / 86400000);
    td.appendChild(el('div', {className:'ro' + (left <= 3 ? ' soon' : ''),
      text: left > 0 ? left + (left === 1 ? ' day' : ' days') : 'any time now'}));
    return td;
  }

  if (c.type === 'archiveacts') {
    td.appendChild(el('div', {className:'cellacts'}, [
      el('button', {className:'ghost sm', type:'button', text:'Restore',
        on:{click:function(){ archiveAction(r, 'restore'); }}}),
      el('button', {className:'danger', type:'button', text:'Delete now',
        on:{click:function(){ archiveAction(r, 'purge'); }}})
    ]));
    return td;
  }

  if (c.type === 'refer') {
    if (r.referred_at) td.appendChild(cellSelect(r, c, td));
    else if (r.pipeline === 'tuning') {
      td.appendChild(el('button', {className:'refergo', type:'button', text:'Refer →',
        title:'Send this lead to World Class',
        on:{click:function(){ openRefer(r); }}}));
    }
    // A repair lead gets nothing here: World Class takes tuning work.
    return td;
  }

  if (c.type === 'select') { td.appendChild(cellSelect(r, c, td)); return td; }

  if (c.type === 'paid') {
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
    return td;
  }

  if (c.type === 'inv') {
    var inv = v ? invById(v) : null;
    var billed = inv ? (inv.number || 'Invoice') + ' · ' + (INV_LABEL[inv.status] || inv.status)
      : (r.referral_status === 'booked' && !r.referral_paid_at ? 'Not billed yet' : '');
    td.appendChild(el('div', {className:'ro' + (billed ? '' : ' empty'), text:billed || BLANK, title:billed}));
    return td;
  }

  if (c.type === 'ref') {
    td.appendChild(el('div', {className:'ro', text:'PPT-' + r.id}));
    return td;
  }

  if (c.type === 'date') {
    td.appendChild(el('div', {className:'ro' + (v ? '' : ' empty'), text:fmt(v) || BLANK, title:fmtLong(v)}));
    return td;
  }

  td.appendChild(el('div', {className:'ro' + (v ? '' : ' empty'), text:String(v) || BLANK, title:String(v)}));
  return td;
}

// The scheduled time: text until clicked, then a real picker.
function editableWhen(r, td){
  var host = el('div', {className:'cellv'});

  function show(){
    host.textContent = '';
    var v = r.scheduled_at;
    var late = isPastDue(r);
    var view = el('button', {type:'button',
      className:'val whenval' + (v ? (late ? ' late' : '') : ' empty'),
      text: v ? fmtWhen(v) : BLANK,
      title: v ? (late ? 'This job time has gone by' : fmtLong(v)) : 'Not scheduled',
      'aria-label':'Scheduled' + (v ? ': ' + fmtLong(v) : ': not yet')});
    view.addEventListener('click', edit);
    host.appendChild(view);
  }

  function edit(){
    host.textContent = '';
    var inp = el('input', {type:'datetime-local', value: toLocalInput(r.scheduled_at), 'aria-label':'Scheduled'});
    var done = false;
    function finish(commit){
      if (done) return; done = true;
      var iso = inp.value ? new Date(inp.value).toISOString() : '';
      var changed = iso !== (r.scheduled_at || '');
      show();
      if (commit && changed) save(r, 'scheduled_at', iso, td);
    }
    inp.addEventListener('keydown', function(e){
      if (e.key === 'Escape') { done = true; show(); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    });
    inp.addEventListener('change', function(){ finish(true); });
    inp.addEventListener('blur', function(){ finish(true); });
    host.appendChild(inp);
    inp.focus();
  }

  show();
  return host;
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

  // Below 760px the table becomes a list of cards. Different elements, not
  // a reflowed <table>: reflowing one loses the semantics a screen reader
  // uses and fights every fixed width the grid sets.
  var phone = isPhone();
  var table = document.querySelector('.gridwrap table');
  var cards = document.getElementById('cards');
  if (table) table.hidden = phone;
  if (cards) cards.hidden = !phone;

  if (phone && cards) {
    cards.textContent = '';
    var cfrag = document.createDocumentFragment();
    visible.forEach(function(r){ cfrag.appendChild(cardFor(r, cardHandlers)); });
    cards.appendChild(cfrag);
  } else {
    renderHead();
    body.textContent = '';
    var frag = document.createDocumentFragment();
    visible.forEach(function(r){ frag.appendChild(rowEl(r)); });
    body.appendChild(frag);
  }
  empty.hidden = list.length > 0;
  renderBanner();
  renderBulkBar(afterBulk);
  renderViews(render);
  renderPager(list.length, pages);
  paintExport(list);

  var filtered = list.length !== state.rows.length;
  shown.textContent = !filtered && state.pageSize <= 0
    ? state.rows.length + (state.rows.length === 1 ? ' row' : ' rows')
    : (visible.length < list.length
        ? (from + 1) + '–' + (from + visible.length) + ' of ' + list.length
        : list.length + (filtered ? ' of ' + state.rows.length : (list.length === 1 ? ' row' : ' rows')));
}

// The tab's own link exports the whole view, which is right for a backup and
// wrong after you have narrowed to eleven leads. This offers the narrowed
// list, and only when it is actually narrower.
function paintExport(list){
  var btn = document.getElementById('exportfiltered');
  if (!btn) return;
  var filtered = list.length !== state.rows.length;
  btn.hidden = !filtered;
  btn.textContent = 'Export these ' + list.length;
  btn.onclick = function(){ download(list, view, 'filtered'); };
}

// What a card can do, wired to the same functions the table cells use.
var cardHandlers = {
  onOpen: function(r){ openLead(r); },
  onRefer: function(r){ openRefer(r); },
  onSave: function(r, field, value, host){ save(r, field, value, host); },
  onArchive: function(r){ archiveAction(r, 'archive'); },
  // Just this card and the bar. Re-rendering the whole list on every tick
  // rebuilt sixty cards and threw away the scroll position, which on a
  // phone reads as the app losing your place.
  onToggle: function(r, on, card){
    if (on) state.selected.add(r.id); else state.selected.delete(r.id);
    if (card) card.classList.toggle('picked', on);
    renderBulkBar(afterBulk);
  }
};

// Rotating a phone, or dragging a desktop window narrow, changes which
// layout is right. Re-render only when the mode actually flips.
onLayoutChange(function(){ render(); });

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
