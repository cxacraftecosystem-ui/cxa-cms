"use client";

/**
 * Does this reader want less motion? — the JavaScript half of the answer.
 *
 * There are TWO sources and they are UNIONED, never subtracted, exactly as the CSS in globals.css
 * does it:
 *
 *   1. The operating system's `prefers-reduced-motion`, read through framer's `useReducedMotion()`.
 *   2. The in-app accessibility toggle, which lib/preferences.ts writes as `data-reduced-motion` on
 *      `<html>` (present only when ON — there is deliberately no `="false"` state, so the in-app
 *      switch can only ever ADD reduction on top of the OS preference).
 *
 * The attribute is watched with a `MutationObserver` rather than read once, because the preferences
 * panel flips it live and a reader who turns the toggle on should not have to reload to be believed.
 * framer's hook, by contrast, snapshots the OS value at mount and does not update — so the attribute
 * is the live half of this union and the OS half is settled per mount. That is acceptable: nobody
 * changes their system setting mid-visit, and every navigation remounts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS RETURNS `false` ON THE SERVER *AND* DURING HYDRATION
 *
 * framer's `useReducedMotion()` reads `matchMedia` DURING RENDER. On a machine with the OS setting
 * on, it therefore returns `true` on the very first client render — while the prerendered HTML was
 * built with it `false`, because a server has no media queries. Anything derived from it that
 * affects the FIRST paint would differ between the two, and React keeps the server's DOM while
 * framer immediately writes the client's inline styles over it: the section flashes.
 *
 * So the value is gated on hydration (`useHydrated`), and the rule that follows is not optional:
 *
 *   **On the public, prerendered pages, reduced motion may change DURATIONS. It must never change
 *   the `initial` state.**
 *
 * An `initial` of `{ opacity: 0 }` stays `{ opacity: 0 }` under reduction; what changes is that it
 * reaches `{ opacity: 1 }` in zero seconds instead of half of one. Collapsing a DISPLACEMENT inside
 * an already-invisible initial state (`y: 24` → `y: 0` while `opacity` stays `0`) is fine and is what
 * `variants.ts` does — the element is invisible either way, so there is nothing to flash.
 *
 * A component mounted LATER, by a client navigation, has no server HTML to agree with, so it is told
 * the truth on its very first render. (Until 2026-10 this hook flipped a mount flag in an effect and
 * answered `false` on the first render of EVERY mount; React's lint now refuses state set
 * synchronously in an effect, and the hydration gate is the part that was ever needed.)
 *
 * Inside the studio, where nothing is prerendered for anonymous readers, branching `initial` is
 * harmless. Do not copy either pattern across (contract §8).
 */

import { useSyncExternalStore } from "react";
import { useReducedMotion } from "framer-motion";

import { useHydrated } from "@/lib/client/useHydrated";

const REDUCED_MOTION_ATTRIBUTE = "data-reduced-motion";

export function useReducedMotionPreference(): boolean {
  const systemPrefers = useReducedMotion() === true;
  const inAppPrefers = useSyncExternalStore(watchInAppToggle, readInAppToggle, inAppToggleOnServer);
  const hydrated = useHydrated();

  return hydrated && (inAppPrefers || systemPrefers);
}

/**
 * The in-app toggle as a store React subscribes to. Module-level functions, so their identity never
 * changes and React subscribes once per mount rather than once per render.
 */
function watchInAppToggle(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  // Filtered to the one attribute: `<html>` also carries data-theme, data-larger-text and
  // data-high-contrast, and an unfiltered observer would wake this hook on every theme change.
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [REDUCED_MOTION_ATTRIBUTE]
  });
  return () => observer.disconnect();
}

function readInAppToggle(): boolean {
  return document.documentElement.getAttribute(REDUCED_MOTION_ATTRIBUTE) === "true";
}

function inAppToggleOnServer(): boolean {
  return false;
}
