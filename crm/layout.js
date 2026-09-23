// Deciding when the layout should change, as logic rather than as wiring.
//
// The grid switches between a table and a list of cards at a breakpoint. The
// part worth testing is not "does the browser send a resize event" -- it is
// "given that something changed, do we redraw, and only when the mode
// actually flipped". Dragging a window from 1200px to 1100px must not
// rebuild sixty cards.
//
// This file touches nothing: no DOM, no matchMedia. It takes a function that
// reports the current mode and a function that subscribes to change, which
// is what makes it importable by a test runner.

export const PHONE_MAX = 760;

/**
 * Call `fn` when the mode flips, and only then.
 *
 * @param readMode   () => a value identifying the current mode
 * @param subscribe  (check) => attach `check` to whatever signals change
 * @returns the check function, so a caller can run it by hand
 */
export function onModeChange(readMode, subscribe, fn) {
  let was = readMode();
  const check = () => {
    const now = readMode();
    if (now !== was) {
      was = now;
      fn(now);
    }
  };
  subscribe(check);
  return check;
}

/**
 * Is this width the phone layout?
 *
 * Kept as a plain comparison so the breakpoint has one definition that both
 * the CSS and the JS can be checked against.
 */
export function isPhoneWidth(width) {
  return typeof width === 'number' && width <= PHONE_MAX;
}
