"use client";

/**
 * Reveal — the standard below-the-fold entrance, and the only one a page should reach for.
 *
 * It exists so that "this section fades up as you reach it" is one import rather than four props
 * copied between twenty files, each free to drift by 40ms. The numbers are the contract's: 0.5s on
 * the house curve, 24px of travel.
 *
 * `whileInView` rather than an `animate` driven by a hook, because framer's viewport observer already
 * handles the once/threshold bookkeeping and cleans itself up. `once` defaults to true: a section
 * that re-animates every time it re-enters the viewport turns a long page into a flicker book.
 *
 * ⚠ It writes `opacity` and `y` as inline styles, so anything inside that positions ITSELF with a
 * transform utility (`-translate-x-1/2` to centre, for instance) will lose that transform. Centre
 * children with margins (contract §8).
 *
 * Under reduction: no initial offset and no transition — the content is simply there. Note that
 * `initial` keeps `opacity: 0` in BOTH branches; only the displacement collapses, because a first
 * paint that differs between the server and the hydrated client is a flash, and the preference is
 * false on the server by construction. See useReducedMotionPreference.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND THE READER WHOSE JAVASCRIPT NEVER ARRIVES
 *
 * That shared `opacity: 0` is right for every reason above and fatal for one reader: framer writes it
 * into the SERVER-RENDERED markup as an inline style, and `whileInView` — the only thing that ever
 * clears it — needs the client bundle. With scripting off, or with the bundle blocked, a page whose
 * sections are all wrapped in a reveal is structurally complete in the DOM and visually blank. So the
 * element carries `data-reveal` and every reveal ships the `<noscript>` rescue below, exactly as
 * hero/HeroHeadline.tsx does for its words.
 *
 * ⚠ THIS RESCUE NEEDS `!important` AND HEROHEADLINE'S DELIBERATELY DOES NOT, and the difference is
 * the whole reason to read both. There the words' `opacity: 0` comes from a Tailwind CLASS, so a
 * later rule of equal specificity beats it and an important one would also override the GSAP tween.
 * Here the zero is an INLINE style, which no normal declaration can touch. Nothing is overridden by
 * force, because the contents of a `<noscript>` are only ever parsed where nothing is going to
 * animate at all.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";

import { DURATION, EASE_OUT } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

/** The elements a reveal is allowed to be. Deliberately a closed list: a reveal wrapping an
 *  interactive element would swallow it in an animated box with no semantics of its own. */
export type RevealTag =
  | "div"
  | "section"
  | "article"
  | "aside"
  | "header"
  | "footer"
  | "figure"
  | "p"
  | "ul"
  | "ol"
  | "li"
  | "span";

export interface RevealProps {
  /** The rendered element. Pick the one the document outline needs; the motion is identical. */
  as?: RevealTag;
  /** Seconds to wait after the element comes into view. Zeroed under reduced motion. */
  delay?: number;
  /** Pixels travelled upward. Zeroed under reduced motion. */
  distance?: number;
  /** Animate only the first time it enters the viewport. */
  once?: boolean;
  /**
   * How much of the element must be visible to count as "in view".
   *
   * ⚠ A VALUE A TALL ELEMENT CAN NEVER REACH IS CORRECTED AT RUNTIME — see `useAchievableAmount`.
   * You do not have to think about this; it is written down because the trap it closes was total.
   */
  amount?: number | "some" | "all";
  className?: string;
  children?: ReactNode;
}

/**
 * The largest intersection ratio an element of `elementHeight` can reach in a viewport of
 * `viewportHeight` — which is the whole of the arithmetic behind the trap below.
 *
 * An IntersectionObserver's ratio is (visible area ÷ total area). A element four viewports tall can
 * never have more than a quarter of itself on screen, so its ratio caps at 0.25 and a threshold of
 * 0.3 is simply unreachable.
 */
function maxIntersectionRatio(viewportHeight: number, elementHeight: number): number {
  if (elementHeight <= 0) return 1;
  return Math.min(1, viewportHeight / elementHeight);
}

/**
 * `amount`, corrected to something this element can actually reach.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE TRAP THIS CLOSES IS SILENT AND TOTAL, WHICH IS WHY IT IS WORTH CODE RATHER THAN A COMMENT.
 *
 * framer hands `amount` straight to an IntersectionObserver as its `threshold`. The maximum ratio an
 * element can reach is `viewportHeight / elementHeight` — so anything taller than about 3.3 viewports
 * can never satisfy the default 0.3, `whileInView` never fires, and the section keeps framer's inline
 * `opacity: 0` **for ever**. Not a late entrance: a permanently blank section, in the DOM, structurally
 * complete, on a page that otherwise works. `"all"` (threshold 1) is unreachable for anything taller
 * than the viewport at all.
 *
 * Five call sites had already been bitten and hand-guarded with `amount="some"`, each carrying its own
 * ⚠ comment naming this mechanism. That is the right fix and the wrong place for it: the sixth author
 * to write a tall section gets no warning, and the failure looks like a broken page rather than a
 * mistuned threshold.
 *
 * ⚠ THE CORRECTION IS DOWNWARD-ONLY AND FALLS BACK TO EXACTLY WHAT A HUMAN WOULD HAVE WRITTEN.
 * Where the requested amount is unreachable it becomes `"some"` — threshold 0, the value those five
 * call sites chose — so nothing that currently works changes behaviour, and the hand-written guards
 * become belt-and-braces rather than load-bearing. Changing the DEFAULT to `"some"` instead would have
 * retuned the entrance of ninety-odd call sites so that each fires as its first pixel crosses the fold,
 * before the reader can see it — wasting the entrance everywhere to guard a case five places had
 * already covered.
 *
 * MEASURED ONCE, ON MOUNT, and that is a deliberate limit rather than an oversight:
 *
 *   • One `offsetHeight` read per reveal on mount, in a single pass. An element four viewports tall is
 *     not going to become short, so there is nothing to re-measure and no `ResizeObserver` — which at
 *     twenty reveals a page would be twenty observers to save a case that cannot arise.
 *   • `opacity: 0` does not affect layout, so the height read here is the real one.
 *   • Every image on this site reserves its space before it loads (`MediaImage` sets `aspect-ratio`),
 *     so the mount-time height is representative rather than a pre-image undercount.
 *   • ⚠ WHAT IT THEREFORE DOES NOT COVER: an element that grows past 3.3 viewports AFTER mount — an
 *     accordion opening, say. If that ever matters, the answer is `amount="some"` at that call site,
 *     not a resize observer here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function useAchievableAmount(
  requested: number | "some" | "all",
  // A read-only view of the ref, because this hook has no business writing it. Typed on
  // `HTMLDivElement` to match the `Component` cast below — the only property read is `offsetHeight`,
  // which every one of `RevealTag`'s twelve elements has, so the runtime is correct whichever is used.
  ref: { readonly current: HTMLDivElement | null }
): number | "some" | "all" {
  const [amount, setAmount] = useState(requested);

  // Reset when the caller changes its mind, so a corrected value cannot outlive the prop that asked
  // for it. `requested` is the dependency; `amount` deliberately is not, or this would loop.
  useEffect(() => {
    setAmount(requested);
  }, [requested]);

  useEffect(() => {
    const element = ref.current;
    // `"some"` is threshold 0 and always reachable, so there is nothing to correct.
    if (!element || requested === "some") return;

    const wanted = requested === "all" ? 1 : requested;
    const reachable = maxIntersectionRatio(window.innerHeight, element.offsetHeight);

    // A margin, because a threshold met only exactly is a threshold met only sometimes: sub-pixel
    // layout and a scrollbar's width both move the ratio by a fraction.
    if (wanted > reachable * 0.95) setAmount("some");
  }, [requested, ref]);

  return amount;
}

export function Reveal({
  as = "div",
  delay = 0,
  distance = 24,
  once = true,
  amount = 0.3,
  className,
  children
}: RevealProps) {
  const reduce = useReducedMotionPreference();
  // `HTMLDivElement` for the same reason `Component` is cast to `typeof motion.div`: TypeScript cannot
  // check a JSX call against a union of twelve forwardRef components without collapsing every prop to
  // `never`. Nothing here depends on the element being a div.
  const ref = useRef<HTMLDivElement | null>(null);
  const achievableAmount = useAchievableAmount(amount, ref);

  // `motion` is a keyed object rather than an index signature, so this lookup is not `| undefined`
  // under noUncheckedIndexedAccess. The cast is to ONE of the components rather than the union of
  // twelve: TypeScript cannot check a JSX call against a union of forwardRef components without
  // collapsing every prop to `never`, and every tag in RevealTag accepts the props passed here.
  const Component = motion[as] as typeof motion.div;

  return (
    <Component
      ref={ref}
      // What the no-JS rescue keys on. Also stamped by hand on the hero's variant-driven elements,
      // which start invisible by the same mechanism without going through this component.
      data-reveal=""
      className={className}
      initial={{ opacity: 0, y: reduce ? 0 : distance }}
      whileInView={{ opacity: 1, y: 0 }}
      // ⚠ `achievableAmount`, NOT `amount`. framer's viewport feature restarts its observer when this
      // value changes (`InViewFeature.update()` compares `amount`, `margin` and `root`), so the
      // correction reaches a section that had not yet entered view. See `useAchievableAmount`.
      viewport={{ once, amount: achievableAmount }}
      // The delay is zeroed WITH the duration. A zero-duration animation that still honours its delay
      // is a staggered pop, not "no motion" — the same trap globals.css guards against in CSS.
      transition={reduce ? { duration: 0 } : { duration: DURATION.rise, ease: EASE_OUT, delay }}
    >
      {children}
      <RevealNoScriptRescue />
    </Component>
  );
}

/** The one declaration that can beat framer's inline `opacity: 0`. See the header. */
const RESCUE_CSS = "[data-reveal]{opacity:1!important;transform:none!important}";

/**
 * The rescue, as markup: shown to a reader whose JavaScript is not coming, invisible to everyone else.
 *
 * Rendered by every reveal rather than once per page, because there is no single mount point every
 * revealed section is guaranteed to share. The repetition is free where it matters — with scripting
 * ENABLED the parser never even reads the contents, they are inert text — and identical strings cost
 * almost nothing down the wire. Exported so the hero, whose entrance is variant-driven rather than a
 * `Reveal`, can ship the same rule from the one page where no reveal is guaranteed to appear above
 * the fold.
 *
 * ⚠ `hidden`, AND IT IS NOT DECORATION. With scripting disabled the element renders normally, and an
 * empty inline box is still a flex or grid ITEM: inside a reveal that lays its children out with
 * `gap` it would open one extra gap on precisely the pages this exists to save. `display: none`
 * removes the box entirely; a `<style>` element applies to the document either way.
 *
 * ⚠ It renders INSIDE the revealed element rather than beside it. A sibling would become an extra
 * child of whatever holds the reveal — an extra grid cell in a card grid, and a `<ul>`'s last `<li>`
 * would stop matching `:last-child` (see the `last:pb-0` rails in TimelineSection and
 * ActionStepsSection).
 */
export function RevealNoScriptRescue() {
  return (
    <noscript className="hidden">
      <style>{RESCUE_CSS}</style>
    </noscript>
  );
}
