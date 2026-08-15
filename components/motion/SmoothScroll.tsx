"use client";

/**
 * SmoothScroll — mounts Lenis for the PUBLIC SITE only.
 *
 * Rendered once, by app/(site)/layout.tsx. It renders no DOM of its own; it owns a side effect and a
 * single module-level handle to the running instance.
 *
 * FIVE THINGS THIS FILE IS CAREFUL ABOUT, EACH BECAUSE THE OBVIOUS VERSION IS BROKEN:
 *
 *  1. **Reduced motion disables it entirely** — not "slows it down". Inertia IS the motion being
 *     objected to, and a gentler version of an unwanted effect is still the unwanted effect.
 *
 *     ⚠ AND THE HOOK ALONE CANNOT BUY THAT, WHICH IS WHY THE EFFECT ALSO READS THE DOM.
 *     `useReducedMotionPreference()` deliberately answers `false` until after mount, so that a
 *     prerendered page cannot branch its first paint on something the server could not know — which
 *     means the effect's FIRST pass sees `reduce === false` for every reader, including one whose
 *     operating system has asked for less. `import("lenis")` on that pass has already fetched and
 *     parsed the chunk by the time the corrected value re-runs the effect and tears it down: the
 *     download would be paid for by exactly the reader it was meant to spare. So the synchronous
 *     union — `prefersLessMotion()` at the foot of this file, the attribute plus `matchMedia`, both
 *     available before first paint because lib/preferences.ts's boot script stamps the attribute —
 *     is what actually guards the import, and the `reduce` guard beside it is what handles a reader
 *     who flips the in-app toggle afterwards. HeroSection.tsx guards its three.js chunk the same way
 *     and for the same reason; the two notes belong together.
 *
 *  2. **One instance, ever.** Two Lenis instances mean two rAF loops writing `scrollTop` in the same
 *     frame, and the page judders in a way that looks like a slow device rather than a bug. The
 *     dynamic import is guarded by a `cancelled` flag, because React can unmount the component (or
 *     Strict Mode can re-run the effect) before the module resolves, and without the flag the second
 *     effect's instance would be created after the first effect's cleanup has already run.
 *
 *  3. **It never runs inside the studio.** A CMS that scrolls with inertia feels broken the moment
 *     you are trying to land on a table row. The route guard is belt-and-braces — the component is
 *     only mounted by the (site) layout — but a shared layout is exactly the sort of refactor that
 *     smuggles it in.
 *
 *  4. **`scroll-behavior: smooth` is stood down while Lenis is active.** globals.css sets it on
 *     `<html>` for native anchor jumps; leaving it on means an anchor navigation is smoothed by the
 *     browser at the same time as Lenis is animating towards a different target. The attribute
 *     `data-lenis` marks the state on `<html>` (so other components and any later CSS can see it) and
 *     the inline `scroll-behavior: auto` is what actually wins, since no stylesheet in this repo
 *     carries a `[data-lenis]` rule. Both are removed on cleanup, and the previous inline value is
 *     restored rather than blanked.
 *
 *  5. **In-page anchors still work.** `scrollToElement()` below routes through Lenis when it is
 *     mounted and falls back to native `scrollIntoView` when it is not, so a component that wants to
 *     jump to a heading does not have to know which world it is in.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import type Lenis from "lenis";

import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

/**
 * The one live instance, or null. A module-level handle rather than a context because the callers are
 * event handlers and one-off helpers, not renderers — a context would force every consumer to be a
 * component and would re-render the tree for a value that never changes during a render.
 */
const lenisRef: { current: Lenis | null } = { current: null };

/**
 * Everybody who needs to know WHEN the instance appears or goes away.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: GSAP's ScrollTrigger has to be told when Lenis has scrolled.
 *
 * Lenis in this configuration scrolls the document for real (it calls `window.scrollTo`), so the
 * native `scroll` event does fire and ScrollTrigger is not blind — but it fires AFTER the frame in
 * which Lenis wrote the position, so every scrubbed animation trails the page it is pinned to by one
 * frame. At 60fps that is 16ms of visible slip between a parallax layer and the text beside it, and
 * it reads as the image "swimming".
 *
 * The fix is for ScrollTrigger to update inside Lenis's own scroll callback, which means something
 * has to hand it the instance. A getter alone cannot: the GSAP chunk and the Lenis chunk are two
 * dynamic imports racing each other, so whichever arrives second would find the other already
 * settled and whichever arrives first would find nothing. A subscription is the only shape that is
 * correct in both orders — a late subscriber is called immediately with the running instance, and an
 * early one is called when the instance arrives.
 *
 * `null` means "there is no smooth scrolling now" — which happens on the studio, under reduced
 * motion, and if the Lenis chunk fails to load. A subscriber must treat that as the normal case and
 * fall back to the native scroll event, not as an error.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
type LenisListener = (instance: Lenis | null) => void;

const lenisListeners = new Set<LenisListener>();

/**
 * Watch the Lenis instance. Called IMMEDIATELY with the current value, then on every change.
 *
 * Returns its own unsubscribe. The immediate call is what makes the two-dynamic-import race safe:
 * a subscriber never has to ask whether it was early or late.
 */
export function subscribeToLenis(listener: LenisListener): () => void {
  lenisListeners.add(listener);
  listener(lenisRef.current);
  return () => {
    lenisListeners.delete(listener);
  };
}

/**
 * Publish a change of instance.
 *
 * The set is copied before iterating because a listener is allowed to unsubscribe itself from inside
 * its own callback — a teardown that runs in response to the instance going away is the obvious case,
 * and mutating a `Set` while `for…of` walks it skips the next entry.
 */
function announceLenis(instance: Lenis | null): void {
  lenisRef.current = instance;
  for (const listener of Array.from(lenisListeners)) listener(instance);
}

/** Routes that must never be smoothed. `/console` is the studio's second door (contract §0). */
const STUDIO_PREFIXES = ["/studio", "/console"] as const;

function isStudioRoute(pathname: string): boolean {
  return STUDIO_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function SmoothScroll() {
  const reduce = useReducedMotionPreference();
  const pathname = usePathname();

  useEffect(() => {
    // Three refusals, and the middle one is not redundant: see note 1 in the header. `reduce` is the
    // LIVE half (it re-runs this effect when the toggle flips), `prefersLessMotion()` is the half that
    // is already correct on the mounting pass and is therefore the one standing between a
    // reduced-motion reader and 25 KB of smooth-scrolling they did not ask for.
    if (reduce || prefersLessMotion() || isStudioRoute(pathname)) return;

    const root = document.documentElement;
    const previousScrollBehavior = root.style.scrollBehavior;

    let cancelled = false;
    let instance: Lenis | null = null;
    let frame = 0;

    void import("lenis")
      .then(({ default: LenisConstructor }) => {
        if (cancelled) return;

        instance = new LenisConstructor({
          // We drive the frame loop ourselves so that cancelling it is part of the same cleanup that
          // destroys the instance; `autoRaf` would leave the library scheduling its own.
          autoRaf: false,
          smoothWheel: true,
          // Touch scrolling stays native. A phone that does not move at exactly finger speed reads as
          // a broken page, not a polished one.
          syncTouch: false,
          // Anchor handling is ours (see `scrollToElement`), so the library must not also claim
          // clicks on `#…` links and race us to the same target.
          anchors: false
        });
        // Every other option is left at the library's default on purpose: the contract fixes the
        // numbers for framer transitions, and inventing a lerp here would be a second, private feel.

        announceLenis(instance);
        root.setAttribute("data-lenis", "true");
        root.style.scrollBehavior = "auto";

        const loop = (time: number) => {
          instance?.raf(time);
          frame = requestAnimationFrame(loop);
        };
        frame = requestAnimationFrame(loop);
      })
      .catch(() => {
        // A failed chunk means native scrolling, which is a complete experience. There is nothing to
        // tell the reader — they did not ask for inertia and cannot act on its absence.
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      instance?.destroy();
      // Guarded: under Strict Mode's double-invoked effects the SECOND effect's instance may already
      // be the published one by the time the FIRST effect's cleanup runs, and blanking it here would
      // leave every subscriber believing there is no smooth scrolling while there plainly is.
      if (lenisRef.current === instance) announceLenis(null);
      root.removeAttribute("data-lenis");
      root.style.scrollBehavior = previousScrollBehavior;
    };
    // Re-created on navigation: the old instance measured the old document, and a route change is
    // also the moment a reader is most likely to be mid-gesture on content that no longer exists.
  }, [reduce, pathname]);

  return null;
}

export interface ScrollToElementOptions {
  /** Jump instead of gliding, whatever the preference says. */
  immediate?: boolean;
}

/**
 * Scroll to an element or `#id`, through Lenis if it is mounted and natively if it is not.
 *
 * The clearance matters more than it looks. globals.css gives anchor targets
 * `scroll-margin-top: var(--nav-clearance)`, which native scrolling honours automatically — but
 * Lenis computes the target from `offsetTop` and knows nothing about scroll margins, so a heading
 * scrolled to through Lenis would land underneath the fixed header. The offset is therefore applied
 * by hand on the Lenis path ONLY; applying it on both would pay the header twice.
 */
export function scrollToElement(target: string | Element, options: ScrollToElementOptions = {}): void {
  if (typeof document === "undefined") return;

  const element = resolveTarget(target);
  if (!element) return;

  const immediate = options.immediate ?? prefersLessMotion();
  const instance = lenisRef.current;

  if (instance && element instanceof HTMLElement) {
    // Negative, because Lenis adds the offset to the target position and we want to stop above it.
    instance.scrollTo(element, { offset: -clearanceFor(element), immediate });
    return;
  }

  element.scrollIntoView({ behavior: immediate ? "auto" : "smooth", block: "start" });
}

function resolveTarget(target: string | Element): Element | null {
  if (typeof target !== "string") return target;
  const id = target.startsWith("#") ? target.slice(1) : target;
  // `getElementById` rather than `querySelector`, because an id that starts with a digit or contains
  // a colon is legal HTML and an illegal CSS selector — `querySelector("#2026-review")` throws.
  return document.getElementById(id);
}

/**
 * How much room to leave above a target, in pixels.
 *
 * `--nav-clearance` is declared in rem and the root font size changes when the reader turns on larger
 * text, so it is resolved through the computed root font size rather than assumed to be 16. The
 * element's own computed `scroll-margin-top` is taken as a floor, so anything that opts into more
 * room keeps it — but it cannot be relied on alone, because the `:target` rule that supplies it only
 * matches once the hash has actually changed, which is usually after this call.
 */
function clearanceFor(element: Element): number {
  const root = document.documentElement;
  const rootStyle = window.getComputedStyle(root);

  const declared = rootStyle.getPropertyValue("--nav-clearance").trim();
  const rootFontSize = Number.parseFloat(rootStyle.fontSize);
  let navClearance = 0;

  if (declared.endsWith("rem")) {
    const rems = Number.parseFloat(declared);
    if (Number.isFinite(rems) && Number.isFinite(rootFontSize)) navClearance = rems * rootFontSize;
  } else if (declared.endsWith("px")) {
    const pixels = Number.parseFloat(declared);
    if (Number.isFinite(pixels)) navClearance = pixels;
  }

  const ownMargin = Number.parseFloat(window.getComputedStyle(element).scrollMarginTop);
  return Math.max(navClearance, Number.isFinite(ownMargin) ? ownMargin : 0);
}

/**
 * The same union as `useReducedMotionPreference()`, read from the DOM.
 *
 * It is duplicated rather than shared because its two callers cannot use a hook: `scrollToElement` is
 * a plain function reached from event handlers, and the mount effect above needs the answer one render
 * EARLIER than any hook can give it (header, note 1). Both halves are read at the moment of the call,
 * so it cannot go stale the way a captured value would.
 */
function prefersLessMotion(): boolean {
  if (document.documentElement.getAttribute("data-reduced-motion") === "true") return true;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
