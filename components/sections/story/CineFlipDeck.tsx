"use client";

/**
 * CineFlipDeck — several statements, ONE seat, flipped through by the reader's own scroll.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT EXISTS. Movement III of the cinematic story asks three "what if" questions, and printed as
 * three stacked paragraphs with the movement's own `gap-14 md:gap-20` between them they cost about
 * 400 vertical pixels to say one thought — the owner's note was that they take up a great deal of
 * room without earning it. Here they share a single seat about 130px tall and the reader turns them
 * over by scrolling: a card flip about the horizontal axis, the way a departure board or a hand
 * turning a letter over does it. Scrolling DOWN advances, scrolling back UP reverses, because the
 * seat is derived from the deck's own scroll progress rather than from a timer — there is no "play"
 * to be out of step with the reader.
 *
 * WHAT ANIMATES, AND WHAT DOES NOT. `rotateX` and `opacity`, on three absolutely-seated panels, and
 * nothing else — no height, no layout, so the flip cannot reflow the movement around it. The seat
 * reserves its own box with `min-h-*` (see `SEAT_CLASS`), so the page never resizes as the deck
 * turns over.
 *
 * ⚠ EVERY LINE IS IN THE DOM AT ALL TIMES AND THAT IS THE ACCESSIBILITY ANSWER, not an oversight.
 * A panel that is not on the front face is transparent and rotated, never unmounted and never
 * `aria-hidden`, so a screen reader reads all three questions in their written order exactly as it
 * would have read three paragraphs. Nothing is announced twice and there is emphatically no
 * `aria-live` here: the deck says nothing the reader did not just scroll to.
 *
 * ⚠ THE REDUCED-MOTION BRANCH IS THE OLD STACKED LAYOUT, deliberately, rather than a fade between
 * seats. A reader who has asked for less motion must still be able to read all three lines, and the
 * honest way to show three sentences without moving anything is to print all three. It costs that
 * reader the vertical space the deck was built to save, which is the correct trade.
 *
 * ⚠ AND THE READER WHOSE JAVASCRIPT NEVER ARRIVES. framer serialises each panel's `initial` into the
 * SSR markup as inline styles, so with scripts off two of the three questions would be `opacity: 0`
 * on top of the third for ever. The rescue is the `<noscript>` block in CinematicScroll.tsx, which
 * keys on `data-cine-flip` and un-stacks the deck back into ordinary flow — the same mechanism, and
 * the same `!important` reasoning, as the masked words beside it. If you rename these attributes,
 * rename them there too; that is the whole contract between the two files.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useRef, useState } from "react";
import { motion, useMotionValueEvent, useScroll, type Variants } from "framer-motion";

import { DURATION, EASE_OUT, SPRING_ISLAND } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

/**
 * Where in the deck's travel through the viewport the flips happen.
 *
 * `useScroll` with the default `["start end", "end start"]` offsets reports 0 when the seat's top
 * touches the bottom of the window and 1 when its bottom leaves the top — roughly one viewport
 * height of scrolling for a seat this short. The first and last fifth of that travel are spent with
 * the deck at the very edge of the screen, where a reader is not reading it, so the three seats are
 * shared out across the MIDDLE of the journey: line one holds while the deck rises into the frame,
 * line three holds while it leaves. On a 900px window that is roughly 180px of scroll per question.
 */
const BAND_START = 0.24;
const BAND_END = 0.84;

/**
 * ⚠ THE DEAD BAND AROUND EACH BOUNDARY, AND IT IS NOT OPTIONAL. A reader resting with a trackpad
 * exactly on a threshold gets a sub-pixel scroll oscillation for free, and without this the deck
 * re-fires its spring both ways several times a second — which reads as a fault rather than as
 * motion. 0.015 of the travel is about 13px of scroll on a 900px window: far more than the jitter,
 * far less than a deliberate flick.
 */
const GUARD = 0.015;

/**
 * The seat the deck should be showing at `progress`, given where it already is.
 *
 * Written as two `while` loops rather than one `Math.floor`, because it must be correct for a JUMP
 * as well as for a scroll: an in-page anchor can move the progress by half the travel between two
 * events, and a one-step-per-event advance would leave the deck a line behind until the reader
 * nudged it. The loops converge on the right seat in a single call, in either direction.
 */
function seatFor(progress: number, current: number, count: number): number {
  if (count <= 1) return 0;
  const step = (BAND_END - BAND_START) / count;
  let seat = Math.min(Math.max(current, 0), count - 1);
  while (seat < count - 1 && progress > BAND_START + step * (seat + 1) + GUARD) seat += 1;
  while (seat > 0 && progress < BAND_START + step * seat - GUARD) seat -= 1;
  return seat;
}

/**
 * The three faces of a panel.
 *
 * ⚠ 92°, NOT 90°. At exactly a quarter turn the panel is edge-on to the camera, and a browser that
 * rounds the projection the other way leaves a one-pixel bright rule across the seat — the tell that
 * gives away a flip built out of rectangles. Two degrees past the edge costs nothing and cannot
 * render. The sign is the direction of travel: a question not yet read waits BELOW the axis and
 * comes up into the light; one already read carries on UP and away, so the deck turns one way with
 * the reader's descent and the other way when they climb back.
 */
const FACE: Variants = {
  waiting: { rotateX: -92, opacity: 0 },
  front: { rotateX: 0, opacity: 1 },
  spent: { rotateX: 92, opacity: 0 }
};

/**
 * Complete literal class strings, chosen by branch rather than assembled — `cn()` is a plain join,
 * so `flex` and `relative` in one string would be settled by CSS source order rather than by intent
 * (contract §5).
 */
const WRAP_CLASS = {
  /** Reduced motion: the movement's own stacked layout, which is what this replaced. */
  stacked: "flex flex-col items-center gap-8",
  deck: "relative w-full"
} as const;

/**
 * The seat's reserved box.
 *
 * ⚠ SIZED FOR FOUR LINES OF THE LONGEST QUESTION, not for three. The panels are absolutely
 * positioned, so anything taller than the seat overhangs it — and the site's own larger-text
 * preference (`data-larger-text` on `<html>`) is exactly the setting that turns a three-line
 * question into a four-line one. At `text-lg`/`leading-relaxed` four lines is about 7.3rem, so 8rem
 * holds them with a little in hand and the movement's `gap-14` absorbs the rest.
 *
 * `perspective` on the SEAT rather than on each panel, so all three turn about the same camera —
 * per-panel perspective gives each card its own vanishing point and the deck stops reading as one
 * object.
 */
const SEAT_CLASS =
  "relative mx-auto min-h-[8rem] w-full [perspective:1000px] sm:min-h-[7.5rem]";

/** The statement's own type, unchanged from the three paragraphs this replaced. */
const LINE_CLASS = "mx-auto max-w-[40ch] text-lg leading-relaxed text-white/70 sm:text-xl";

export interface CineFlipDeckProps {
  /** The statements, in reading order. Every one of them is rendered, always. */
  lines: readonly string[];
  className?: string;
}

export function CineFlipDeck({ lines, className }: CineFlipDeckProps) {
  const reduce = useReducedMotionPreference();
  const seatRef = useRef<HTMLDivElement>(null);

  /*
   * ⚠ THE REF IS ON THE OUTER ELEMENT IN BOTH BRANCHES, and the outer element is a `<div>` in both.
   * `reduce` resolves AFTER mount, so returning a different element type per branch would unmount
   * and remount the whole subtree on the first render of every page load — the trap PointerDrift's
   * header sets out at length. Only the children swap here, so React keeps the div and `useScroll`
   * keeps its target.
   */
  const { scrollYProgress } = useScroll({ target: seatRef, offset: ["start end", "end start"] });
  const [seat, setSeat] = useState(0);

  /*
   * ⚠ THIS RUNS ON EVERY SCROLLED FRAME AND RE-RENDERS ON ALMOST NONE OF THEM. `setSeat` is given a
   * function that returns the CURRENT value whenever the seat has not changed, and React bails out
   * of the render when a state update produces the identical value — so the cost of the subscription
   * is the arithmetic in `seatFor` and nothing else. Passing a computed number instead
   * (`setSeat(seatFor(progress, seat, …))`) would work but would close over a stale `seat`.
   */
  useMotionValueEvent(scrollYProgress, "change", (progress) => {
    setSeat((current) => seatFor(progress, current, lines.length));
  });

  return (
    <div ref={seatRef} className={cn(WRAP_CLASS[reduce ? "stacked" : "deck"], className)}>
      {reduce ? (
        lines.map((line) => (
          <p key={line} className={LINE_CLASS}>
            {line}
          </p>
        ))
      ) : (
        <>
          <div className={SEAT_CLASS}>
            {lines.map((line, index) => (
              <motion.p
                key={line}
                // What the `<noscript>` rescue in CinematicScroll.tsx keys on. See this file's header.
                data-cine-flip=""
                className={cn(LINE_CLASS, "absolute inset-x-0 top-0 [backface-visibility:hidden]")}
                /*
                 * `initial` is stated rather than left to default to `animate`, because it is what
                 * framer writes into the SERVER-rendered markup: the first question arrives on the
                 * front face and the other two arrive already turned away, so the deck's very first
                 * paint is a finished composition and nothing animates on mount. Both branches of
                 * this expression are decided by the index alone — never by anything the server
                 * cannot know.
                 */
                initial={index === 0 ? "front" : "waiting"}
                animate={index === seat ? "front" : index < seat ? "spent" : "waiting"}
                variants={FACE}
                /*
                 * The turn is SPRING_ISLAND — the house's firm, no-visible-bounce spring, which is
                 * what a card landing flat on its face should feel like; a card that wobbled on
                 * arrival would read as paper rather than as type. Opacity is a plain tween on its
                 * own clock, because a spring on opacity spends its settle time invisible and the
                 * fade should be over well before the rotation is.
                 */
                transition={{
                  ...SPRING_ISLAND,
                  opacity: { duration: DURATION.swapIn, ease: EASE_OUT }
                }}
              >
                {line}
              </motion.p>
            ))}
          </div>

          {/* Where the reader is in the deck. Decoration — the questions themselves are the content
              and all three are in the DOM — so it is out of the accessibility tree, and the
              `<noscript>` rescue hides it outright: with the deck un-stacked there is no "current"
              seat for it to be honest about. */}
          <div
            aria-hidden="true"
            data-cine-flip-dots=""
            className="mt-6 flex items-center justify-center gap-2"
          >
            {lines.map((line, index) => (
              <span
                key={line}
                className={cn(
                  "block h-1.5 w-1.5 rounded-full transition-colors duration-300 ease-out",
                  index === seat ? "bg-gold-300" : "bg-white/20"
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
