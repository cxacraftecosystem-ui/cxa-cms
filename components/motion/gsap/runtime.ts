"use client";

/**
 * THE GSAP RUNTIME — one dynamic import, one plugin registration, one bridge to Lenis.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT GSAP IS ALLOWED TO DO IN THIS PRODUCT, AND WHY THE LINE IS WHERE IT IS
 *
 * `framer-motion` states declarative animation better than an imperative library can, and it owns
 * every entrance, press, hover, layout change and presence transition on the site. The `motion` skill
 * is emphatic that reaching for GSAP for an ordinary entrance means two animation systems where one
 * would do. Nothing here changes that.
 *
 * GSAP owns exactly two things, and both are things framer genuinely cannot say:
 *
 *   1. **A timeline whose tweens deliberately OVERLAP.** framer's `staggerChildren` is a delay
 *      BETWEEN siblings, so a word can only start once the previous word's delay has elapsed; the
 *      hero headline wants each word starting while the one before it is still travelling, which is
 *      an offset measured from a sibling's START and is a timeline primitive. See
 *      components/sections/hero/HeroHeadline.tsx — it predates this file and deliberately does not
 *      use it, because one `gsap.timeline()` needs no scope and no plugin.
 *
 *   2. **Scroll-SCRUBBED motion** — parallax, a pinned rail, a path that draws itself as the reader
 *      descends, a figure that holds while its chapter passes. framer's `useScroll`/`useTransform`
 *      can map one value, but ScrollTrigger's `scrub`, `pin`, `snap` and per-trigger lifecycle are a
 *      different instrument, and hand-rolling them on top of `useScroll` is how a scroll handler ends
 *      up doing layout reads in the middle of a frame.
 *
 * ⚠ THE INVARIANT THAT MAKES SCRUBBED MOTION SAFE HERE: **every element GSAP scrubs is already in its
 * final, readable position in the HTML.** A parallax layer at rest is the layer; a sticky figure with
 * no JavaScript is a sticky figure. So there is no `opacity: 0` initial state to rescue, no
 * `<noscript>` rule to write, and no flash if the chunk never arrives — the page is simply the page.
 * That is the whole reason the entrance/scrub split above is drawn where it is, and a new GSAP
 * animation that needs to hide something until JavaScript runs is a sign it should have been a
 * `Reveal` instead.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NO TOP-LEVEL `import { gsap } from "gsap"` ANYWHERE. GSAP plus ScrollTrigger is ~95 KB, and a
 * value import here would put it in the bundle of every route that transitively imports any component
 * that imports this module — which, once story blocks are in the section registry, is every page on
 * the site. The imports below are inside the function on purpose and the two at the top are
 * `import type`, which is erased at build.
 */

import type { gsap as GsapNamespace } from "gsap";
import type { ScrollTrigger as ScrollTriggerClass } from "gsap/ScrollTrigger";

import { subscribeToLenis } from "@/components/motion/SmoothScroll";

export interface GsapRuntime {
  gsap: typeof GsapNamespace;
  ScrollTrigger: typeof ScrollTriggerClass;
}

/**
 * The in-flight or settled load. Memoised so that twelve story blocks on one page perform ONE import
 * and ONE `registerPlugin` between them.
 *
 * Registering ScrollTrigger twice is harmless in GSAP itself, but two separate module instances would
 * not be — and more to the point, twelve concurrent `import()` calls that each then wire their own
 * Lenis bridge is twelve `ScrollTrigger.update` calls per scroll frame.
 */
let runtime: Promise<GsapRuntime> | null = null;

/** The attribute `lib/preferences.ts` stamps on `<html>`. Present only when the toggle is ON. */
const REDUCED_MOTION_ATTRIBUTE = "data-reduced-motion";

/**
 * Does this reader want less motion, as of THIS INSTANT — the same union
 * `useReducedMotionPreference()` returns, read synchronously from both sources.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHY A SECOND READER OF THE PREFERENCE EXISTS, WHEN DUPLICATING ONE IS NORMALLY THE BUG.
 *
 * `useReducedMotionPreference()` reports `false` on the server AND on the first client render, ON
 * PURPOSE: a value that differed between the prerendered HTML and the first paint would flash a
 * framer `initial` state, so it is gated behind a mount flag and only tells the truth from the second
 * render onwards (contract §8, and the hook's own header at length).
 *
 * That is right for anything that renders, and wrong for the one decision made in the effect of the
 * FIRST commit: whether to spend ~95 KB of somebody's bandwidth. Every caller currently starts the
 * import while the preference still reads `false`, and then throws the module away one render later —
 * so a reader who explicitly asked for less motion pays the whole download for animation that is
 * never built. On the homepage that download competes with the hero photograph for the LCP.
 *
 * Reading `matchMedia` and the attribute HERE is safe precisely because it never happens during
 * render: nothing downstream of it is markup, so there is nothing to mismatch and nothing to flash.
 *
 * ⚠ THE ATTRIBUTE NAME AND THE MEDIA QUERY ARE NOW WRITTEN IN TWO FILES. Keep this in step with
 * `components/motion/useReducedMotionPreference.ts`; it is the same union by construction and a
 * divergence would mean the chunk was fetched for one switch and not the other.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function prefersLessMotionNow(): boolean {
  if (typeof document === "undefined") return false;

  if (document.documentElement.getAttribute(REDUCED_MOTION_ATTRIBUTE) === "true") return true;

  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Load GSAP and ScrollTrigger, registered and bridged to Lenis. Safe to call from anywhere, any
 * number of times.
 *
 * ⚠ REJECTS IF THE CHUNK DOES NOT ARRIVE, and every caller must handle that by leaving the DOM
 * exactly as rendered. A failed animation library is not an error a reader can act on; it is a page
 * without parallax, which is a complete page.
 */
export function loadGsapRuntime(): Promise<GsapRuntime> {
  if (runtime) return runtime;

  const pending = Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(
    ([core, plugin]) => {
      const { gsap } = core;
      const { ScrollTrigger } = plugin;

      gsap.registerPlugin(ScrollTrigger);

      /**
       * `ignoreMobileResize` — a mobile browser hides and shows its address bar as the reader
       * scrolls, which changes the viewport height mid-gesture. Without this, ScrollTrigger treats
       * that as a resize, recalculates every trigger's start and end, and the page jumps under the
       * thumb at the exact moment somebody is reading it. The heights that matter here are set in
       * `svh`/`dvh` units, so nothing depends on the recalculation.
       */
      ScrollTrigger.config({ ignoreMobileResize: true });

      bridgeToLenis(ScrollTrigger);
      watchForLateLayout(ScrollTrigger);

      return { gsap, ScrollTrigger };
    }
  );

  // A failed chunk must not poison every later attempt: clearing the memo lets a subsequent
  // navigation try again. The `.catch` is on a DERIVED promise, so callers still see the rejection
  // and are still responsible for their own fallback — this only resets the cache.
  void pending.catch(() => {
    if (runtime === pending) runtime = null;
  });

  runtime = pending;
  return pending;
}

/**
 * Keep ScrollTrigger in step with Lenis.
 *
 * Lenis here scrolls the document for real, so the native `scroll` event does fire and ScrollTrigger
 * is never blind — but it fires after the frame in which Lenis wrote the position, so a scrubbed
 * layer trails the text beside it by one frame and reads as "swimming". Updating inside Lenis's own
 * callback removes the frame.
 *
 * `subscribeToLenis` calls back IMMEDIATELY with the current instance and again on every change, so
 * this is correct whichever of the two dynamic imports wins the race, and correct again when a route
 * change destroys one instance and creates another. `null` — the studio, reduced motion, a failed
 * Lenis chunk — is the normal case and means the native scroll event is doing the job on its own.
 *
 * DELIBERATELY NEVER UNSUBSCRIBED. The runtime is a module-level singleton for the lifetime of the
 * document; there is no moment at which "GSAP is loaded but should stop hearing about scrolling".
 */
function bridgeToLenis(ScrollTrigger: typeof ScrollTriggerClass): void {
  const update = () => ScrollTrigger.update();
  let detach: (() => void) | null = null;

  subscribeToLenis((instance) => {
    detach?.();
    detach = null;
    if (!instance) return;

    instance.on("scroll", update);
    detach = () => instance.off("scroll", update);
  });
}

/**
 * Recalculate trigger positions when the page grows AFTER the triggers were measured.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS PREVENTS, WHICH IS THE MOST COMMON ScrollTrigger BUG THERE IS.
 *
 * A trigger's `start` and `end` are pixel offsets computed once, at creation. Everything on this site
 * that comes after them can change the document's height later: a lazily-decoded photograph settling
 * into its aspect ratio, a web font swapping in and reflowing a paragraph, an accordion opening. Every
 * one of those moves the content while the numbers stay where they were, and the symptom is a pin
 * that releases early or a parallax that finishes halfway down the section.
 *
 * `ScrollTrigger.refresh()` recomputes them all. It is not cheap — it forces layout — so it is
 * debounced to the end of the frame batch rather than run per mutation, and it is driven by:
 *
 *   • a `ResizeObserver` on `<body>`, which fires for a late image, a font swap and an expanding
 *     panel alike (all three change the body's box), and
 *   • the `load` event, for the case where every image arrives after `DOMContentLoaded`.
 *
 * ⚠ NOT a `MutationObserver`. React rewrites attributes constantly and a refresh per mutation would
 * mean a forced layout per render.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function watchForLateLayout(ScrollTrigger: typeof ScrollTriggerClass): void {
  if (typeof window === "undefined") return;

  let frame = 0;
  const refreshSoon = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      ScrollTrigger.refresh();
    });
  };

  if (document.readyState !== "complete") {
    window.addEventListener("load", refreshSoon, { once: true, passive: true });
  }

  if (typeof ResizeObserver === "function") {
    // `<body>` rather than the scrolling element: `<html>`'s box does not change when its content
    // grows, so an observer on it would never fire for the case this exists to catch.
    new ResizeObserver(refreshSoon).observe(document.body);
  }
}

/**
 * Ask every live trigger to re-measure. For a caller that KNOWS it just changed the page height —
 * a filter that swapped a twelve-card grid for a three-card one — and does not want to wait for the
 * observer above to notice.
 *
 * A no-op before the runtime has loaded, which is correct: triggers that do not exist yet will be
 * measured against the layout as it is when they are created.
 */
export function refreshScrollTriggers(): void {
  if (!runtime) return;
  void runtime.then(({ ScrollTrigger }) => ScrollTrigger.refresh()).catch(() => {
    // The runtime failed to load; there is nothing to refresh and nothing to report.
  });
}
