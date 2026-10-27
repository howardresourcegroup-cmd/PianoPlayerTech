// Custom tables: the owner's own tabs, and the editor that makes them.
//
// A table is a saved view promoted to a tab (functions/_lib/views.js keeps
// both in one table). Its filter runs on the server, so this file only ever
// builds a description -- field, operator, value -- out of the vocabulary
// the server sent in D.tableSchema, and shows the server's own message when
// it says no. Nothing here decides what a role may see.
//
// Only a role with settings.write is sent the schema, and only that role
// gets the "+ Tables" and "Edit this table" buttons. The server checks the
// permission again on every save.

import { D, TABLE, TYPE_LABEL } from './state.js';
import { el, dlg, dlgbody, dlgHeader, showDlg } from './dom.js';
import { post } from './api.js';
import { CATALOG } from './columns.js';

var S = D.tableSchema || null;
var tables = (D.tables || []).slice();

var OP_LABEL = {
  is: 'is', is_not: 'is not', contains: 'contains', not_contains: "doesn't contain",
  starts_with: 'starts with', is_empty: 'is blank', not_empty: 'is not blank',
  in: 'is any of', not_in: 'is none of', is_me: 'is whoever is looking',
  after: 'on or after', before: 'before', between: 'between', last_days: 'in the last … days',
  gt: 'more than $', gte: 'at least $', lt: 'less than $', lte: 'at most $'
};
var COLOR_LABEL = { '': 'None', gold: 'Gold', blue: 'Blue', green: 'Green', red: 'Red',
  purple: 'Purple', teal: 'Teal', gray: 'Gray' };
var SORT_LABEL = { created_at: 'Received', updated_at: 'Last changed', scheduled_at: 'Scheduled',
  name: 'Name', status: 'Status', city: 'City', service: 'Service', pipeline: 'Pipeline',
  category: 'Category', quoted_cents: 'Quoted amount' };

// The choices for an enum field, as [value, label].
function choices(key, f){
  if (key === 'status') {
    return (D.statuses || []).map(function(s){ return [s, (D.statusLabels && D.statusLabels[s]) || s]; });
  }
  var labels = key === 'category' ? (D.categoryLabels || {})
    : key === 'customer_type' ? TYPE_LABEL
    : key === 'pipeline' ? { repair: 'Repair', tuning: 'Tuning' } : {};
  return (f.values || []).map(function(v){ return [v, labels[v] || v]; });
}

function select(pairs, value, label){
  var s = el('select', {'aria-label': label || ''});
  pairs.forEach(function(p){ s.appendChild(el('option', {value: p[0], text: p[1]})); });
  if (value != null) s.value = value;
  return s;
}

// ----------------------------------------------------------- one rule

function ruleRow(rule, onRemove){
  var row = el('div', {className: 'rule'});
  var fieldKeys = Object.keys(S.fields);
  var field = select(fieldKeys.map(function(k){ return [k, S.fields[k].label]; }), rule.field || fieldKeys[0], 'Field');
  var op = el('select', {'aria-label': 'Operator'});
  var holder = el('span', {className: 'vals'});
  var read = function(){ return undefined; };

  function paintOps(keep){
    var f = S.fields[field.value];
    op.textContent = '';
    f.ops.forEach(function(o){ op.appendChild(el('option', {value: o, text: OP_LABEL[o] || o})); });
    if (keep && f.ops.indexOf(keep) >= 0) op.value = keep;
  }

  // The value widget for this field and operator, and how to read it back.
  function paintValue(v){
    holder.textContent = '';
    var key = field.value, f = S.fields[key], o = op.value;
    if (o === 'is_empty' || o === 'not_empty' || o === 'is_me') { read = function(){ return undefined; }; return; }
    if (f.type === 'enum' || f.type === 'status') {
      var picked = Array.isArray(v) ? v : [];
      var boxes = choices(key, f).map(function(c){
        var cb = el('input', {type: 'checkbox', value: c[0], checked: picked.indexOf(c[0]) >= 0});
        holder.appendChild(el('label', null, [cb, document.createTextNode(c[1])]));
        return cb;
      });
      read = function(){ return boxes.filter(function(b){ return b.checked; }).map(function(b){ return b.value; }); };
      return;
    }
    if (f.type === 'bool') {
      var yn = select([['true', 'yes'], ['false', 'no']], v === false ? 'false' : 'true', f.label);
      holder.appendChild(yn);
      read = function(){ return yn.value === 'true'; };
      return;
    }
    if (o === 'between') {
      var type = f.type === 'date' ? 'date' : 'number';
      var a = el('input', {type: type, value: Array.isArray(v) ? v[0] : '', 'aria-label': 'From'});
      var b = el('input', {type: type, value: Array.isArray(v) ? v[1] : '', 'aria-label': 'To'});
      holder.appendChild(a); holder.appendChild(document.createTextNode('and')); holder.appendChild(b);
      read = function(){ return type === 'number' ? [Number(a.value), Number(b.value)] : [a.value, b.value]; };
      return;
    }
    var inputType = f.type === 'date' && o !== 'last_days' ? 'date'
      : f.type === 'money' || o === 'last_days' ? 'number' : 'text';
    var inp = el('input', {type: inputType, value: v == null ? '' : String(v), 'aria-label': f.label,
      placeholder: f.type === 'person' ? 'name@example.com' : ''});
    if (inputType === 'number') { inp.min = '0'; inp.step = o === 'last_days' ? '1' : '0.01'; }
    holder.appendChild(inp);
    read = function(){ return inputType === 'number' ? (inp.value === '' ? '' : Number(inp.value)) : inp.value; };
  }

  paintOps(rule.op);
  paintValue(rule.value);
  field.addEventListener('change', function(){ paintOps(null); paintValue(undefined); });
  op.addEventListener('change', function(){ paintValue(undefined); });

  row.appendChild(field);
  row.appendChild(op);
  row.appendChild(holder);
  row.appendChild(el('button', {className: 'x', type: 'button', text: '×', title: 'Remove this rule',
    'aria-label': 'Remove this rule', on: {click: onRemove}}));
  return { node: row, value: function(){
    var out = { field: field.value, op: op.value };
    var v = read();
    if (v !== undefined) out.value = v;
    return out;
  }};
}

// --------------------------------------------------------- the editor

export function openEditor(t){
  if (!S) return;
  var cfg = (t && t.config) || { rules: [], columns: null, sort: null, color: '', icon: '' };
  dlgbody.textContent = '';
  dlgHeader(t ? 'Edit table' : 'New table',
    'A table is a tab of leads that match every rule below. Everyone sees the tab; what each person can do in it is still up to their role.');
  var box = el('div', {className: 'tedit'});

  var name = el('input', {type: 'text', className: 'tname', value: t ? t.name : '', maxLength: 60,
    placeholder: 'e.g. Open pneumatic jobs', 'aria-label': 'Table name'});
  box.appendChild(el('label', {text: 'Name'})); box.appendChild(name);

  // Colour and icon: one tap each, from the lists the server accepts.
  var color = cfg.color || '', icon = cfg.icon || '';
  function swatches(list, cur, labelOf, onPick){
    var wrap = el('div', {className: 'swatches'});
    list.forEach(function(v){
      var b = el('button', {type: 'button', className: 'sw' + (v ? ' tc-' + v : '') + (v === cur ? ' on' : ''),
        text: labelOf(v), title: labelOf(v) || 'None', 'aria-pressed': String(v === cur)});
      b.addEventListener('click', function(){
        Array.prototype.forEach.call(wrap.children, function(x){ x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
        b.classList.add('on'); b.setAttribute('aria-pressed', 'true');
        onPick(v);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }
  var looks = el('div', {className: 'row'}, [
    el('div', null, [el('label', {text: 'Colour'}),
      swatches(S.colors, color, function(v){ return COLOR_LABEL[v] || v; }, function(v){ color = v; })]),
    el('div', null, [el('label', {text: 'Icon'}),
      swatches(S.icons, icon, function(v){ return v || 'None'; }, function(v){ icon = v; })])
  ]);
  box.appendChild(looks);

  // Rules.
  box.appendChild(el('label', {text: 'Show leads where every rule matches'}));
  var ruleBox = el('div');
  var rules = [];
  function addRule(r){
    var made = ruleRow(r || {}, function(){
      rules = rules.filter(function(x){ return x !== made; });
      ruleBox.removeChild(made.node);
    });
    rules.push(made);
    ruleBox.appendChild(made.node);
  }
  (cfg.rules || []).forEach(addRule);
  box.appendChild(ruleBox);
  box.appendChild(el('button', {className: 'linkbtn', type: 'button', text: '+ Add a rule',
    on: {click: function(){ addRule({}); }}}));
  box.appendChild(el('p', {className: 'muted', text: 'Archived leads stay out unless a rule asks for them. With no rules at all, the table shows every live lead.'}));

  // Columns: ticked ones, in order, then the rest.
  box.appendChild(el('label', {text: 'Columns (name is always first)'}));
  var chosen = (cfg.columns || S.defaultColumns).slice();
  var order = chosen.concat(S.columns.filter(function(k){ return chosen.indexOf(k) < 0; }));
  var on = {};
  chosen.forEach(function(k){ on[k] = true; });
  var list = el('ul', {className: 'cols'});
  function paintCols(){
    list.textContent = '';
    order.forEach(function(k, i){
      var cb = el('input', {type: 'checkbox', checked: !!on[k], 'aria-label': 'Show ' + ((CATALOG[k] && CATALOG[k].label) || k)});
      cb.addEventListener('change', function(){ on[k] = cb.checked; li.className = cb.checked ? '' : 'off'; });
      var up = el('button', {type: 'button', className: 'mv', text: '↑', disabled: i === 0, 'aria-label': 'Move up',
        on: {click: function(){ order.splice(i - 1, 0, order.splice(i, 1)[0]); paintCols(); }}});
      var down = el('button', {type: 'button', className: 'mv', text: '↓', disabled: i === order.length - 1, 'aria-label': 'Move down',
        on: {click: function(){ order.splice(i + 1, 0, order.splice(i, 1)[0]); paintCols(); }}});
      var li = el('li', {className: on[k] ? '' : 'off'}, [cb, up, down,
        document.createTextNode((CATALOG[k] && CATALOG[k].label) || k)]);
      list.appendChild(li);
    });
  }
  paintCols();
  box.appendChild(list);

  // Sort.
  var sortKey = select([['', 'New first, then newest']].concat(S.sorts.map(function(k){ return [k, SORT_LABEL[k] || k]; })),
    cfg.sort ? cfg.sort.key : '', 'Sort by');
  var sortDir = select([['desc', 'newest / largest first'], ['asc', 'oldest / smallest first']],
    cfg.sort ? cfg.sort.dir : 'desc', 'Sort direction');
  box.appendChild(el('div', {className: 'row'}, [
    el('div', null, [el('label', {text: 'Sort by'}), sortKey]),
    el('div', null, [el('label', {text: 'Direction'}), sortDir])
  ]));

  var msg = el('p', {className: 'warn', role: 'alert'});
  var save = el('button', {className: 'go', type: 'button', text: t ? 'Save table' : 'Make table'});
  var acts = el('div', {className: 'acts'}, [save]);
  if (t) {
    acts.appendChild(el('button', {className: 'ghost', type: 'button', text: 'Duplicate',
      on: {click: function(){ duplicate(t, msg); }}}));
    acts.appendChild(el('button', {className: 'danger', type: 'button', text: 'Delete',
      on: {click: function(){ remove(t, msg); }}}));
  }
  box.appendChild(msg);
  box.appendChild(acts);
  dlgbody.appendChild(box);

  function config(){
    var cols = order.filter(function(k){ return on[k]; });
    return {
      rules: rules.map(function(r){ return r.value(); }),
      columns: cols.length ? cols : null,
      sort: sortKey.value ? { key: sortKey.value, dir: sortDir.value } : null,
      color: color, icon: icon
    };
  }

  save.addEventListener('click', function(){
    msg.textContent = '';
    if (!name.value.trim()) { msg.textContent = 'Give the table a name.'; name.focus(); return; }
    save.disabled = true;
    post({action: 'tableSave', tableId: t ? t.id : null, name: name.value, config: config()})
      .then(function(j){ window.location.href = '/leads?t=' + j.table.id; },
        function(e){ save.disabled = false; msg.textContent = e.message; });
  });

  showDlg();
  name.focus();
}

function duplicate(t, msg){
  post({action: 'tableDuplicate', tableId: t.id})
    .then(function(j){ window.location.href = '/leads?t=' + j.table.id; },
      function(e){ if (msg) msg.textContent = e.message; else alert(e.message); });
}

function remove(t, msg){
  if (!confirm('Delete the table "' + t.name + '"? The leads in it are not affected.')) return;
  post({action: 'tableDelete', tableId: t.id}).then(function(){
    if (TABLE && TABLE.id === t.id) { window.location.href = '/leads'; return; }
    tables = tables.filter(function(x){ return x.id !== t.id; });
    var a = document.querySelector('.tabs a[data-table="' + t.id + '"]');
    if (a) a.remove();
    if (dlg.open) openManager();
  }, function(e){ if (msg) msg.textContent = e.message; else alert(e.message); });
}

// ------------------------------------------------------- the manager

// The tab strip follows the list, so a reorder shows without a reload.
function paintStrip(){
  var nav = document.getElementById('tabs');
  if (!nav) return;
  var before = document.getElementById('tablesbtn');
  tables.forEach(function(t){
    var a = nav.querySelector('a[data-table="' + t.id + '"]');
    if (a && before) nav.insertBefore(a, before);
  });
}

function saveOrder(next){
  var was = tables;
  tables = next;
  openManager();
  post({action: 'tableOrder', order: next.map(function(t){ return t.id; })}).then(function(){
    paintStrip();
  }, function(e){
    tables = was;
    openManager();
    alert(e.message);
  });
}

export function openManager(){
  if (!S) return;
  dlgbody.textContent = '';
  dlgHeader('Tables', 'Your tabs across the top, in this order. Drag to reorder, or use the arrows.');
  var box = el('div', {className: 'tedit'});
  var ul = el('ul', {className: 'tlist'});
  var dragging = null;

  tables.forEach(function(t, i){
    var c = t.config || {};
    var li = el('li', {draggable: true, className: c.color ? 'tc-' + c.color : ''}, [
      el('span', {className: 'tgrip', text: '⋮⋮', 'aria-hidden': 'true'}),
      el('span', {className: 'tn', text: (c.icon ? c.icon + ' ' : '') + t.name}),
      el('button', {type: 'button', className: 'mv', text: '↑', disabled: i === 0, 'aria-label': 'Move ' + t.name + ' left',
        on: {click: function(){ var n = tables.slice(); n.splice(i - 1, 0, n.splice(i, 1)[0]); saveOrder(n); }}}),
      el('button', {type: 'button', className: 'mv', text: '↓', disabled: i === tables.length - 1, 'aria-label': 'Move ' + t.name + ' right',
        on: {click: function(){ var n = tables.slice(); n.splice(i + 1, 0, n.splice(i, 1)[0]); saveOrder(n); }}}),
      el('button', {type: 'button', className: 'ghost sm', text: 'Edit', on: {click: function(){ openEditor(t); }}}),
      el('button', {type: 'button', className: 'ghost sm', text: 'Duplicate', on: {click: function(){ duplicate(t); }}}),
      el('button', {type: 'button', className: 'ghost sm', text: 'Delete', on: {click: function(){ remove(t); }}})
    ]);
    li.addEventListener('dragstart', function(e){
      dragging = i; li.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); }
    });
    li.addEventListener('dragend', function(){ li.classList.remove('dragging'); });
    li.addEventListener('dragover', function(e){ e.preventDefault(); li.classList.add('over'); });
    li.addEventListener('dragleave', function(){ li.classList.remove('over'); });
    li.addEventListener('drop', function(e){
      e.preventDefault();
      li.classList.remove('over');
      if (dragging == null || dragging === i) return;
      var n = tables.slice();
      n.splice(i, 0, n.splice(dragging, 1)[0]);
      dragging = null;
      saveOrder(n);
    });
    ul.appendChild(li);
  });

  if (!tables.length) box.appendChild(el('p', {className: 'muted', text: 'No tables yet.'}));
  box.appendChild(ul);
  box.appendChild(el('p', {className: 'warn', role: 'alert'}));
  box.appendChild(el('div', {className: 'acts'}, [
    el('button', {className: 'go', type: 'button', text: '+ New table', on: {click: function(){ openEditor(null); }}})
  ]));
  dlgbody.appendChild(box);
  showDlg();
}

export function initTables(){
  var b = document.getElementById('tablesbtn');
  if (b && S) b.addEventListener('click', openManager);
  var e = document.getElementById('edittable');
  if (e && S && TABLE) e.addEventListener('click', function(){ openEditor(TABLE); });
}
