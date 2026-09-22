// The lead record: everything known about one lead, and the referral form.
//
// Opened from the grid's Open button, or straight into the referral form
// from its Refer button.

import { D, REF_LABEL } from './state.js';
import { el, dlg, dlgbody, fmt, fmtLong, tel, fields, showDlg, dlgHeader } from './dom.js';
import { post } from './api.js';
import { bumpRef } from './stats.js';
import { render } from './grid.js';
import { invoiceDialog } from './invoices.js';

// Straight from the grid's Refer button: just the referral form, no detour
// through the full lead record.
export function openRefer(r){
  dlgbody.textContent = '';
  dlgHeader('Refer ' + (r.name || 'this lead'),
    [r.phone, r.city].filter(Boolean).join(' · ') || ('PPT-' + r.id));
  if (r.message) dlgbody.appendChild(el('div', {className:'msg', text:r.message}));
  dlgbody.appendChild(referBox(r, fields(r)));
  dlgbody.appendChild(el('p', null, [
    el('button', {className:'linkbtn', type:'button', text:'See the whole lead instead',
      on:{click:function(){ openLead(r); }}})
  ]));
  showDlg();
}

export function openLead(r){
  dlgbody.textContent = '';
  var f = fields(r);
  var meta = [r.service, r.system, r.city].filter(Boolean).join(' · ');

  dlgbody.appendChild(el('div', {className:'hd'}, [
    el('div', null, [
      el('h2', {text: r.name || 'No name given'}),
      el('div', {className:'muted', text:'Received ' + fmtLong(r.created_at) + ' · PPT-' + r.id})
    ]),
    el('button', {className:'x', type:'button', text:'×', 'aria-label':'Close', on:{click:function(){ dlg.close(); }}})
  ]));
  if (meta) dlgbody.appendChild(el('div', {className:'meta', text:meta}));

  var contact = el('div', {className:'contact'});
  if (tel(r.phone)) contact.appendChild(el('a', {href:'tel:' + tel(r.phone), text:r.phone}));
  if (r.email) contact.appendChild(el('a', {href:'mailto:' + r.email, text:r.email}));
  if (r.address) contact.appendChild(el('a', {href:'https://maps.google.com/?q=' + encodeURIComponent(r.address),
    target:'_blank', rel:'noopener', text:'Map'}));
  dlgbody.appendChild(contact);

  if (r.message) dlgbody.appendChild(el('div', {className:'msg', text:r.message}));

  var keys = Object.keys(f);
  if (keys.length) {
    var dl = el('dl');
    keys.forEach(function(k){
      dl.appendChild(el('dt', {text:k.replace(/[_-]+/g, ' ')}));
      dl.appendChild(el('dd', {text:String(f[k])}));
    });
    dlgbody.appendChild(el('details', null, [el('summary', {text:'Everything they submitted'}), dl]));
  }
  if (r.notes) dlgbody.appendChild(el('div', {className:'msg', text:r.notes}));

  dlgbody.appendChild(referBox(r, f));
  dlgbody.appendChild(el('div', {className:'refer'}, [
    el('h3', {text:'Invoice'}),
    el('button', {className:'ghost', type:'button', text:'Create an invoice for ' + (r.name || 'this customer'),
      on:{click:function(){ invoiceDialog({billTo:r.name, email:r.email, leadId:r.id}); }}})
  ]));
  showDlg();
}

export function referBox(r, f){
  var box = el('div', {className:'refer'});
  box.appendChild(el('h3', {text:'World Class referral'}));

  if (r.referred_at) {
    box.appendChild(el('div', {className:'sent',
      text:'Referred ' + fmtLong(r.referred_at) + ' as PPT-' + r.id + ' — ' +
        (REF_LABEL[r.referral_status] || 'sent') + (r.referral_paid_at ? ', paid ' + fmt(r.referral_paid_at) : '') +
        '. Track the outcome in the Referral column.'}));
    return box;
  }

  var addr = el('input', {type:'text', value: r.address || '', placeholder:'Street, city, ZIP'});
  var piano = el('input', {type:'text', value: r.system || (f.pianos ? f.pianos + ' piano(s)' : ''), placeholder:'e.g. Yamaha U1 upright'});
  var times = el('input', {type:'text', value: f.preferred_dates || '', placeholder:'e.g. weekday mornings'});
  var note = el('textarea', {placeholder:'Anything World Class should know — gate code, pitch raise likely, etc.'});
  var tell = el('input', {type:'checkbox', disabled: !r.email});
  var mark = el('button', {className:'go full', type:'button', text:'Mark as referred'});
  var texter = el('a', {className:'ghost', text:'Text details'});
  var copier = el('button', {className:'ghost', type:'button', text:'Copy details'});
  var emailer = D.wcReady ? el('button', {className:'linkbtn', type:'button', text:'Or email it to World Class instead'}) : null;
  var msg = el('p', {className:'warn'});

  // Referrals go to a person by phone, so the details are laid out to
  // paste into a text. The contact is picked in Messages.
  function details(){
    return ['Tuning referral PPT-' + r.id, r.name, r.phone, r.email, addr.value.trim(),
      piano.value.trim() && 'Piano: ' + piano.value.trim(),
      times.value.trim() && 'Best times: ' + times.value.trim(),
      note.value.trim() && 'Note: ' + note.value.trim(),
      r.message && 'They said: ' + r.message
    ].filter(Boolean).join('\n');
  }
  function refreshText(){ texter.href = 'sms:?&body=' + encodeURIComponent(details()); }
  [addr, piano, times, note].forEach(function(i){ i.addEventListener('input', refreshText); });
  refreshText();
  copier.addEventListener('click', function(){
    navigator.clipboard.writeText(details()).then(function(){
      copier.textContent = 'Copied ✓'; setTimeout(function(){ copier.textContent = 'Copy details'; }, 1500);
    }, function(){ alert('Could not copy on this device — use Text details instead.'); });
  });

  function go(isManual){
    if (!isManual && !addr.value.trim() && !confirm('No address yet — send anyway? World Class will have to ask for it.')) return;
    var b = isManual ? mark : emailer, label = b.textContent;
    b.disabled = true; b.textContent = isManual ? 'Saving…' : 'Sending…'; msg.textContent = '';
    var before = Object.assign({}, r);
    post({action:'refer', id:r.id, manual:isManual, address:addr.value, system:piano.value,
          times:times.value, note:note.value, tellCustomer:tell.checked})
    .then(function(j){
      Object.assign(r, j.row);
      bumpRef(before, r); render(); openLead(r);
    }, function(e){ b.disabled = false; b.textContent = label; msg.textContent = e.message; });
  }
  mark.addEventListener('click', function(){ go(true); });
  if (emailer) emailer.addEventListener('click', function(){ go(false); });

  [['Address', addr], ['Piano', piano], ['Preferred times', times], ['Note for World Class', note]]
    .forEach(function(p){ box.appendChild(el('label', {text:p[0]})); box.appendChild(p[1]); });
  box.appendChild(el('div', {className:'pair'}, [texter, copier]));
  box.appendChild(el('label', {className:'chk'}, [tell,
    document.createTextNode(r.email ? 'Email ' + r.email + ' that World Class will call them' : 'No customer email on file')]));
  box.appendChild(mark);
  box.appendChild(msg);
  if (emailer) box.appendChild(el('p', null, [emailer]));
  return box;
}
