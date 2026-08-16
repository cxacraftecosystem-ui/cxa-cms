"use client";

/**
 * CineBubbles — a row of word chips that BOUNCE into their seats and take a sweep of light as they
 * land, driven by where the reader has scrolled to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * Two sets of words in the cinematic story are lists of nouns rather than sentences — the four verbs
 * of transmission ("Learned. Practised. Adapted. Preserved.") and the eight research themes. Read as
 * static pills they are a legend; arriving one after another with a springy overshoot and a shimmer
 * they read as things being SET DOWN, which is what the copy around them is describing. The owner
 * asked for exactly that, in both scroll directions.
 *
 * HOW BOTH DIRECTIONS ARE GOT FOR FREE: `whileInView` with `once: false`. framer returns the group
 * to its `hidden` variant when it leaves the viewport and plays it forward again on the way back, so
 * scrolling up genuinely unseats the chips (in reverse order — `staggerDirection: -1` on the hidden
 * state) rather than leaving a row of already-arrived pills the reader has no reason to look at
 * twice. There is no scroll listener here and no second instrument: one IntersectionObserver per
 * group, which framer owns and cleans up.
 *
 * ⚠ THE SHIMMER IS A TRANSLATED CHILD INSIDE AN `overflow-hidden` CHIP, never an animated
 * `background-position`. The gradient sweep is one element moving on the compositor; the
 * background-position version of the same effect is a main-thread repaint of every chip on every
 * frame, which is the exact defect tailwind.config.ts's `keyframes` note records having removed from
 * the loading skeletons. It is also `aria-hidden` and rendered ONLY when motion is allowed.
 *
 * ⚠ WHAT REDUCED MOTION GETS: a plain fade, at zero duration, with no displacement, no overshoot and
 * no shimmer element in the DOM at all. The `hidden` state keeps `opacity: 0` in BOTH branches —
 * variants.ts's dialect, and the rule that keeps the first paint identical to the server's.
 *
 * ⚠ AND THE READER WHOSE JAVASCRIPT NEVER ARRIVES: framer writes the `hidden` state into the SSR
 * markup as inline styles, so every chip would be invisible for ever. The rescue is the `<noscript>`
 * block in CinematicScroll.tsx, which keys on `data-cine-bubble`. It deliberately does NOT clear the
 * sheen — that element is left at its own inline `opacity: 0`, or the rescue would paint a bright
 * gradient bar across every chip on precisely the pages it exists to save.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { motion, type Variants } from "framer-motion";

import { DURATION, EASE_OUT, STAGGER } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

/**
 * THE OVERSHOOT, AND WHY IT IS A CURVE RATHER THAN ONE OF THE HOUSE SPRINGS.
 *
 * ⚠ There is no bouncy spring in components/motion/constants.ts to reach for. Every entry in that
 * table is critically damped or beyond it — the least damped is SPRING_PRESS at ζ ≈ 0.92
 * (30 ÷ 2√(380 × 0.7)), whose theoretical overshoot is under a thousandth of the travel: on a chip
 * scaling 0.72 → 1 that is a fifth of a pixel, which is to say none. The file says so itself in its
 * opening paragraph: these springs are a feel, and that feel is "arrives without a visible bounce".
 *
 * So the bounce comes from the house's OTHER settled bounce value — `transitionTimingFunction.spring`
 * in tailwind.config.ts, `cubic-bezier(0.34, 1.56, 0.64, 1)`, which every `ease-spring` class in the
 * product already uses. It is restated here as a tuple because a JS animation cannot name a CSS
 * timing function, exactly as `EASE_OUT` restates the `ease-out` class. If a genuinely under-damped
 * spring is ever added to constants.ts, this is the one call site to move over.
 */
const SEAT_BOUNCE = [0.34, 1.56, 0.64, 1] as const;

/** How far the sheen travels, as a proportion of the chip's own width. Past ±100% it is fully
 *  outside the clip on both sides, so neither end of the sweep is ever seen parked. */
const SHEEN_TRAVEL = "130%";

function groupVariants(reduce: boolean, stagger: number): Variants {
  return {
    // The reverse: the chips leave from the END of the row backwards, so scrolling up looks like the
    // row being picked up rather than like the arrival played at random.
    hidden: {
      transition: { staggerChildren: reduce ? 0 : stagger, staggerDirection: -1 }
    },
    seated: {
      transition: { staggerChildren: reduce ? 0 : stagger }
    }
  };
}

/**
 * ⚠ THE DISPLACEMENT IS BIG ENOUGH TO SEE THE OVERSHOOT ON. A 0.28 scale delta under the curve above
 * peaks at about 1.025 and 16px of rise peaks about 1.4px past the seat — small numbers, but they
 * are what separates "the chip sprang into place" from "the chip faded in", and on a chip 30px tall
 * a larger travel would read as a bounce for its own sake.
 */
function bubbleVariants(reduce: boolean): Variants {
  return {
    hidden: { opacity: 0, y: reduce ? 0 : 16, scale: reduce ? 1 : 0.72 },
    seated: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: reduce ? { duration: 0 } : { duration: DURATION.rise, ease: SEAT_BOUNCE }
    }
  };
}

/**
 * The sweep of light. It starts and ends outside the chip, and its opacity is keyframed so the light
 * arrives and leaves rather than sliding in from the edge of the frame.
 *
 * `ease: "linear"` on the travel, deliberately: light crossing a surface has no reason to
 * decelerate, and an eased sweep reads as a smear.
 */
const SHEEN: Variants = {
  hidden: { x: `-${SHEEN_TRAVEL}`, opacity: 0 },
  seated: {
    x: SHEEN_TRAVEL,
    opacity: [0, 1, 0],
    transition: {
      // ⚠ THE DELAY IS STATED INSIDE EACH VALUE'S OWN TRANSITION, NOT ONCE AT THE TOP. A per-value
      // transition REPLACES the parent's settings for that value rather than extending them, so a
      // lone top-level `delay` beside these two would be read by neither. The beat is what makes the
      // light catch the chip as it SEATS rather than while it is still travelling.
      x: { duration: 0.7, delay: 0.12, ease: "linear" },
      opacity: { duration: 0.7, delay: 0.12, times: [0, 0.4, 1], ease: EASE_OUT }
    }
  }
};

export interface CineBubblesProps {
  /** The words, in the order they should land. */
  words: readonly string[];
  /**
   * The chip's complete class string, handed down from the section so both call sites keep their own
   * appearance (the research themes carry hover colours the transmission verbs do not). A complete
   * literal from the caller — never assembled here (contract §5).
   */
  chipClassName: string;
  /**
   * The interval between arrivals. Pick from `STAGGER` by the DENSITY of the row: eight themes at
   * `loose` would take the last chip two-thirds of a second longer than the first.
   */
  stagger?: number;
  /** Spacing from whatever sits above. The row's own flex layout is fixed here. */
  className?: string;
}

export function CineBubbles({
  words,
  chipClassName,
  stagger = STAGGER.default,
  className
}: CineBubblesProps) {
  const reduce = useReducedMotionPreference();

  return (
    <motion.div
      variants={groupVariants(reduce, stagger)}
      initial="hidden"
      whileInView="seated"
      // `once: false` is what makes this reversible at all. 0.6 rather than the house 0.3, because
      // the row is short and shallow: at 0.3 a group two lines tall re-fires while the reader is
      // still looking at it.
      viewport={{ once: false, amount: 0.6 }}
      className={cn("flex flex-wrap items-center justify-center gap-2.5", className)}
    >
      {words.map((word) => (
        <motion.span
          key={word}
          // What the `<noscript>` rescue in CinematicScroll.tsx keys on. See this file's header.
          data-cine-bubble=""
          variants={bubbleVariants(reduce)}
          // The clip for the sheen, at the chip's own radius. `inline-flex` so the wrapper is exactly
          // the size of the chip inside it and the sweep has no margin to cross.
          className="relative inline-flex overflow-hidden rounded-full"
        >
          <span className={chipClassName}>{word}</span>

          {reduce ? null : (
            <motion.span
              aria-hidden="true"
              data-cine-sheen=""
              variants={SHEEN}
              className="pointer-events-none absolute inset-0"
              // A gradient rather than a Tailwind utility: the angle and the three stops are one
              // decision, and the arbitrary-value spelling of it is unreadable. The white is low
              // enough to pass over `text-white/85` type without washing it out.
              style={{
                background:
                  "linear-gradient(100deg, transparent 32%, rgba(255,255,255,0.42) 50%, transparent 68%)"
              }}
            />
          )}
        </motion.span>
      ))}
    </motion.div>
  );
}
