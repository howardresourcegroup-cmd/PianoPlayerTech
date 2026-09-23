// Stripe invoicing: the monthly World Class bill, one-off customer invoices,
// and the Invoices tab that lists them.
//
// This client never sees a Stripe key. It posts what to bill and the server
// prices referrals itself, so a tampered request cannot change the fee.

import { D, view, state, INV_LABEL } from './state.js';
import { el, head, body, q, sf, shown, empty, dlgbody, fmt, money, showDlg, dlgHeader, debounce } from './dom.js';
import { post } from './api.js';
import { render } from './grid.js';

export function invById(id){
  for (var i = 0; i < D.invoices.length; i++) if (D.invoices[i].id === id) return D.invoices[i];
  return null;
}

// The monthly World Class bill on the Referrals tab.
export function renderBanner(){
  if (view === 'archive') {
    var ab = document.getElementById('banner');
    ab.textContent = 'Archived leads are deleted permanently about ' +
      D.purgeDays + ' days after archiving. Restore one to keep it.';
    ab.hidden = false;
    return;
  }
  var b = document.getElementById('banner');
  if (view !== 'referrals') return;
  var due = state.rows.filter(function(r){ return r.referral_status === 'booked' && !r.referral_paid_at && !r.referral_invoice_id; });
  b.textContent = '';
  b.hidden = !due.length;
  if (!due.length) return;
  b.appendChild(el('span', {text: due.length + (due.length === 1 ? ' booked referral' : ' booked referrals') +
    ' not billed yet · ' + money(due.length * D.fee * 100)}));
  b.appendChild(el('button', {className:'go', type:'button', text:'Invoice World Class', on:{click:function(){
    invoiceDialog({title:'Invoice World Class', billTo:'World Class Piano Tuners', email:D.lastWcEmail, referrals:due,
      memo:'Tuning referral fees — ' + new Date().toLocaleDateString([], {month:'long', year:'numeric'})});
  }}}));
}

export function invoiceDialog(pre){
  dlgbody.textContent = '';
  dlgHeader(pre.title || 'New invoice', 'Stripe emails it with a link to pay by card or bank.');
  if (!D.stripeReady) {
    dlgbody.appendChild(el('p', {className:'warn',
      text:"Stripe isn't connected yet. Add a STRIPE_SECRET_KEY secret in Cloudflare Pages settings, then redeploy."}));
    showDlg(); return;
  }
  var box = el('div', {className:'refer'});
  var billTo = el('input', {type:'text', value: pre.billTo || '', placeholder:'Name or company'});
  var email = el('input', {type:'email', value: pre.email || '', placeholder:'billing@example.com'});
  var days = el('input', {type:'number', value:'14', min:'1', max:'90'});
  var memo = el('textarea', {value: pre.memo || '', placeholder:'Shown on the invoice (optional)'});
  var totalEl = el('div', {className:'total'});
  var msg = el('p', {className:'warn'});
  var btn = el('button', {className:'go full', type:'button', text:'Create & send invoice'});
  var lineBox = el('div');
  var getLines, addLine;

  if (pre.referrals) {
    // Only which referrals — the server prices them.
    var checks = pre.referrals.map(function(r){
      var cb = el('input', {type:'checkbox', checked:true});
      cb.addEventListener('change', update);
      lineBox.appendChild(el('label', {className:'chk'}, [cb,
        document.createTextNode('PPT-' + r.id + (r.name ? ' — ' + r.name : '') + ' · ' + money(D.fee * 100))]));
      return {cb:cb, r:r};
    });
    getLines = function(){
      return checks.filter(function(c){ return c.cb.checked; }).map(function(c){ return {id:c.r.id, cents:D.fee * 100}; });
    };
  } else {
    var items = [];
    addLine = function(desc){
      var d = el('input', {type:'text', value: desc || '', placeholder:'Description'});
      var a = el('input', {type:'number', step:'0.01', min:'0', placeholder:'0.00', className:'amt', 'aria-label':'Amount'});
      var row = el('div', {className:'line'}, [d, a]);
      var item = {d:d, a:a};
      row.appendChild(el('button', {className:'x', type:'button', text:'×', title:'Remove line', on:{click:function(){
        if (items.length === 1) { d.value = ''; a.value = ''; update(); return; }
        items.splice(items.indexOf(item), 1); row.remove(); update();
      }}}));
      [d, a].forEach(function(i){ i.addEventListener('input', update); });
      items.push(item); lineBox.appendChild(row);
      return item;
    };
    addLine('');
    getLines = function(){
      return items.map(function(it){
        return {description: it.d.value.trim(), amount: it.a.value, cents: Math.round(parseFloat(it.a.value || '0') * 100) || 0};
      }).filter(function(l){ return l.description || l.cents; });
    };
  }
  function update(){
    var t = getLines().reduce(function(sum, l){ return sum + l.cents; }, 0);
    totalEl.textContent = 'Total ' + money(t);
    btn.disabled = t <= 0;
  }

  box.appendChild(el('label', {text:'Bill to'})); box.appendChild(billTo);
  box.appendChild(el('label', {text:'Email'})); box.appendChild(email);
  box.appendChild(el('label', {text: pre.referrals ? 'Referrals on this invoice' : 'Line items'})); box.appendChild(lineBox);
  if (!pre.referrals) box.appendChild(el('button', {className:'linkbtn', type:'button', text:'+ Add line',
    on:{click:function(){ addLine('').d.focus(); }}}));
  box.appendChild(el('label', {text:'Due in (days)'})); box.appendChild(days);
  box.appendChild(el('label', {text:'Memo'})); box.appendChild(memo);
  box.appendChild(totalEl); box.appendChild(btn); box.appendChild(msg);
  dlgbody.appendChild(box);
  update();

  btn.addEventListener('click', function(){
    var lines = getLines();
    var t = lines.reduce(function(sum, l){ return sum + l.cents; }, 0);
    if (!confirm('Email a ' + money(t) + ' invoice to ' + email.value.trim() + '?')) return;
    btn.disabled = true; btn.textContent = 'Creating…'; msg.textContent = '';
    var payload = {action:'invoice', billTo:billTo.value, email:email.value, days:days.value, memo:memo.value, leadId:pre.leadId || null};
    if (pre.referrals) payload.referralIds = lines.map(function(l){ return l.id; });
    else payload.lines = lines.map(function(l){ return {description:l.description, amount:l.amount}; });
    post(payload).then(function(j){
      var inv = j.invoice;
      D.invoices.unshift(inv);
      if (pre.referrals) {
        D.lastWcEmail = inv.email;
        state.rows.forEach(function(r){ if (payload.referralIds.indexOf(r.id) >= 0) r.referral_invoice_id = inv.id; });
      }
      if (view === 'invoices') renderInvoices(); else render();
      dlgbody.textContent = '';
      dlgHeader('Invoice ' + (inv.number || '') + ' sent', money(inv.amount_cents) + ' to ' + inv.email);
      if (j.warning) dlgbody.appendChild(el('p', {className:'warn', text:j.warning}));
      if (inv.hosted_url) dlgbody.appendChild(el('p', null, [
        el('a', {href:inv.hosted_url, target:'_blank', rel:'noopener', className:'go', text:'View invoice'})]));
    }, function(e){ btn.disabled = false; btn.textContent = 'Create & send invoice'; msg.textContent = e.message; });
  });
  showDlg();
}

// ---- Invoices tab
export function renderInvoices(){
  var f = sf.value, s = q.value.trim().toLowerCase(), now = new Date();
  var list = D.invoices.filter(function(i){
    if (f && i.status !== f) return false;
    if (!s) return true;
    return [i.bill_to, i.email, i.description, i.number, i.lines]
      .some(function(v){ return String(v || '').toLowerCase().indexOf(s) >= 0; });
  });
  head.textContent = '';
  ['Date', 'Invoice #', 'Bill to', 'Email', 'For', 'Amount', 'Status', 'Due', ''].forEach(function(h, i){
    head.appendChild(el('th', {text:h, className: i === 0 ? 'sticky' : ''}));
  });
  body.textContent = '';
  list.forEach(function(inv){
    var lines = []; try { lines = JSON.parse(inv.lines || '[]'); } catch(e){}
    var what = inv.description || lines.map(function(l){ return l.description; }).join('; ');
    var overdue = inv.status === 'open' && inv.due_date && new Date(inv.due_date) < now;
    function ro(t, cls){
      var td = el('td', {className: cls || ''});
      td.appendChild(el('div', {className:'ro', text:t, title:t}));
      return td;
    }
    var tr = el('tr', {className: inv.status === 'void' ? 'done' : ''});
    tr.appendChild(ro(fmt(inv.created_at), 'sticky'));
    tr.appendChild(ro(inv.number || '—'));
    tr.appendChild(ro(inv.bill_to || ''));
    tr.appendChild(ro(inv.email || ''));
    tr.appendChild(ro(what));
    tr.appendChild(ro(money(inv.amount_cents)));
    var st = ro(overdue ? 'Overdue' : (INV_LABEL[inv.status] || inv.status));
    st.firstChild.className += ' st-' + (overdue ? 'overdue' : inv.status);
    tr.appendChild(st);
    tr.appendChild(ro(inv.status === 'paid' ? 'Paid ' + fmt(inv.paid_at) : fmt(inv.due_date)));
    var acts = el('div', {className:'acts'});
    if (inv.hosted_url) {
      acts.appendChild(el('a', {href:inv.hosted_url, target:'_blank', rel:'noopener', text:'View'}));
      acts.appendChild(el('button', {className:'linkbtn', type:'button', text:'Copy link', on:{click:function(e){
        var b = e.target;
        navigator.clipboard.writeText(inv.hosted_url).then(function(){ b.textContent = 'Copied ✓'; },
          function(){ prompt('Copy this link:', inv.hosted_url); });
      }}}));
    }
    if (inv.status === 'open') acts.appendChild(el('button', {className:'linkbtn', type:'button', text:'Void', on:{click:function(){
      if (!confirm('Void invoice ' + (inv.number || '') + ' for ' + money(inv.amount_cents) + '? It can no longer be paid.')) return;
      post({action:'void', id:inv.id}).then(function(j){ Object.assign(inv, j.invoice); renderInvoices(); },
        function(e){ alert(e.message); });
    }}}));
    tr.appendChild(el('td', null, [acts]));
    body.appendChild(tr);
  });
  empty.hidden = list.length > 0;
  empty.textContent = D.stripeReady ? 'No invoices yet.'
    : "Stripe isn't connected yet. Add a STRIPE_SECRET_KEY secret in Cloudflare Pages settings, then redeploy.";
  shown.textContent = list.length + (list.length === 1 ? ' invoice' : ' invoices');

  var unpaid = 0, late = 0, paid = 0;
  D.invoices.forEach(function(i){
    if (i.status === 'open') { unpaid += i.amount_cents; if (i.due_date && new Date(i.due_date) < now) late += i.amount_cents; }
    if (i.status === 'paid') paid += i.amount_cents;
  });
  var box = document.getElementById('stats');
  box.textContent = '';
  [[money(unpaid), 'Unpaid', 'owed'], [money(late), 'Overdue'], [money(paid), 'Collected']].forEach(function(it){
    box.appendChild(el('div', {className:'stat' + (it[2] ? ' ' + it[2] : '')}, [el('b', {text:it[0]}), el('span', {text:it[1]})]));
  });
}

export function initInvoices(){
  sf.textContent = '';
  [['', 'All invoices'], ['open', 'Unpaid'], ['paid', 'Paid'], ['void', 'Void']].forEach(function(f){
    sf.appendChild(el('option', {value:f[0], text:f[1]}));
  });
  var tools = document.getElementById('tools');
  tools.insertBefore(el('button', {className:'go', type:'button', text:'New invoice',
    on:{click:function(){ invoiceDialog({}); }}}), tools.firstChild);
  q.placeholder = 'Search name, email, invoice #…';
  q.addEventListener('input', debounce(renderInvoices, 120));
  sf.addEventListener('change', renderInvoices);
  renderInvoices();
}
