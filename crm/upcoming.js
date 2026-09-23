// What you owe somebody, in the header.
//
// The server has been computing open follow-ups on every page load since the
// record view shipped, and nothing rendered them. A CRM that knows what is
// overdue and does not say so is just a list. This is that badge, plus the
// panel behind it and the calendar subscription.

import { D, view } from './state.js';
import { el, fmtWhen, dlgbody, showDlg, dlgHeader } from './dom.js';
import { post } from './api.js';

export function renderUpcoming(openLeadById){
  var host = document.getElementById('upcoming');
  if (!host) return;
  var f = D.followups || { overdue: 0, upcoming: 0, rows: [] };
  host.textContent = '';

  // Nothing owed and no calendar to offer: say nothing.
  if (!f.overdue && !f.upcoming && view !== 'all') { host.hidden = true; return; }
  host.hidden = false;

  // The count appears once: in the red badge when something is overdue,
  // otherwise in the words.
  var b = el('button', {className:'upbtn' + (f.overdue ? ' late' : ''), type:'button',
    title:'Follow-ups you have set'});
  b.appendChild(document.createTextNode(
    f.overdue ? 'Overdue' : f.upcoming ? f.upcoming + ' coming up' : 'Follow-ups'));
  if (f.overdue) b.appendChild(el('span', {className:'fubadge', text:String(f.overdue)}));
  b.addEventListener('click', function(){ panel(f, openLeadById); });
  host.appendChild(b);
}

function panel(f, openLeadById){
  dlgbody.textContent = '';
  dlgHeader('Follow-ups', f.overdue
    ? f.overdue + ' overdue, ' + f.upcoming + ' still to come'
    : f.upcoming + ' coming up');

  var rows = (f.rows || []);
  if (!rows.length) {
    dlgbody.appendChild(el('p', {className:'muted',
      text:'Nothing outstanding. Follow-ups you add on a lead show up here.'}));
  } else {
    var now = new Date().toISOString();
    var ul = el('ul', {className:'tl'});
    rows.forEach(function(a){
      var late = a.due_at < now;
      var li = el('li');
      li.appendChild(el('span', {className:'kind followup', text: late ? 'Overdue' : 'Due'}));
      var grow = el('div', {className:'grow'});
      if (a.subject) grow.appendChild(el('div', {className:'subj', text:a.subject}));
      if (a.body) grow.appendChild(el('div', {className:'txt', text:a.body}));
      grow.appendChild(el('div', {className:'due' + (late ? ' late' : ''),
        text: (late ? 'Was due ' : 'Due ') + fmtWhen(a.due_at) +
              (a.lead_name ? ' · ' + a.lead_name : '')}));
      // Only offered for a lead on this tab; the panel lists them all.
      if (a.lead_id != null && openLeadById(a.lead_id, true)) {
        grow.appendChild(el('button', {className:'linkbtn', type:'button', text:'Open the lead',
          on:{click:function(){ openLeadById(a.lead_id); }}}));
      }
      li.appendChild(grow);
      ul.appendChild(li);
    });
    dlgbody.appendChild(ul);
  }

  dlgbody.appendChild(calendarBox());
  showDlg();
}

// The subscribe URL, behind a click, because it is a bearer credential for
// customer names, addresses and phone numbers.
function calendarBox(){
  var box = el('div', {className:'refer'});
  box.appendChild(el('h3', {text:'Calendar subscription'}));
  box.appendChild(el('p', {className:'muted',
    text:'Scheduled jobs, callbacks on new leads and these follow-ups, as a feed your phone can subscribe to.'}));

  var out = el('div');
  var warn = el('p', {className:'warn'});

  function showUrl(url){
    out.textContent = '';
    var f = el('input', {type:'text', value:url, readOnly:true, 'aria-label':'Calendar address'});
    f.addEventListener('focus', function(){ f.select(); });
    out.appendChild(f);
    out.appendChild(el('p', {className:'muted',
      text:'Anyone with this address can read every customer name, address and phone number in it. ' +
           'Add it to your calendar as a subscription, and rotate it if it ever gets out.'}));
    var acts = el('div', {className:'pair'});
    acts.appendChild(el('button', {className:'ghost', type:'button', text:'Copy', on:{click:function(e){
      var btn = e.target;
      navigator.clipboard.writeText(url).then(function(){ btn.textContent = 'Copied ✓'; },
        function(){ prompt('Copy this address:', url); });
    }}}));
    acts.appendChild(el('button', {className:'ghost', type:'button', text:'Rotate', on:{click:function(){
      if (!confirm('Rotate the calendar address? Any device already subscribed will stop updating until you give it the new one.')) return;
      act('calendarRotate', showUrl, warn);
    }}}));
    acts.appendChild(el('button', {className:'linkbtn', type:'button', text:'Turn off', on:{click:function(){
      if (!confirm('Turn the calendar feed off? Subscribed devices will stop updating.')) return;
      post({action:'calendarOff'}).then(function(){
        out.textContent = '';
        out.appendChild(offer());
      }, function(e){ warn.textContent = e.message; });
    }}}));
    out.appendChild(acts);
  }

  function offer(){
    return el('button', {className:'go', type:'button', text:'Turn the calendar feed on',
      on:{click:function(){ act('calendarOn', showUrl, warn); }}});
  }

  if (D.calendarUrl) showUrl(D.calendarUrl); else out.appendChild(offer());
  box.appendChild(out);
  box.appendChild(warn);
  return box;
}

function act(action, done, warn){
  warn.textContent = 'Working…';
  post({ action: action }).then(function(j){
    warn.textContent = '';
    D.calendarUrl = j.url;
    done(j.url);
  }, function(e){ warn.textContent = e.message; });
}
