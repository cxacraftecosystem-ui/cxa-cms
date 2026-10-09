"use client";

import { useSyncExternalStore } from "react";

/**
 * Is this render running in the browser, past hydration?
 *
 * `false` on the server and during hydration, `true` on every render after that — including the very
 * first render of a component mounted later by a client navigation, which has no server HTML to agree
 * with and so has nothing to wait for.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT REPLACES `const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), [])`.
 *
 * That pattern renders every component twice on purpose and spends a commit doing it, and React's own
 * lint now refuses it (`react-hooks/set-state-in-effect`): state set synchronously in an effect is a
 * cascading render. `useSyncExternalStore` is the API React provides for a value the server cannot know:
 * the server snapshot is what the HTML was built with, so hydration renders it and agrees with that
 * HTML, and React re-renders with the client snapshot straight after — the same two renders a hydrated
 * component needs, with no effect, and only one render for a component that was never server-rendered.
 *
 * Anything a server cannot know — `document`, `navigator`, a media query, `localStorage` — may be read
 * during render once this is `true`, and must not be before it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(neverChanges, isBrowser, isServer);
}

/** Nothing to subscribe to: the answer changes once, at hydration, and React handles that itself. */
function neverChanges(): () => void {
  return noop;
}

function noop(): void {}

function isBrowser(): boolean {
  return true;
}

function isServer(): boolean {
  return false;
}
