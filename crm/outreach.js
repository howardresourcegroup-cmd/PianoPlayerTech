// The Emails tab: what is waiting to go out, and how each kind behaves.
//
// The server decides who is due an email and drafts it. This screen is where
// a person reads the draft and says yes, no, or "not like that". Nothing
// here can send on its own account: every button is a request the server
// checks again.
//
// Everything a customer typed reaches the page through textContent or
// .value, never innerHTML.

import { D } from './state.js';
import { el, fmt } from './dom.js';
import { post } from './api.js';

var O = D.outreach || {};

function hide(id){ var n = document.getElementById(id); if (n) n.hidden = true; }

function field(label, control){
  var id = 'o' + Math.random().toString(36).slice(2, 9);
  control.id = id;
  return el('div', null, [el('label', {htmlFor: id, text: label}), control]);
}

function say(node, text, good){
  node.textContent = text || '';
  node.className = 'msg' + (text ? (good ? ' ok' : ' bad') : '');
}

function busy(buttons, on){ buttons.forEach(function(b){ b.disabled = on; }); }

// One drafted email. Subject and body are editable in place: the commonest
// reason to hesitate over a draft is one sentence, and making that a
// separate dialog would make skipping easier than fixing.
function draftCard(r, onGone){
  var subject = el('input', {type:'text', value: r.subject, maxLength: 150});
  var body = el('textarea', {value: r.body, maxLength: 3000});
  var msg = el('p', {className:'msg'});
  var send = el('button', {className:'go', type:'button', text: r.status === 'failed' ? 'Try again' : 'Send'});
  var skip = el('button', {className:'ghost', type:'button', text:'Skip'});
  if (r.status === 'failed' && r.error) say(msg, 'Last attempt: ' + r.error, false);

  var card = el('div', {className:'card oq'}, [
    el('div', {className:'who'}, [
      el('span', {className:'kind', text: (O.labels && O.labels[r.kind]) || r.kind}),
      el('strong', {text: r.lead_name || r.email}),
      el('span', {className:'muted', text: r.email}),
      el('span', {className:'muted', text: 'drafted ' + fmt(r.created_at)})
    ]),
    field('Subject', subject),
    field('Message', body),
    el('div', {className:'row'}, [send, skip]),
    msg
  ]);

  send.addEventListener('click', function(){
    busy([send, skip], true); say(msg, 'Sending…', true);
    post({action:'outreachSend', id: r.id, subject: subject.value, body: body.value})
      .then(function(){ onGone(card, 'Sent to ' + r.email + '.'); })
      .catch(function(e){ busy([send, skip], false); say(msg, e.message, false); });
  });
  skip.addEventListener('click', function(){
    busy([send, skip], true);
    post({action:'outreachSkip', id: r.id})
      .then(function(){ onGone(card, 'Skipped.'); })
      .catch(function(e){ busy([send, skip], false); say(msg, e.message, false); });
  });
  return card;
}

function queueSection(){
  var list = el('div', {className:'oq'});
  var note = el('p', {className:'msg'});
  var waiting = O.waiting || [];
  var left = waiting.length;
  var empty = el('p', {className:'muted', text:'Nothing is waiting. Emails appear here when a lead is due one.'});

  function gone(card, text){
    card.remove(); left--;
    say(note, text, true);
    if (!left) list.appendChild(empty);
  }
  if (!waiting.length) list.appendChild(empty);
  waiting.forEach(function(r){ list.appendChild(draftCard(r, gone)); });

  return el('section', null, [
    el('h2', {text:'Waiting for you'}),
    el('p', {className:'lede', text:'Read each one, change anything you like, then send or skip. Up to ' + (O.cap || 20) + ' can go out in a day.'}),
    note, list
  ]);
}

function recentSection(){
  var rows = O.recent || [];
  if (!rows.length) return null;
  var ul = el('ul', {className:'log'});
  rows.forEach(function(r){
    ul.appendChild(el('li', null, [
      el('span', {className:'st', text: r.status === 'sent' ? 'Sent' : 'Skipped'}),
      el('span', {text: (O.labels && O.labels[r.kind]) || r.kind}),
      el('span', {text: r.lead_name || r.email}),
      el('span', {className:'muted', text: fmt(r.decided_at) + (r.decided_by ? ' · ' + r.decided_by : '')}),
      r.error ? el('span', {className:'muted', text: r.error}) : null
    ]));
  });
  return el('section', null, [el('h2', {text:'Recently sent or skipped'}), ul]);
}

var MODE_TEXT = { off: 'Off', ask: 'Ask me first', auto: 'Send automatically' };
var DELAY_TEXT = {
  quote_checkin: 'Days after the quote',
  review_request: 'Days after the job is completed',
  tuning_reminder: 'Months after the tuning'
};

function settingsSection(){
  var c = O.config || {kinds:{}};
  var address = el('textarea', {className:'short', value: c.address || '', maxLength: 300,
    placeholder:'e.g. PianoPlayerTech, PO Box 123, Your Town, GA 30000'});
  var sender = el('input', {type:'text', value: c.sender || '', maxLength: 80});
  var msg = el('p', {className:'msg'});
  var controls = {};

  var sets = (O.kinds || []).map(function(k){
    var v = c.kinds[k] || {};
    var mode = el('select');
    ['off','ask','auto'].forEach(function(m){
      mode.appendChild(el('option', {value: m, text: MODE_TEXT[m], selected: v.mode === m}));
    });
    var delay = el('input', {type:'number', value: v.delay, min: 0, max: 60});
    var subject = el('input', {type:'text', value: v.subject || '', maxLength: 150});
    var body = el('textarea', {value: v.body || '', maxLength: 3000});
    var tmsg = el('p', {className:'msg'});
    var test = el('button', {className:'ghost', type:'button', text:'Send me a test'});
    test.addEventListener('click', function(){
      test.disabled = true; say(tmsg, 'Save first if you have changed the wording. Sending…', true);
      post({action:'outreachTest', kind: k})
        .then(function(j){ say(tmsg, 'Test sent to ' + (j.to || O.testTo) + '.', true); })
        .catch(function(e){ say(tmsg, e.message, false); })
        .then(function(){ test.disabled = false; });
    });
    controls[k] = {mode: mode, delay: delay, subject: subject, body: body};
    return el('fieldset', null, [
      el('legend', {text: (O.labels && O.labels[k]) || k}),
      el('div', {className:'pair2'}, [field('When it sends', mode), field(DELAY_TEXT[k] || 'Delay', delay)]),
      field('Subject', subject),
      field('Message', body),
      el('div', {className:'row'}, [test]), tmsg
    ]);
  });

  var save = el('button', {className:'go', type:'button', text:'Save settings'});
  save.addEventListener('click', function(){
    var kinds = {};
    Object.keys(controls).forEach(function(k){
      kinds[k] = {mode: controls[k].mode.value, delay: controls[k].delay.value,
        subject: controls[k].subject.value, body: controls[k].body.value};
    });
    save.disabled = true; say(msg, 'Saving…', true);
    post({action:'outreachConfig', config: {address: address.value, sender: sender.value, kinds: kinds}})
      // Reloaded, so the queue reflects the new settings and what was
      // clamped on the server is what is shown.
      .then(function(){ location.reload(); })
      .catch(function(e){ save.disabled = false; say(msg, e.message, false); });
  });

  return el('section', null, [
    el('h2', {text:'Settings'}),
    el('p', {className:'lede', text:'In the wording, {first_name}, {instrument} and {sender} are filled in for each customer.'}),
    el('div', {className:'oq'}, [
      el('fieldset', null, [
        el('legend', {text:'On every email'}),
        field('Your mailing address (required by law, shown at the foot of each email)', address),
        field('Signed by', sender)
      ])
    ].concat(sets).concat([el('div', {className:'row'}, [save]), msg]))
  ]);
}

export function initOutreach(){
  ['tools', 'quick', 'views', 'bulkbar', 'stats', 'pager', 'upcoming'].forEach(hide);
  var wrap = document.querySelector('.gridwrap');
  if (!wrap) return;
  wrap.textContent = '';
  wrap.className = 'outreach';

  if (O.error) {
    wrap.appendChild(el('div', {className:'card'}, [el('p', {className:'warn', text: O.error})]));
    return;
  }
  var c = O.config || {};
  if (!c.address) {
    wrap.appendChild(el('div', {className:'notice', text:
      'Nothing can be sent yet. Add your mailing address in Settings below. You can read and edit drafts in the meantime.'}));
  } else if (!O.canSend) {
    wrap.appendChild(el('div', {className:'notice', text:'Email is not set up on the server, so nothing can be sent.'}));
  }
  [queueSection(), recentSection(), settingsSection()].forEach(function(s){ if (s) wrap.appendChild(s); });
}
