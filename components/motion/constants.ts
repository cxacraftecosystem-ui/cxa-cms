/**
 * The motion vocabulary, part one: THE NUMBERS.
 *
 * Every spring, curve, duration and stagger this product is allowed to use is in this file, and the
 * values are the ones fixed by the build contract §8. They are not per-component defaults to be
 * tuned: a spring is a *feel*, and a header that settles at 260/30 next to a sheet that settles at
 * 240/28 reads as two products built by two people. If no entry below matches the job, the answer is
 * that the interaction should be made to feel like one of these — not that it needs a spring of its
 * own.
 *
 * Each constant is written `as const satisfies Transition` rather than annotated `: Transition`.
 * `satisfies` type-checks the object against framer's shape WITHOUT widening it, which matters twice
 * over: the literal numbers stay visible in the type (so a hover in the editor shows 260/30, not
 * `number`), and the object is still narrow enough for the call sites that want framer's much smaller
 * `SpringOptions` — `useSpring(source, SPRING_SCROLL)` — rather than the whole `Transition` union.
 *
 * Nothing here animates anything. Everything here is a value some other file hands to framer.
 */

import type { Transition } from "framer-motion";

/** Header layout shifts and the mobile navigation sheet. Firm, arrives without a visible bounce. */
export const SPRING_ISLAND = {
  type: "spring",
  stiffness: 260,
  damping: 30
} as const satisfies Transition;

/**
 * Every press and hover response in the product, without exception.
 *
 * The lightest mass in the set, because a control that trails the finger by even 60ms stops reading
 * as "smooth" and starts reading as "slow".
 */
export const SPRING_PRESS = {
  type: "spring",
  stiffness: 380,
  damping: 30,
  mass: 0.7
} as const satisfies Transition;

/** Layout changes and accordion height. Heavier than ISLAND so a growing panel unfolds, not snaps. */
export const SPRING_LAYOUT = {
  type: "spring",
  stiffness: 260,
  damping: 32,
  mass: 0.9
} as const satisfies Transition;

/**
 * Scroll-linked spines and progress fills.
 *
 * Soft and low-mass on purpose: this spring is smoothing a value the reader is already driving with
 * their own hand, so it must lag just enough to look liquid and never enough to feel disconnected.
 */
export const SPRING_SCROLL = {
  type: "spring",
  stiffness: 140,
  damping: 30,
  mass: 0.4
} as const satisfies Transition;

/** The hero's pointer wash. The slowest in the set — the light should follow the cursor, not track it. */
export const SPRING_POINTER = {
  type: "spring",
  stiffness: 110,
  damping: 24,
  mass: 0.6
} as const satisfies Transition;

/** Popovers. Very stiff: a menu that eases open is a menu you have to wait for. */
export const SPRING_POPOVER = {
  type: "spring",
  stiffness: 520,
  damping: 38,
  mass: 0.6
} as const satisfies Transition;

/** Toasts, entering and leaving the viewport corner. */
export const SPRING_TOAST = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.7
} as const satisfies Transition;

/**
 * The house curve — the same cubic as the `ease-out` CLASS in tailwind.config.ts,
 * `cubic-bezier(0.16, 1, 0.3, 1)`.
 *
 * ⚠ It is NOT the CSS keyword `ease-out`. Handwritten CSS that says `ease-out` gets the spec curve,
 * which is a different and much lazier curve spelled identically (contract §4). This tuple is how a
 * JS animation reaches the brand curve at all.
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/**
 * Durations, in SECONDS, because that is framer's unit. (CSS wants milliseconds; the two are easy to
 * transpose and 0.22 as a CSS value is an animation nobody can see.)
 *
 * The keys name the JOB rather than the number, so a call site reads as intent. Reduced motion
 * collapses these to zero in `variants.ts` — it never picks a smaller one from this map, because
 * "faster" is still motion.
 */
export const DURATION = {
  /** Scrims and bare opacity changes. */
  scrim: 0.18,
  /** Width changes and the page-level fade. */
  page: 0.22,
  /** A readout being replaced by a different readout: in… */
  swapIn: 0.28,
  /** …and out. Asymmetric on purpose — the old value should clear the way faster than the new one arrives. */
  swapOut: 0.16,
  /** A panel or drawer sliding in. */
  slide: 0.4,
  /** The standard below-the-fold rise-and-fade. */
  rise: 0.5,
  /** The homepage headline's per-word reveal (GSAP owns that one animation, contract §8). */
  words: 0.62
} as const;

/**
 * Stagger intervals, in seconds, for `staggerChildren`.
 *
 * Pick by list DENSITY, not by taste: the interval times the item count is how long the last item
 * waits, and 24 rows at 0.08 means the bottom of the grid arrives a full two seconds late.
 */
export const STAGGER = {
  /** Two or three large items — a hero's supporting lines. */
  loose: 0.08,
  /** The default for anything that does not have a reason to differ. */
  default: 0.06,
  /** Card grids of roughly six to nine. */
  cards: 0.05,
  /** Larger grids, twelve or so. */
  grid: 0.045,
  /** Compact groups where the sweep should read as one gesture. */
  tight: 0.04,
  /** Table and list rows. */
  rows: 0.035,
  /** Long lists — anything past about twenty items. */
  dense: 0.025
} as const;
