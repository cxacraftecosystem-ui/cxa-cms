/**
 * The full-screen-takeover signal — "something opaque now covers the entire page".
 *
 * WHY THIS EXISTS. The page's continuously-animating layers stop themselves when they cannot be
 * seen, and they decide that from two browser signals: an IntersectionObserver (scrolled away) and
 * `visibilitychange` (tab hidden). A full-screen OVERLAY defeats both — the covered element still
 * intersects the viewport and the tab is still visible — so the hero's particle field kept painting
 * at full rate behind the cinematic story's opaque ground for the story's whole runtime: continuous
 * canvas work nobody could see, on exactly the machines (laptops on battery) where it costs most.
 *
 * So a takeover ANNOUNCES itself here, and any layer with a "may I paint?" predicate can take the
 * answer as one more independent reason to stop. The mechanism is the house one for cross-tree
 * state: an attribute on `<html>` (the same shape as `data-reduced-motion`) plus a `cxa:`-prefixed
 * event (the same shape as STUDIO_SEARCH_EVENT) so listeners need no MutationObserver.
 *
 * ⚠ REFERENCE-COUNTED, because "two takeovers, and one closes" must not uncover the page while the
 * other still stands — the same argument as useScrollLock's counter, which every full-screen
 * takeover also holds. Counting lives at module scope for the same reason it does there: the
 * holders are separate React trees.
 */

const ATTRIBUTE = "data-takeover";
export const TAKEOVER_EVENT = "cxa:takeover";

let holders = 0;

/** Is the page currently covered? Callable from any client code, including before any listener. */
export function pageIsCovered(): boolean {
  return document.documentElement.hasAttribute(ATTRIBUTE);
}

/** Announce a takeover. Pair every call with exactly one `clearTakeover()`. */
export function announceTakeover(): void {
  holders += 1;
  if (holders > 1) return;
  document.documentElement.setAttribute(ATTRIBUTE, "open");
  window.dispatchEvent(new Event(TAKEOVER_EVENT));
}

/** Withdraw one announcement. The page is only uncovered when the last holder lets go. */
export function clearTakeover(): void {
  if (holders === 0) return;
  holders -= 1;
  if (holders > 0) return;
  document.documentElement.removeAttribute(ATTRIBUTE);
  window.dispatchEvent(new Event(TAKEOVER_EVENT));
}
