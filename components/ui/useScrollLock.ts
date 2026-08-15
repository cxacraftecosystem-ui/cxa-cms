"use client";

/**
 * useScrollLock — freeze the page behind an overlay, and pay back the scrollbar it takes away.
 *
 * THE LOCK IS ON `<html>`, NOT `<body>`. iOS Safari quietly ignores `overflow: hidden` on the body
 * and keeps panning the document under an open sheet (contract §14). The `.scroll-locked` recipe in
 * globals.css owns the CSS half; this file owns the measuring, the ordering and the counting.
 *
 * ORDER MATTERS AND IS NOT COSMETIC. `--scroll-gutter` is written BEFORE the class lands: adding the
 * class removes the scrollbar in the same style flush, and if the padding that replaces its width is
 * not already in place there is one painted frame in which every centred element on the page slides
 * sideways by ~10px and back. Setting the variable first makes the two changes land together.
 *
 * IT REFERENCE-COUNTS, AT MODULE SCOPE. Two stacked dialogs are two independent React components; if
 * each simply added and removed the class, closing the inner one would free the page while the outer
 * one is still open — the page scrolls under a modal that is still on screen. The counter lives
 * outside React because the holders are separate trees (a dialog, a nav sheet and a lightbox never
 * share a provider), and only the 0→1 and 1→0 transitions touch the DOM. Re-measuring on the second
 * lock would read a gutter of 0, because the scrollbar is already gone.
 *
 * THE SCROLL POSITION IS RECORDED AND RESTORED because `overflow: hidden` on the root is not
 * guaranteed to preserve it — most desktop browsers do, mobile Safari does not. Restoration is
 * `behavior: "instant"`, because globals.css sets `scroll-behavior: smooth` on `<html>` and a plain
 * `scrollTo` would visibly glide the page back after the overlay has gone.
 *
 * ⚠ Unlock restores the position synchronously, so a component that navigates must let the overlay
 * unmount before the route changes (which is what closing it first does). An overlay that navigates
 * while still mounted will fight the router's own scroll restoration.
 */

import { useEffect } from "react";

/** Matches `html.scroll-locked` in globals.css. Written as a literal there, so it is a literal here. */
const LOCK_CLASS = "scroll-locked";

/** Read by `html.scroll-locked body`, `.nav-frame`, `.overlay-frame` and every fixed overlay. */
const GUTTER_PROPERTY = "--scroll-gutter";

let holders = 0;
let restoreX = 0;
let restoreY = 0;

/**
 * Take a lock. Every call MUST be paired with exactly one `unlockScroll()`, which is why the hook
 * below is the preferred way in — an effect cleanup cannot be forgotten.
 */
export function lockScroll(): void {
  holders += 1;
  if (holders > 1) return;

  const root = document.documentElement;
  // `innerWidth` includes the scrollbar, `clientWidth` does not; the difference is its width. Clamped
  // at zero because overlay scrollbars (macOS, most phones) make the two equal and a float rounding
  // error could otherwise produce a negative padding.
  const gutter = Math.max(0, window.innerWidth - root.clientWidth);

  restoreX = window.scrollX;
  restoreY = window.scrollY;

  root.style.setProperty(GUTTER_PROPERTY, `${gutter}px`);
  root.classList.add(LOCK_CLASS);
}

/** Release a lock. The page is only freed when the last holder lets go. */
export function unlockScroll(): void {
  if (holders === 0) return;
  holders -= 1;
  if (holders > 0) return;

  const root = document.documentElement;
  root.classList.remove(LOCK_CLASS);
  root.style.removeProperty(GUTTER_PROPERTY);
  window.scrollTo({ top: restoreY, left: restoreX, behavior: "instant" });
}

/**
 * Hold the lock for as long as this component is mounted and `active` is true.
 *
 * Mount the hook inside the component that is only mounted WHILE THE OVERLAY IS ON SCREEN — including
 * its exit animation. Releasing the lock at the start of a 180ms fade brings the scrollbar back while
 * the dialog is still visible, and the page jumps under it.
 */
export function useScrollLock(active = true): void {
  useEffect(() => {
    if (!active) return;
    lockScroll();
    return unlockScroll;
  }, [active]);
}

/** How many overlays currently hold the lock. Exported for diagnostics, not for control flow. */
export function scrollLockHolders(): number {
  return holders;
}
