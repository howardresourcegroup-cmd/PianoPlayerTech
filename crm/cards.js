// The phone layout.
//
// A table with fourteen columns does not become usable on a 375px screen by
// scrolling sideways; you lose the row you were reading the moment you move.
// Below 760px the grid becomes a list of cards instead, one per lead, with
// the things you actually need while standing next to a piano: who it is,
// what the job is, when it is, and a thumb-sized button to call them.
//
// This is a branch in the render function rather than CSS trying to reflow a
// <table> into blocks. Reflowing a table with display:block loses the
// semantics screen readers rely on and fights every fixed width the grid
// sets; building different elements is both simpler and more honest.
//
// Editing still works: tapping a field opens the same editor the table uses.

import { D, view, state } from './state.js';
import { el, fmt, fmtWhen, fmtLong, tel } from './dom.js';
import { editableChoice, BLANK } from './edit.js';
import { placeOf, jobOf, isPastDue } from './fields.js';
import { onModeChange, isPhoneWidth, PHONE_MAX } from './layout.js';
export { PHONE_MAX };

export const phoneQuery = typeof matchMedia === 'function'
  ? matchMedia('(max-width: ' + PHONE_MAX + 'px)')
  : null;

// One source of truth for "are we on a phone". The media query is the
// answer when there is one; innerWidth is the fallback, and also the
// cross-check, because a layout stuck in the wrong mode is worse than one
// that looks twice.
export function isPhone(){
  if (phoneQuery) return phoneQuery.matches;
  return isPhoneWidth(typeof innerWidth === 'number' ? innerWidth : 0);
}

// Both signals, because neither alone proved reliable: in testing, changing
// an emulated viewport fired no resize event and no matchMedia change at
// all. onModeChange only calls back when the mode genuinely flips, so
// listening to both costs nothing.
export function onLayoutChange(fn){
  return onModeChange(isPhone, function(check){
    if (phoneQuery && typeof phoneQuery.addEventListener === 'function') {
      phoneQuery.addEventListener('change', check);
    }
    if (typeof addEventListener === 'function') {
      addEventListener('resize', check);
      addEventListener('orientationchange', check);
    }
  }, fn);
}

const label = (k) => (D.statusLabels && D.statusLabels[k]) || k;

function statusTone(v){
  if (v === 'new') return 'is-newpill';
  if (v === 'paid' || v === 'completed') return 'is-won';
  if (v === 'lost' || v === 'closed') return 'is-done';
  return '';
}

/**
 * One lead as a card.
 *
 * @param handlers {onOpen, onRefer, onSave, onArchive, onToggle}
 */
export function cardFor(r, handlers){
  var selected = state.selected.has(r.id);
  var card = el('article', {className:'card-lead' +
    (r.status === 'new' ? ' is-new' : '') +
    (['closed','lost','completed','paid'].indexOf(r.status) >= 0 ? ' done' : '') +
    (selected ? ' picked' : '')});

  // ---- header: who, and what state they are in
  var head = el('div', {className:'cl-head'});
  var pick = el('input', {type:'checkbox', checked:selected, 'aria-label':'Select ' + (r.name || 'this lead')});
  pick.addEventListener('change', function(){ handlers.onToggle(r, pick.checked, card); });
  head.appendChild(pick);

  head.appendChild(el('button', {className:'cl-name', type:'button', text: r.name || '(no name)',
    'aria-label':'Open ' + (r.name || 'this lead'),
    on:{click:function(){ handlers.onOpen(r); }}}));

  head.appendChild(editableChoice({
    value: r.status == null ? '' : r.status,
    label:'Status',
    options: (D.setStatuses || []).map(function(k){ return { value:k, label:label(k) }; }),
    allLabels: D.statusLabels,
    tone: statusTone,
    save: function(v){ handlers.onSave(r, 'status', v, card); }
  }));
  card.appendChild(head);

  // ---- what the job is
  var what = jobOf(r);
  if (what) card.appendChild(el('div', {className:'cl-what', text:what}));

  // A submitted address usually already contains the city, so appending it
  // produced "88 Peachtree Ln, Marietta, GA 30060, Marietta".
  var where = placeOf(r);
  if (where) card.appendChild(el('div', {className:'cl-where', text:where}));

  // ---- when: the line you check before leaving the house
  var whenRow = el('div', {className:'cl-when'});
  if (r.scheduled_at) {
    var late = isPastDue(r);
    whenRow.appendChild(el('span', {className:'cl-date' + (late ? ' late' : ''),
      text: (late ? 'Past due · ' : '') + fmtWhen(r.scheduled_at),
      title: fmtLong(r.scheduled_at)}));
  } else {
    whenRow.appendChild(el('span', {className:'cl-date empty', text:'Not scheduled'}));
  }
  whenRow.appendChild(el('span', {className:'cl-came', text:'came in ' + fmt(r.created_at)}));
  card.appendChild(whenRow);

  if (view === 'referrals' || r.referred_at) {
    var ref = 'PPT-' + r.id +
      (r.referral_status ? ' · ' + (r.referral_status === 'no_booking' ? "didn't book" : r.referral_status) : '') +
      (r.referral_paid_at ? ' · paid' : '');
    card.appendChild(el('div', {className:'cl-ref', text:ref}));
  }

  if (r.message) card.appendChild(el('div', {className:'cl-msg', text:r.message}));

  // ---- actions, sized for a thumb. Calling is the one you do standing up.
  var acts = el('div', {className:'cl-acts'});
  if (tel(r.phone)) {
    acts.appendChild(el('a', {className:'cl-btn primary', href:'tel:' + tel(r.phone),
      text:'Call', 'aria-label':'Call ' + (r.phone || '')}));
  }
  if (r.phone) {
    acts.appendChild(el('a', {className:'cl-btn', href:'sms:' + tel(r.phone), text:'Text'}));
  }
  if (where) {
    acts.appendChild(el('a', {className:'cl-btn', target:'_blank', rel:'noopener',
      href:'https://maps.google.com/?q=' + encodeURIComponent(where), text:'Map'}));
  }
  acts.appendChild(el('button', {className:'cl-btn', type:'button', text:'Open',
    on:{click:function(){ handlers.onOpen(r); }}}));
  if (view !== 'archive' && !r.referred_at && r.pipeline === 'tuning') {
    acts.appendChild(el('button', {className:'cl-btn refer', type:'button', text:'Refer →',
      on:{click:function(){ handlers.onRefer(r); }}}));
  }
  card.appendChild(acts);

  // The phone number itself, quiet, because the buttons above are how you
  // use it -- but you still sometimes need to read it out.
  if (r.phone) card.appendChild(el('div', {className:'cl-tel', text:r.phone}));
  else card.appendChild(el('div', {className:'cl-tel empty', text:'No phone number ' + BLANK}));

  return card;
}
