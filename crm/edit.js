// Cells that read as text and edit on click.
//
// The grid used to render every field as an always-on input: 1,667 form
// controls to read 100 leads, thirteen bordered boxes per row. Everything
// shouted at the same volume, so nothing was legible -- a new lead looked
// exactly like one closed eight months ago.
//
// A cell now shows its value as text and becomes the input it always was
// when you click it. Nothing is lost: the same field, the same save, the
// same green or red flash. You read far more often than you edit, so
// reading is what the default state is for.
//
// Keyboard behaviour is the part people notice when it is missing:
//   Enter or Space   start editing (the cell is focusable)
//   Enter            save and close
//   Escape           abandon the edit, restore what was there
//   Tab / blur       save and close
//
// Customer text still reaches the DOM only through textContent and .value.

import { el, flash } from './dom.js';

// What an empty field looks like. A dash reads as "nothing here"; an empty
// box reads as "something is broken".
export const BLANK = '—';

/**
 * A text cell you can edit.
 *
 * @param opts.value    current value
 * @param opts.display  how to render it when not editing
 * @param opts.save     (newValue) => Promise
 * @param opts.label    accessible name
 * @param opts.multi    true for a textarea
 */
export function editableText(opts) {
  const host = el('div', { className: 'cellv' });

  function showText() {
    host.textContent = '';
    const shown = opts.display ? opts.display(opts.value) : String(opts.value == null ? '' : opts.value);
    const view = el('div', {
      className: 'val' + (shown ? '' : ' empty'),
      text: shown || BLANK,
      title: shown || '',
      tabIndex: 0,
      role: 'button',
      'aria-label': (opts.label || 'Edit') + (shown ? ': ' + shown : '')
    });
    view.addEventListener('click', edit);
    view.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(); }
    });
    host.appendChild(view);
  }

  function edit() {
    host.textContent = '';
    const input = opts.multi
      ? el('textarea', { value: String(opts.value == null ? '' : opts.value), 'aria-label': opts.label || '' })
      : el('input', { value: String(opts.value == null ? '' : opts.value), 'aria-label': opts.label || '' });
    let done = false;

    const finish = (commit) => {
      if (done) return;
      done = true;
      const next = input.value;
      if (!commit || next === String(opts.value == null ? '' : opts.value)) { showText(); return; }
      opts.value = next;
      showText();
      opts.save(next);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done = true; showText(); }
      // A textarea keeps Enter for newlines; a single-line field commits.
      else if (e.key === 'Enter' && !opts.multi) { e.preventDefault(); finish(true); }
    });
    input.addEventListener('blur', () => finish(true));

    host.appendChild(input);
    input.focus();
    if (input.select) input.select();
  }

  showText();
  return host;
}

/**
 * A value chosen from a list: shown as a quiet pill, a real select once
 * clicked.
 *
 * @param opts.options  [{value, label, disabled}]
 * @param opts.tone     extra class for the pill, e.g. the status colour
 */
export function editableChoice(opts) {
  const host = el('div', { className: 'cellv' });

  // A value that is no longer selectable still has a name. Looking only at
  // the options would print the raw key -- 'referred' instead of 'Referred'
  // -- on exactly the rows that carry the value nobody may choose.
  const labelFor = (v) => {
    if (v == null || v === '') return '';
    const hit = (opts.options || []).find((o) => String(o.value) === String(v));
    if (hit) return hit.label;
    if (opts.allLabels && opts.allLabels[v]) return opts.allLabels[v];
    return String(v);
  };

  function showPill() {
    host.textContent = '';
    const text = labelFor(opts.value);
    const pill = el('button', {
      type: 'button',
      className: 'pillv' + (opts.tone ? ' ' + opts.tone(opts.value) : '') + (text ? '' : ' empty'),
      text: text || BLANK,
      'aria-label': (opts.label || 'Change') + (text ? ': ' + text : '')
    });
    if (opts.disabled) {
      pill.disabled = true;
      pill.title = opts.disabledReason || '';
    } else {
      pill.addEventListener('click', edit);
    }
    host.appendChild(pill);
  }

  function edit() {
    host.textContent = '';
    const sel = el('select', { 'aria-label': opts.label || '' });
    if (opts.blank || opts.value == null || opts.value === '') {
      sel.appendChild(el('option', { value: '', text: BLANK }));
    }
    // A value nobody may choose any more still has to display on the rows
    // that already carry it. Shown disabled, so it reads without being
    // selectable -- this is the referral decoy fix, kept.
    const known = (opts.options || []).some((o) => String(o.value) === String(opts.value));
    if (!known && opts.value != null && opts.value !== '') {
      sel.appendChild(el('option', { value: String(opts.value), disabled: true, text: labelFor(opts.value) }));
    }
    (opts.options || []).forEach((o) => {
      sel.appendChild(el('option', { value: String(o.value), text: o.label }));
    });
    sel.value = String(opts.value == null ? '' : opts.value);

    let done = false;
    const close = (commit, next) => {
      if (done) return;
      done = true;
      if (commit && next !== String(opts.value == null ? '' : opts.value)) {
        opts.value = next;
        showPill();
        opts.save(next);
      } else {
        showPill();
      }
    };
    sel.addEventListener('change', () => {
      if (!sel.value && !opts.blank) { close(false); return; }
      close(true, sel.value);
    });
    sel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
    sel.addEventListener('blur', () => close(false));

    host.appendChild(sel);
    sel.focus();
  }

  showPill();
  return host;
}

// A save that reports itself on the cell it came from.
export function saving(td, promise, onOk) {
  return promise.then((j) => { flash(td, true); if (onOk) onOk(j); },
    (e) => { flash(td, false); alert(e.message); });
}
