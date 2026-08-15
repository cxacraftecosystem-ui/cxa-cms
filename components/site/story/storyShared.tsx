"use client";

/**
 * Shared vocabulary for the cinematic story — one hand, fifteen scenes.
 *
 * Every scene in StoryScenesA/B pulls its stage, its phrase timing and its type treatments from
 * here, so the whole story reads as a single telling rather than fifteen separately-animated
 * slides. The model is ChartMate's `introShared` (the acknowledged inspiration for this feature),
 * rebuilt on THIS repo's motion vocabulary: the easing is `EASE_OUT` from
 * `components/motion/constants` — never a locally-invented curve (contract §8) — and every variant
 * factory takes `reduce` and collapses displacement to zero while keeping the opacity change, the
 * exact rule `components/motion/variants.ts` documents.
 *
 * ⚠ WHY THE FACTORIES HERE ARE LOCAL RATHER THAN IMPORTS OF `riseItem` ET AL. The house factories
 * speak `hidden`/`visible`, which is right for `whileInView` reveals that fire once. A cinematic
 * scene is choreographed on a CLOCK: each phrase carries its own absolute delay measured from the
 * scene's start, and `riseItem` has nowhere to put one. The shapes and durations are the house
 * ones; only the delay parameter is new. Timing lives in the variant rather than in a
 * `staggerChildren` because a scene's phrases are not evenly staggered — the script calls for a
 * beat of thought between statements, and those beats are the choreography.
 *
 * ⚠ NOTHING HERE ANIMATES `filter`. ChartMate's scene exits blur; on a full-viewport surface that
 * is a repaint of the whole screen every frame, and this repo's variants speak opacity and
 * transform only. The scene swap in CinematicStory fades and settles scale instead.
 *
 * Deterministic on purpose — no `Math.random`, no `Date.now` in render — so nothing here can
 * disagree with itself between two renders of the same scene.
 */

import { motion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

import { EASE_OUT } from "@/components/motion/constants";
import { cn } from "@/lib/utils";

/** Re-exported so the scenes never import a curve from anywhere else. */
export const EASE = EASE_OUT;

/**
 * THE CINEMATIC'S AMBIENT TIER — the four durations its ornament layers move on, named here so no
 * scene invents a number at a call site. They are deliberately LONGER than the UI durations in
 * constants.ts: those time interface responses (a press, a reveal, a swap), while these time
 * weather — a constellation drifting apart, a ring assembling, nine words travelling home, the
 * glow crossing the stage between scenes. The same reasoning already holds elsewhere in the repo:
 * the narrative blocks' scroll scrubs are not on the UI clock either. Every user of one of these
 * is `aria-hidden` ornament, and every one collapses under reduced motion at its call site.
 */
export const AMBIENT = {
  /** The fragments constellation's slow outward drift. */
  drift: 1.4,
  /** One ecosystem chip travelling from the centre to its seat. */
  ringArrive: 0.9,
  /** A converging word's whole journey home. */
  converge: 3.2,
  /** The ambient glow re-seating itself for a new scene. */
  glow: 1.6
} as const;

/**
 * A phrase arriving on the scene's clock: rises 22px and fades in over 0.62s — the GSAP-words
 * duration from contract §8, which is the cadence the homepage headline already taught the reader.
 * `delay` is seconds from the scene's mount.
 *
 * ⚠ UNDER REDUCED MOTION THE DURATION COLLAPSES TO ZERO — the letter of variants.ts — BUT THE
 * DELAY IS KEPT. The delays are the script's beats ("Then… And finally…"), which are pacing of
 * CONTENT, not motion: zeroing them would dump a scene's whole argument in one frame and lose the
 * reading order the copy depends on. So a reduced-motion reader gets the same beats as everyone,
 * with each phrase simply appearing in place.
 */
export function phrase(reduce: boolean, delay: number, distance = 22): Variants {
  return {
    hidden: { opacity: 0, y: reduce ? 0 : distance },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: reduce ? 0 : 0.62, ease: EASE, delay }
    }
  };
}

/** A quiet arrival for supporting copy — opacity only, already in place. Same reduced-motion
 *  contract as `phrase`: zero duration, kept beat. */
export function quiet(reduce: boolean, delay: number): Variants {
  return {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { duration: reduce ? 0 : 0.5, ease: EASE, delay }
    }
  };
}

/**
 * The full-viewport stage every scene renders into.
 *
 * ⚠ CENTRED WITH `m-auto` ON AN INNER COLUMN, NOT `justify-center` ON THE STAGE. The overlay locks
 * the page scroller, so a scene taller than a short viewport (a landscape phone under the enables
 * or audiences grid) has nowhere to overflow to — and `justify-center` on a scrollable flex column
 * clips the TOP half of oversized content beyond reach, which is the classic unreachable-header
 * bug. Auto margins centre exactly when the content fits and yield to ordinary scrolling exactly
 * when it does not.
 */
export function Stage({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col overflow-y-auto overscroll-contain">
      <div
        className={cn(
          "m-auto flex w-full flex-col items-center px-6 py-10 text-center sm:px-10",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The big statement — the script's ALL-CAPS lines. The capitals are a TYPE TREATMENT, applied here
 * with `uppercase`, never typed into the copy: a screen reader spells out literal capitals it takes
 * for an initialism, and the studio should hold prose, not shouting.
 */
export function BigLine({
  className,
  children,
  as: Tag = "p"
}: {
  className?: string;
  children: ReactNode;
  as?: "p" | "h2";
}) {
  return (
    <Tag
      className={cn(
        "font-display text-3xl font-extrabold uppercase leading-[1.12] tracking-[0.02em] text-white sm:text-4xl md:text-5xl",
        className
      )}
    >
      {children}
    </Tag>
  );
}

/** Supporting copy under a big line. Sentence case, quiet, measured. */
export function SupportLine({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        "mx-auto max-w-[46ch] text-base leading-relaxed text-white/75 sm:text-lg",
        className
      )}
    >
      {children}
    </p>
  );
}

/** The small gold kicker — the story's own eyebrow, set like the hero's. */
export function Kicker({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        "text-xs font-semibold uppercase tracking-[0.24em] text-gold-300",
        className
      )}
    >
      {children}
    </p>
  );
}

/**
 * A word chip — the ecosystem members, the research themes, the four verbs of transmission. One
 * shape for all of them so a chip anywhere in the story is recognisably the same object.
 */
export function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-white/85",
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * A connective arrow between the words of a sequence — ARTISAN ↓ CRAFT ↓ KNOWLEDGE. Drawn, not
 * typed: the script's "↓" is layout, and a screen reader has no business announcing "downwards
 * arrow" five times inside one thought.
 */
export function FlowArrow({ reduce, delay }: { reduce: boolean; delay: number }) {
  return (
    <motion.span
      aria-hidden="true"
      variants={quiet(reduce, delay)}
      initial="hidden"
      animate="visible"
      className="my-1 block h-5 w-px bg-gradient-to-b from-white/40 to-white/10"
    />
  );
}
