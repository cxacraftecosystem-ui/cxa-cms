"use client";

/**
 * useGsapScope — build scroll-scrubbed GSAP animations inside a component, correctly, in one hook.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT EXISTS BECAUSE THE FOUR WAYS TO GET THIS WRONG ARE ALL EASY AND NONE OF THEM SHOW UP IN
 * DEVELOPMENT ON THE FIRST PAGE YOU LOOK AT.
 *
 *  1. **A ScrollTrigger that is never killed.** Unlike a tween, a ScrollTrigger registers itself with
 *     a module-level list and keeps recalculating on every scroll after its component has gone. In
 *     the App Router, moving between two pages that each carry a story block leaves the first page's
 *     triggers measuring elements that are no longer in the document — the second page then scrubs
 *     against the first page's numbers. `gsap.context()` + `ctx.revert()` collects them, and this
 *     hook makes it impossible to build one outside a context.
 *
 *  2. **React's double-invoked effects.** In development every effect runs, cleans up and runs again.
 *     Without a context the second run builds a second trigger on the same element while the first is
 *     still live, and every scrubbed value is applied twice — which reads as an animation that is
 *     twice as fast, not as a bug.
 *
 *  3. **The teardown that beats the dynamic import.** `import("gsap")` takes a network round trip on
 *     a cold cache. A reader who scrolls straight past a section unmounts it before the chunk lands,
 *     and the `.then` then builds triggers on detached nodes and holds the whole subtree from garbage
 *     collection. The `cancelled` flag closes that window.
 *
 *  4. **A rebuilt timeline on every render.** The builder callback is a new function identity every
 *     render, so putting it in the dependency array rebuilds every trigger whenever any state in the
 *     component changes. It is held in a ref instead and the caller states its OWN dependencies —
 *     the same contract `useGSAP` from `@gsap/react` uses, without adding the package.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * REDUCED MOTION BUILDS NOTHING AT ALL — not a faster version, and not a shorter one. Because
 * everything GSAP scrubs here is already in its final position in the HTML (see runtime.ts), "build
 * nothing" leaves a complete, readable page, so there is no settle step and no inline style to clear.
 * The preference is in the dependency list, so a reader who turns the toggle on mid-page has the
 * context reverted under them and every transform GSAP wrote is removed. It is ALSO read a second
 * time, synchronously, at the top of the effect — the hook's value is `false` for one render by
 * design, and that one render is the one that would otherwise have started the download. Both tests
 * are commented where they sit.
 */

import { useEffect, useRef, type DependencyList, type RefObject } from "react";

import {
  loadGsapRuntime,
  prefersLessMotionNow,
  type GsapRuntime
} from "@/components/motion/gsap/runtime";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

/** The `gsap.context()` handle, derived from the namespace so this file needs no global type. */
type GsapContext = ReturnType<GsapRuntime["gsap"]["context"]>;

export interface GsapScopeArgs<T extends HTMLElement> extends GsapRuntime {
  /** The element the returned ref is attached to. Never null inside the builder. */
  scope: T;
  /**
   * Every descendant matching `selector`, as an array.
   *
   * A helper rather than leaving callers to write `scope.querySelectorAll` because the array form is
   * what GSAP wants (a `NodeList` works, but `.length === 0` has to be checked either way) and
   * because an empty result is the single most common reason a GSAP animation silently does nothing
   * — a builder that reads `const items = q("[data-item]")` and guards on `items.length` is a builder
   * that fails loudly in review rather than quietly in production.
   */
  q: (selector: string) => HTMLElement[];
}

export type GsapScopeBuilder<T extends HTMLElement> = (args: GsapScopeArgs<T>) => void;

/**
 * Attach the returned ref to the element that contains everything the builder animates.
 *
 * ```tsx
 * const ref = useGsapScope<HTMLDivElement>(({ gsap, q }) => {
 *   const layers = q("[data-parallax]");
 *   if (layers.length === 0) return;
 *   gsap.to(layers, { yPercent: -12, ease: "none", scrollTrigger: { trigger: ref.current, scrub: true } });
 * }, []);
 * ```
 *
 * @param build The animations to create. Runs inside `gsap.context()` scoped to the element, so a
 *   selector string passed to `gsap.to("[data-x]", …)` is already scoped and every tween and trigger
 *   it creates is collected for teardown. Pass `null` to build nothing (a block whose animation is
 *   switched off in its settings) — the hook order stays the same either way.
 * @param deps Rebuild when these change. State the values the builder READS, exactly as for
 *   `useEffect`; the builder's own identity is deliberately not one of them.
 */
export function useGsapScope<T extends HTMLElement = HTMLDivElement>(
  build: GsapScopeBuilder<T> | null,
  deps: DependencyList = []
): RefObject<T | null> {
  const scopeRef = useRef<T | null>(null);
  const reduce = useReducedMotionPreference();

  // The latest builder, without it being a dependency. Written during render rather than in an
  // effect: the effect below may run before a later render's effect, and a builder that is one render
  // stale would close over the previous props.
  const buildRef = useRef(build);
  buildRef.current = build;

  useEffect(() => {
    const scope = scopeRef.current;
    const builder = buildRef.current;

    // ⚠ BOTH TESTS ARE LOAD-BEARING AND THEY ARE NOT THE SAME TEST. `reduce` is the mount-gated hook
    // and is what makes a reader who flips the toggle LATER have this context reverted under them —
    // it must stay in the dependency list for that. But it is deliberately `false` on the first
    // render, so on the first commit it is `prefersLessMotionNow()` that stops a reader who asked for
    // less motion paying for a ~95 KB download they will never see. See runtime.ts.
    if (!scope || !builder || reduce || prefersLessMotionNow()) return;

    let cancelled = false;
    let context: GsapContext | null = null;

    void loadGsapRuntime()
      .then((runtime) => {
        // The element may have unmounted while the chunk was in flight. Building here would create
        // triggers on a detached node and hold the subtree from collection.
        if (cancelled) return;

        context = runtime.gsap.context(() => {
          builder({
            ...runtime,
            scope,
            q: (selector) => Array.from(scope.querySelectorAll<HTMLElement>(selector))
          });
        }, scope);
      })
      .catch(() => {
        // The chunk did not arrive. Everything this hook animates is already in its final position in
        // the HTML, so the section is complete without it and there is nothing to tell the reader.
      });

    return () => {
      cancelled = true;
      // `revert()` rather than `kill()`: it kills the tweens AND the ScrollTriggers AND puts back
      // every inline style GSAP wrote. `kill()` would stop the animation and leave the element frozen
      // at whatever mid-scrub transform it happened to be holding.
      context?.revert();
      context = null;
    };
    // `build` is intentionally absent — see `buildRef` above; a new function identity every render
    // would rebuild every trigger on every state change in the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce, ...deps]);

  return scopeRef;
}
