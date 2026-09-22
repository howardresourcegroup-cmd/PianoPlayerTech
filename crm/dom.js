// Building and formatting the page.
//
// `el` is the reason no customer-supplied value in this application ever
// reaches the DOM as markup: text goes through the `text` property, which
// sets textContent. There is no innerHTML anywhere in this client, and that
// -- not the CSP -- is what stops a form submission from running as code.

export const head = document.getElementById('head');
export const body = document.getElementById('body');
export const q = document.getElementById('q');
export const sf = document.getElementById('sf');
export const shown = document.getElementById('shown');
export const empty = document.getElementById('empty');
export const dlg = document.getElementById('dlg');
export const dlgbody = document.getElementById('dlgbody');

export function el(tag, props, kids){
  var n = document.createElement(tag);
  if (props) for (var p in props) {
    if (p === 'text') n.textContent = props[p];
    else if (p === 'on') for (var ev in props.on) n.addEventListener(ev, props.on[ev]);
    else if (p in n) n[p] = props[p]; else n.setAttribute(p, props[p]);
  }
  (kids || []).forEach(function(k){ if (k) n.appendChild(k); });
  return n;
}

export function fmt(ts){
  if (!ts) return '';
  var d = new Date(ts); if (isNaN(d)) return ts;
  return d.toLocaleDateString([], {month:'short', day:'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : '2-digit'});
}
export function fmtLong(ts){ var d = new Date(ts); return isNaN(d) ? '' : d.toLocaleString(); }
export function tel(p){ return String(p || '').replace(/[^0-9+]/g, ''); }
export function money(c){ return '$' + (Number(c || 0) / 100).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2}); }

// The submitted form fields, which are stored as a JSON blob. A lead whose
// blob is unparseable should still open, so this never throws.
export function fields(r){ try { return JSON.parse(r.fields || '{}') || {}; } catch(e){ return {}; } }

export function showDlg(){ if (!dlg.open) dlg.showModal(); }

export function dlgHeader(title, sub){
  dlgbody.appendChild(el('div', {className:'hd'}, [
    el('div', null, [el('h2', {text:title}), sub ? el('div', {className:'muted', text:sub}) : null]),
    el('button', {className:'x', type:'button', text:'×', 'aria-label':'Close', on:{click:function(){ dlg.close(); }}})
  ]));
}

// Green or red for a moment, so a save that worked is visible without a
// dialog. Reading offsetWidth restarts the animation on a repeat save.
export function flash(td, ok){
  td.classList.remove('ok','bad'); void td.offsetWidth;
  td.classList.add(ok ? 'ok' : 'bad');
}
