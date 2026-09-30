// The New lead form.
//
// A phone call or a walk-in has no web form behind it, so the owner types it
// in here. The server does the checking; this file only collects the answers
// and puts the new row where the owner is looking.

import { el, dlg, dlgbody, dlgHeader, showDlg } from './dom.js';
import { post } from './api.js';
import { state, view } from './state.js';
import { render } from './grid.js';
import { renderStats } from './stats.js';
import { openLead } from './record.js';

var CAME_IN_BY = [['', 'Not sure'], ['phone', 'Phone call'], ['text', 'Text message'],
  ['email', 'Email'], ['in_person', 'In person'], ['other', 'Other']];

function field(label, input){
  return el('div', null, [el('label', {text: label}), input]);
}

export function newLeadDialog(){
  dlgbody.textContent = '';
  dlgHeader('New lead', 'For a call, a text or someone who walked in. Only a way to reach them is required.');
  var box = el('div', {className:'refer'});

  var pipeline = el('select');
  [['repair', 'Repair & pneumatic'], ['tuning', 'Tuning']].forEach(function(o){
    pipeline.appendChild(el('option', {value:o[0], text:o[1]}));
  });
  pipeline.value = view === 'tuning' ? 'tuning' : 'repair';
  var cameInBy = el('select');
  CAME_IN_BY.forEach(function(o){ cameInBy.appendChild(el('option', {value:o[0], text:o[1]})); });

  var name = el('input', {type:'text', placeholder:'Who called', autocomplete:'off'});
  var phone = el('input', {type:'text', placeholder:'(470) 555-0100'});
  var email = el('input', {type:'email', placeholder:'them@example.com'});
  var address = el('input', {type:'text', placeholder:'Street address (optional)'});
  var city = el('input', {type:'text', placeholder:'City'});
  var system = el('input', {type:'text', placeholder:'e.g. Disklavier DKC-850, PianoDisc iQ, Ampico'});
  var service = el('input', {type:'text', placeholder:'e.g. Power supply repair, Tuning'});
  var message = el('textarea', {placeholder:'What they said the problem is'});
  var notes = el('textarea', {placeholder:'Internal only. Never shown to the customer.'});
  var msg = el('p', {className:'warn'});
  var btn = el('button', {className:'go full', type:'button', text:'Add lead'});

  box.appendChild(el('div', {className:'two'}, [field('Pipeline', pipeline), field('Came in by', cameInBy)]));
  box.appendChild(field('Name', name));
  box.appendChild(el('div', {className:'two'}, [field('Phone', phone), field('Email', email)]));
  box.appendChild(el('div', {className:'two'}, [field('Address', address), field('City', city)]));
  box.appendChild(field('Piano or player system', system));
  box.appendChild(field('Service', service));
  box.appendChild(field('What they said', message));
  box.appendChild(field('Notes', notes));
  box.appendChild(msg);
  box.appendChild(btn);
  dlgbody.appendChild(box);

  function save(){
    msg.textContent = '';
    if (!name.value.trim() && !phone.value.trim() && !email.value.trim()) {
      msg.textContent = 'Give at least a name, phone or email so they can be reached.';
      name.focus(); return;
    }
    btn.disabled = true; btn.textContent = 'Saving…';
    post({action:'create', pipeline: pipeline.value, came_in_by: cameInBy.value,
      name: name.value, phone: phone.value, email: email.value, address: address.value,
      city: city.value, system: system.value, service: service.value,
      message: message.value, notes: notes.value})
    .then(function(j){
      var r = j.lead;
      // It belongs on this tab if the tab is its pipeline or shows everything.
      // Otherwise go to where it lives, or it would look like the save failed.
      if (view === 'all' || view === r.pipeline) {
        state.rows.unshift(r);
        state.sortKey = null;
        renderStats();
        render();
        dlg.close();
        openLead(r);
      } else {
        window.location.href = '/leads?p=' + r.pipeline;
      }
    }, function(e){
      btn.disabled = false; btn.textContent = 'Add lead';
      msg.textContent = e.message;
    });
  }
  btn.addEventListener('click', save);
  // Enter in a one-line box saves; a textarea keeps Enter for new lines.
  [name, phone, email, address, city, system, service].forEach(function(i){
    i.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); save(); } });
  });

  showDlg();
  name.focus();
}

export function initNewLead(){
  var b = document.getElementById('newlead');
  if (b) b.addEventListener('click', newLeadDialog);
}
