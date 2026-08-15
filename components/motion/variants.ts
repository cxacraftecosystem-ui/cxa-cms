/**
 * The motion vocabulary, part two: THE SHAPES.
 *
 * Every factory here takes `reduce` as its first argument and collapses to zero duration AND zero
 * displacement when it is true. Gating at the source is the entire point: CSS cannot reach
 * framer-motion, which writes inline styles, so a framer animation with no JS branch still moves for
 * a reader who asked it not to (contract §1.3). Because the branch lives in the factory rather than
 * at the call site, an animation written with this vocabulary CANNOT ship without honouring the
 * preference — there is nowhere left to forget it.
 *
 * ⚠ `opacity: 0` is in the hidden state of BOTH branches, deliberately. Reduction collapses the
 * DISPLACEMENT, never the visibility: an element that is invisible either way cannot flash when the
 * preference resolves after hydration, whereas an `initial` that switches between "invisible" and
 * "visible" absolutely will on a prerendered page (see useReducedMotionPreference.ts).
 *
 * The variant names are `hidden`, `visible` and — where there is an exit — `exit`, uniformly. A
 * parent's `visible` propagates to children of the same name, so a `staggerParent` only orchestrates
 * children that speak the same three words.
 *
 * Distances are in pixels and are parameters, not doctrine; the springs, curves, durations and
 * stagger intervals all come from constants.ts and none of them may be invented locally.
 */

import type { TargetAndTransition, Transition, Variants } from "framer-motion";

import { DURATION, EASE_OUT, SPRING_POPOVER, SPRING_PRESS, STAGGER } from "@/components/motion/constants";

/** How far a swapping readout travels. Small enough that a number replacing a number reads as one
 *  object changing rather than two objects trading places. */
const SWAP_SHIFT = 6;

/**
 * A parent that releases its children one after another.
 *
 * Under reduction the interval goes to zero rather than shrinking. A stagger that survives a
 * zero-duration child is not "no motion" — it is a staggered POP, which is louder than the animation
 * it replaced. (Same reason globals.css zeroes `transition-delay` alongside the duration.)
 */
export function staggerParent(reduce: boolean, stagger: number = STAGGER.default): Variants {
  return {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: reduce ? 0 : stagger,
        // Stated rather than left to default, so the zeroing above is visibly complete: no interval
        // and no head start.
        delayChildren: 0
      }
    }
  };
}

/** The standard item: rises and fades. Pairs with `staggerParent` or stands alone. */
export function riseItem(reduce: boolean, distance = 24): Variants {
  return {
    hidden: { opacity: 0, y: reduce ? 0 : distance },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: reduce ? 0 : DURATION.rise, ease: EASE_OUT }
    }
  };
}

/**
 * The horizontal item: slides in from the trailing edge.
 *
 * A negative `distance` slides from the left, which is what a right-hand column wants — the two
 * directions share one factory so the durations cannot drift apart.
 */
export function slideItem(reduce: boolean, distance = 32): Variants {
  return {
    hidden: { opacity: 0, x: reduce ? 0 : distance },
    visible: {
      opacity: 1,
      x: 0,
      transition: { duration: reduce ? 0 : DURATION.slide, ease: EASE_OUT }
    }
  };
}

/** Opacity only. For anything already in its final position — a caption, an overlay, a backdrop. */
export function fadeItem(reduce: boolean): Variants {
  return {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { duration: reduce ? 0 : DURATION.page, ease: EASE_OUT }
    }
  };
}

/**
 * One readout replacing another inside `AnimatePresence` — a filter count, a tab panel, a stat that
 * changes when the year changes.
 *
 * In and out are asymmetric (0.28 / 0.16) because the departing value should clear the way faster
 * than the arriving one takes to settle; equal timings look like a collision. The new value enters
 * from below and the old leaves upward, so the pair reads as a single dial turning.
 */
export function swapVariants(reduce: boolean): Variants {
  return {
    hidden: { opacity: 0, y: reduce ? 0 : SWAP_SHIFT },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: reduce ? 0 : DURATION.swapIn, ease: EASE_OUT }
    },
    exit: {
      opacity: 0,
      y: reduce ? 0 : -SWAP_SHIFT,
      transition: { duration: reduce ? 0 : DURATION.swapOut, ease: EASE_OUT }
    }
  };
}

/**
 * Popovers, menus and dialog cards: a small scale-up on a stiff spring.
 *
 * Scale collapses to 1 under reduction rather than to a smaller number — a "gentler" zoom is still a
 * zoom, and scale is the transform that most reliably provokes motion sickness.
 */
export function scaleIn(reduce: boolean, from = 0.96): Variants {
  return {
    hidden: { opacity: 0, scale: reduce ? 1 : from },
    visible: {
      opacity: 1,
      scale: 1,
      transition: reduce ? { duration: 0 } : SPRING_POPOVER
    }
  };
}

/** What `press()` returns: spread it straight onto a motion element. */
export interface PressMotion {
  whileHover?: TargetAndTransition;
  whileTap?: TargetAndTransition;
  transition?: Transition;
}

/**
 * The house press/hover response, as a spreadable pair: `<motion.button {...press(reduce)}>`.
 *
 * Under reduction it returns an EMPTY object — no lift, no squash, nothing framer can write. The
 * control is not left without feedback, because its own CSS `:hover`/`:focus-visible` styling is a
 * static state and survives (contract §1.4: a signal that exists only as motion is a signal a
 * reduced-motion reader never gets, so the colour and ring changes are the real affordance and this
 * is the garnish).
 */
export function press(reduce: boolean, lift = 2): PressMotion {
  if (reduce) return {};
  return {
    whileHover: { y: -lift, scale: 1.01 },
    // Returns to y: 0 on press so the button appears to be pushed back down under the finger.
    whileTap: { y: 0, scale: 0.985 },
    transition: SPRING_PRESS
  };
}
