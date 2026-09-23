// Dragging a column edge to make it wider.
//
// Widths are per tab and live in this browser's localStorage, not the
// database: how wide somebody likes the Notes column is a preference of the
// screen they are sitting at, not a fact about the business. Every read and
// write is wrapped, because localStorage throws in a private window rather
// than returning nothing, and a column width is never worth an exception.

import { view } from './state.js';

const KEY = 'ppt.widths.' + view;

export function loadWidths(){
  try {
    var raw = localStorage.getItem(KEY);
    if (!raw) return {};
    var o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return {};
    // Only sane numbers, so a corrupt entry cannot collapse the table.
    var out = {};
    for (var k in o) {
      var n = parseInt(o[k], 10);
      if (Number.isInteger(n) && n >= MIN && n <= MAX) out[k] = n;
    }
    return out;
  } catch (e) { return {}; }
}

function store(widths){
  try { localStorage.setItem(KEY, JSON.stringify(widths)); } catch (e) { /* not important enough to fail */ }
}

export const MIN = 60;
export const MAX = 900;

/**
 * Give a header cell a drag handle.
 *
 * @param th      the header cell
 * @param key     what to remember it under, unique per column
 * @param widths  the live map, mutated as the drag goes
 * @param onDone  called when the drag ends, to redraw at the new width
 */
export function addResizer(th, key, widths, onDone){
  var grip = el();
  th.appendChild(grip);

  grip.addEventListener('mousedown', function(e){
    e.preventDefault(); e.stopPropagation();
    var startX = e.clientX;
    var startW = th.getBoundingClientRect().width;
    var moved = false;
    document.body.classList.add('resizing');

    function move(ev){
      moved = true;
      var w = Math.max(MIN, Math.min(MAX, Math.round(startW + (ev.clientX - startX))));
      widths[key] = w;
      th.style.minWidth = w + 'px';
      th.style.maxWidth = w + 'px';
    }
    function up(){
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');

      // The browser fires a click on the header after the drag, and the
      // header's click handler sorts. Swallowing exactly one click stops a
      // resize from silently re-sorting the grid.
      if (moved) {
        th.addEventListener('click', function swallow(ev){
          ev.stopPropagation(); ev.preventDefault();
          th.removeEventListener('click', swallow, true);
        }, true);
      }

      store(widths);
      onDone();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // Double-click the handle to give the column its width back.
  grip.addEventListener('dblclick', function(e){
    e.preventDefault(); e.stopPropagation();
    delete widths[key];
    store(widths);
    onDone();
  });
}

// Built here rather than through dom.js's `el` to keep this module free of
// anything but the DOM it owns.
function el(){
  var g = document.createElement('span');
  g.className = 'grip';
  g.title = 'Drag to resize. Double-click to reset.';
  return g;
}

export function resetAll(){
  try { localStorage.removeItem(KEY); } catch (e) { /* nothing to do */ }
}
