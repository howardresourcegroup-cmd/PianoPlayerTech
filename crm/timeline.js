// The activity timeline and the box you write into.
//
// A timeline entry is either something a person logged (a call, a note, a
// follow-up) or something the CRM logged for itself when a status changed.
// The two look different on purpose: an automatic entry is quieter, because
// it is context rather than work.

import { el, fmt, fmtWhen } from './dom.js';
import { post } from './api.js';

export const TYPE_LABEL = {
  call: 'Call', email: 'Email', sms: 'Text', note: 'Note',
  task: 'Task', followup: 'Follow-up', appointment: 'Appointment', status: 'Change'
};

// Types that carry a due date, and so need one.
export const NEEDS_DATE = ['task', 'followup', 'appointment'];

// A local datetime-local value ("2026-09-23T09:00") means 9am where the
// person is standing. new Date() reads it in local time, and toISOString
// converts it once, here, so everything stored is UTC.
function toIso(localValue){
  if (!localValue) return '';
  var d = new Date(localValue);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

// A default that is useful rather than clever: tomorrow morning.
function tomorrowNine(){
  var d = new Date();
  d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
  var p = function(n){ return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * The composer.
 *
 * @param leadId  which lead the entry belongs to
 * @param onAdded called with the saved activity row
 */
export function composer(leadId, onAdded){
  var box = el('div', {className:'compose'});
  var text = el('textarea', {placeholder:'What happened? Or what needs doing next…', 'aria-label':'Activity'});
  var kind = el('select', {'aria-label':'Type'});
  ['note','call','email','sms','followup','task','appointment'].forEach(function(t){
    kind.appendChild(el('option', {value:t, text:TYPE_LABEL[t]}));
  });
  var when = el('input', {type:'datetime-local', 'aria-label':'Due', value:tomorrowNine(), hidden:true});
  var save = el('button', {className:'go', type:'button', text:'Save'});
  var msg = el('p', {className:'warn'});

  function syncDate(){ when.hidden = NEEDS_DATE.indexOf(kind.value) < 0; }
  kind.addEventListener('change', syncDate);
  syncDate();

  save.addEventListener('click', function(){
    var body = text.value.trim();
    if (!body) { msg.textContent = 'Write something first.'; text.focus(); return; }
    var needsDate = NEEDS_DATE.indexOf(kind.value) >= 0;
    if (needsDate && !when.value) { msg.textContent = 'A follow-up needs a date.'; return; }

    save.disabled = true; save.textContent = 'Saving…'; msg.textContent = '';
    post({action:'activity', id:leadId, type:kind.value, body:body,
          dueAt: needsDate ? toIso(when.value) : ''})
    .then(function(j){
      text.value = ''; save.disabled = false; save.textContent = 'Save';
      onAdded(j.activity);
    }, function(e){
      save.disabled = false; save.textContent = 'Save'; msg.textContent = e.message;
    });
  });

  box.appendChild(text);
  box.appendChild(el('div', {className:'row'}, [kind, when, save]));
  box.appendChild(msg);
  return box;
}

/**
 * The list.
 *
 * @param rows     activities, newest first
 * @param onChange called after a tick or a delete, with the new list
 */
export function timeline(rows, onChange){
  if (!rows.length) {
    return el('p', {className:'muted', text:'Nothing logged yet. The box above is the start of it.'});
  }
  var now = new Date().toISOString();
  var ul = el('ul', {className:'tl'});

  rows.forEach(function(a){
    var isDone = !!a.completed_at;
    var li = el('li', {className: isDone ? 'done' : ''});

    // A follow-up is the only kind you can tick, because it is the only kind
    // that represents something still owed.
    if (a.due_at) {
      var cb = el('input', {type:'checkbox', className:'tick', checked:isDone,
        'aria-label': isDone ? 'Mark as not done' : 'Mark as done'});
      cb.addEventListener('change', function(){
        cb.disabled = true;
        post({action:'activityDone', activityId:a.id, done:cb.checked}).then(function(j){
          Object.assign(a, j.activity); onChange(rows);
        }, function(e){ cb.checked = !cb.checked; cb.disabled = false; alert(e.message); });
      });
      li.appendChild(cb);
    }

    li.appendChild(el('span', {className:'kind ' + a.type, text: TYPE_LABEL[a.type] || a.type}));

    var grow = el('div', {className:'grow'});
    if (a.subject) grow.appendChild(el('div', {className:'subj', text:a.subject}));
    if (a.body) grow.appendChild(el('div', {className:'txt', text:a.body}));

    if (a.due_at && !isDone) {
      var late = a.due_at < now;
      grow.appendChild(el('div', {className:'due' + (late ? ' late' : ''),
        text: (late ? 'Overdue — was due ' : 'Due ') + fmtWhen(a.due_at)}));
    }

    grow.appendChild(el('div', {className:'when',
      text: fmtWhen(a.created_at) + (a.actor ? ' · ' + a.actor : '')}));
    li.appendChild(grow);

    // An automatic entry is the CRM's own record of what happened; deleting
    // one would be editing history, so only logged entries offer it.
    if (a.type !== 'status') {
      li.appendChild(el('button', {className:'del', type:'button', text:'×',
        title:'Delete this entry', 'aria-label':'Delete this entry',
        on:{click:function(){
          if (!confirm('Delete this entry? This cannot be undone.')) return;
          post({action:'activityDelete', activityId:a.id}).then(function(){
            onChange(rows.filter(function(x){ return x !== a; }));
          }, function(e){ alert(e.message); });
        }}}));
    }

    ul.appendChild(li);
  });
  return ul;
}

// The other jobs and invoices for the same person.
export function history(rec, money){
  var wrap = el('div');
  var jobs = rec.otherLeads || [], invs = rec.invoices || [];

  if (!jobs.length && !invs.length) {
    return el('p', {className:'muted', text:'No other jobs or invoices for this customer yet.'});
  }

  if (jobs.length) {
    wrap.appendChild(el('h3', {text:'Other jobs'}));
    var ul = el('ul', {className:'hist'});
    jobs.forEach(function(l){
      ul.appendChild(el('li', null, [
        el('span', {className:'date', text:fmt(l.created_at)}),
        el('span', {className:'what', text:[l.service, l.system, l.city].filter(Boolean).join(' · ') || ('PPT-' + l.id)}),
        el('span', {className:'tagp', text:l.status || ''})
      ]));
    });
    wrap.appendChild(ul);
  }

  if (invs.length) {
    wrap.appendChild(el('h3', {text:'Invoices'}));
    var ul2 = el('ul', {className:'hist'});
    invs.forEach(function(i){
      ul2.appendChild(el('li', null, [
        el('span', {className:'date', text:fmt(i.created_at)}),
        el('span', {className:'what', text:(i.number || 'Invoice') + (i.description ? ' · ' + i.description : '')}),
        el('span', {className:'amt', text:money(i.amount_cents)}),
        el('span', {className:'tagp', text:i.status || ''})
      ]));
    });
    wrap.appendChild(ul2);
  }
  return wrap;
}
