"use client";

/**
 * ParallaxStage — the CLIENT half of the PARALLAX_BANNER block, and by some distance the smaller one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT RENDERS: ONE DIV. Not a word, not a photograph, not the scrim.
 *
 * `ParallaxBannerSection` — a Server Component — renders the band, the picture, the eyebrow, the
 * heading, the sentence and the button. This wraps that markup in the element GSAP scopes to and adds
 * ONE scrubbed tween: the photograph drifts a little more slowly than the page it is printed on.
 *
 * So the line of writing across the banner arrives in the HTML, is indexed, reads with JavaScript
 * switched off, and is never serialised into a client props payload. With no JavaScript — or under
 * reduced motion, where `useGsapScope` returns before the runtime is even imported — the band is a
 * photograph with words on it, correctly cropped and fully legible. Nothing here rescues an initial
 * state, because there is no initial state to rescue.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT TAKES A `className`, WHICH THE OTHER TWO STAGES DO NOT, AND THAT IS DELIBERATE. A scrubbed
 * trigger must be the element that travels through the viewport; here that element is the band
 * itself. Rendering a bare `<div>` and putting the band inside it would either give the trigger a
 * height of zero-then-auto (the wrapper collapses around an absolutely positioned picture) or force a
 * second element between the scope and the thing it measures for no reason anyone could name later.
 * So the scope IS the band, and the section hands it the band's classes.
 *
 * ⚠ THE PICTURE IS FOUND BY `data-parallax-figure`, never by class name. A Tailwind class is a styling
 * decision somebody will change next week; the attribute is a contract between these two files and
 * reads as one at both ends.
 */

import type { ReactNode } from "react";

import { useGsapScope } from "@/components/motion/gsap/useGsapScope";

/**
 * The most travel the picture can be given, as a percentage of its own height, end to end.
 *
 * ⚠ THE CEILING IS SET BY THE OVERSCAN AND NOT BY TASTE. Both picture sources draw a `parallax` image
 * at 1.18× its frame (`CraftPhoto`'s `PARALLAX_OVERSCAN`, and the matching `scale-[1.18]` that
 * `StoryPicture` puts on an uploaded asset), which leaves 9% of spare height above and below. The
 * tween below spends half the travel in each direction, so 16 means ±8% — inside the spare with a
 * little to give away. Go past it and the frame shows through as a bar along one edge at one end of
 * the travel, which is the "why is there a pale line under my photograph" bug.
 *
 * ⚠ THE SCHEMA ALLOWS 40 AND THAT IS NOT A MISTAKE IN EITHER PLACE. `speed` is an editor's dial —
 * "more drift, less drift" — and a payload written today outlives the geometry of the component that
 * reads it, so the field is generous and the renderer is the thing that knows what the overscan can
 * afford. A value above 16 is honoured as 16 rather than refused: a banner is not worth breaking over
 * a number somebody nudged too far, and the difference between 16 and 40 is a bar along the top edge,
 * not a livelier picture.
 */
const MAX_SAFE_SPEED = 16;

export interface ParallaxStageProps {
  /**
   * How far the photograph drifts as the band passes, as a percentage of its own height, END TO END.
   *
   * The default in the payload is 14, which is ±7 — the same drift `StoryStage` settles on for a
   * chapter's photograph, and the two blocks sit on the same page often enough that they had better
   * agree about how much depth "a little" is.
   *
   * ⚠ ZERO BUILDS NOTHING AT ALL, not a tween of zero distance. A ScrollTrigger that travels nowhere
   * still measures its element on every refresh and still holds it from collection for the life of
   * the page, in exchange for an animation nobody can see.
   */
  speed: number;
  /** The band's own classes. The scope element and the band are the same element — see the header. */
  className?: string;
  children: ReactNode;
}

export function ParallaxStage({ speed, className, children }: ParallaxStageProps) {
  // Clamped here rather than trusted from the payload: `speed` has been through Zod, but a renderer
  // that reads a number straight out of JSON and hands it to a transform is one migration away from
  // a picture translated by 4000%.
  //
  // ⚠ THE FINITE TEST IS THE HALF OF THAT GUARD `Math.min`/`Math.max` CANNOT DO. Both propagate NaN
  // rather than clamping it, so a `NaN` speed would survive the pair, fail the `=== 0` test below and
  // build a real ScrollTrigger whose tween renders `translate(0%, NaN%)` — an invalid transform the
  // browser discards silently, leaving a live trigger measuring the band on every scroll for an
  // animation that can never appear. Zero is the honest reading of "no usable number": no drift.
  const requested = Number.isFinite(speed) ? speed : 0;
  const travel = Math.min(Math.max(requested, 0), MAX_SAFE_SPEED) / 2;

  const scopeRef = useGsapScope<HTMLDivElement>(
    travel === 0
      ? null
      : ({ gsap, q, scope }) => {
          // One banner, one picture — `[0]` rather than a loop, and `undefined` under
          // `noUncheckedIndexedAccess` is the normal case rather than an oddity: a block whose
          // photograph has not been chosen yet renders a stated-absence panel with no `<img>` in it,
          // and there is nothing to drift.
          const figure = q("[data-parallax-figure]")[0];
          const image = figure?.querySelector<HTMLElement>("img");
          if (!image) return;

          gsap.fromTo(
            image,
            { yPercent: -travel },
            {
              yPercent: travel,
              // `ease: "none"` on anything scrubbed, always. An eased scrub moves at a different speed
              // from the reader's own hand, which is the thing that reads as the page lagging rather
              // than as the picture sitting behind the words.
              ease: "none",
              scrollTrigger: {
                // ⚠ THE TRIGGER IS THE BAND, which is this scope — never the picture. The picture is
                // absolutely positioned inside the band and, at `screen` height, is very nearly the
                // size of the viewport; a trigger on it would spend most of its range with the band
                // already off both edges of the screen and report progress in a rush at each end.
                //
                // Top-of-band-meets-bottom-of-window to bottom-of-band-meets-top-of-window is the
                // whole of the time the reader can see it, so the travel is spent exactly while the
                // band is on screen and the picture is at its resting position — the crop the editor
                // chose — at the moment the band is centred.
                trigger: scope,
                start: "top bottom",
                end: "bottom top",
                scrub: true
              }
            }
          );
        },
    [travel]
  );

  return (
    <div ref={scopeRef} className={className}>
      {children}
    </div>
  );
}
