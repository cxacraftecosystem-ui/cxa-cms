"use client";

/**
 * ScrollCue — the small "there is more below" mark at the foot of the hero.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS A THREAD, NOT A BUTTON, AND THE DIFFERENCE IS THE WHOLE POINT OF THE MARK.
 *
 * This was a 44px circle with a chevron in it: the universal shape of a control, drawn at the size of a
 * control, on a surface where nothing is clickable. Every reader who has used a website reads that as
 * "press me to go down", and pressing it does nothing at all, because it is `pointer-events-none`
 * ornament — a cue that lies about what it is.
 *
 * What it is now is one gold hairline descending out of the frame with the chevron travelling at its
 * foot. That says "this continues past the edge" without pretending to be pressable, and it says it in
 * the register the rest of the hero is written in: the same drawn line as the embroidered thread under
 * the headline's accent, the same weight as the eyebrow's rule, the same gold. The hero is now made of
 * one family of marks rather than of a lattice, some type, and a button-shaped thing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PURE ORNAMENT, so it is `aria-hidden` and out of the accessibility tree entirely (contract §8). A
 * screen-reader user is told the page's structure by its headings and landmarks; a decorative chevron
 * announcing "scroll" would be noise. Nothing here is the only carrier of any information: the ring
 * and the chevron are drawn in both states, and the drift is garnish on top (contract §1.4).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT MUST NOT LAND ON THE WORDS, AND A 720px WINDOW IS THE COMMON CASE
 *
 * A laptop with a browser window 720px tall is what most people actually visit from, and there the
 * hero's 88vh is barely taller than the sentence it holds. Two independent measures, because either
 * one alone has failed before:
 *
 *  1. The cue is not rendered at all below 760px of viewport HEIGHT. An arbitrary media variant
 *     rather than a breakpoint, because Tailwind's breakpoints are widths and this is a height
 *     problem — a wide, short window is exactly the case a width breakpoint gets wrong.
 *  2. Above that, HeroSection reserves the cue's height as bottom padding on the section itself, so
 *     the centred content column cannot reach down into the band the cue occupies. See the
 *     `verticalPadding` note there; the two numbers belong together and are commented in both files.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `absolute`, not `fixed`, so it needs no `--scroll-gutter` payment (contract §6) and scrolls away
 * with the hero it belongs to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT DRIFTS ONLY WHILE SOMEBODY CAN SEE IT DRIFT
 *
 * `repeat: Infinity` means exactly that, and framer runs this one on the MAIN THREAD: `y` is a
 * transform sub-value rather than `transform` itself, so it is not in framer's accelerated set, and a
 * non-zero `repeatDelay` disqualifies the WAAPI path a second time. Left ungated it is therefore a
 * 60fps JavaScript loop that never idles for the whole of a visit — on a page that is also running
 * Lenis's frame loop and ScrollTrigger's, for a 5px chevron that is off screen from the moment the
 * reader takes the invitation.
 *
 * So the cue is observed, and out of view it is pinned still at zero displacement with a zero-duration
 * transition — the same shape as the `reduce` branch, which is the point: "no motion now" has one
 * spelling in this file. Two useful consequences fall out of it rather than being arranged:
 *
 *  • The first paint is still. `useInView` reports false on the server and on the first client
 *    render, so the busiest frame of the page's life is one animation quieter, and the drift starts a
 *    tick later when the observer confirms the cue is actually on screen.
 *  • Below 760px of viewport height the wrapper is `display: none`, which never intersects — so the
 *    viewport that cannot afford the cue does not pay for its animation either.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { ChevronDown } from "lucide-react";

import { DURATION, EASE_OUT } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

export interface ScrollCueProps {
  /** Extra positioning, if a caller needs the cue somewhere other than the foot of its container. */
  className?: string;
}

/** How far the chevron drifts, in pixels. Small enough to read as a breath rather than a bounce. */
const DRIFT = 5;

export function ScrollCue({ className }: ScrollCueProps) {
  const reduce = useReducedMotionPreference();
  const hostRef = useRef<HTMLDivElement>(null);
  // `amount: "some"` — any part of the cue on screen is enough. A fraction would be the wrong question
  // for a 44px mark, and `once` is deliberately left off: the drift must stop again on the way past.
  const inView = useInView(hostRef, { amount: "some" });

  /** No motion now, for either of the two reasons there are. See the header. */
  const still = reduce || !inView;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-7 hidden justify-center [@media(min-height:760px)]:flex",
        className
      )}
    >
      <span className="flex flex-col items-center gap-2">
        {/*
          The thread itself. It starts at nothing and arrives at gold, so it reads as a line being drawn
          down the frame rather than as a divider that has been placed there — the same gradient
          hairline the hero's eyebrow uses, turned through ninety degrees.
        */}
        <span aria-hidden="true" className="h-10 w-px bg-gradient-to-b from-transparent to-gold-500/70" />

        {/*
          No `initial`, so the resting chevron is what framer writes into the prerendered markup and
          what the first client render agrees on — the same element in the same place either way, and
          `still` is true on both of those passes, so there is nothing to flash (contract §8).

          The cycle is composed from the house durations rather than from a number chosen by eye:
          0.4s down, 0.5s still, 0.4s back, 0.5s still. `repeatType: "reverse"` is what makes one
          declaration cover both directions, so the two halves cannot drift out of step.

          The still branch is a TARGET of zero rather than an absent `animate`: dropping the prop
          would abandon the chevron wherever the last frame left it, so a cue that scrolls away
          mid-drift would be found sitting 5px low the next time the reader came back up.
        */}
        <motion.span
          className="block"
          animate={{ y: still ? 0 : DRIFT }}
          transition={
            still
              ? { duration: 0 }
              : {
                  duration: DURATION.slide,
                  ease: EASE_OUT,
                  repeat: Infinity,
                  repeatType: "reverse",
                  repeatDelay: DURATION.rise
                }
          }
        >
          <ChevronDown className="h-5 w-5 text-gold-300" />
        </motion.span>
      </span>
    </div>
  );
}
