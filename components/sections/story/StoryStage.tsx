"use client";

/**
 * StoryStage — the CLIENT half of the scrolling story, and deliberately the smaller half.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS COMPONENT DOES NOT DO, WHICH IS MOST OF WHAT THE BLOCK DOES.
 *
 * It renders no chapter, no photograph and no heading. `StoryScrollSection` — a Server Component —
 * renders all of that, and this wraps it. So the words of the story arrive in the HTML, are indexed,
 * are readable with JavaScript switched off, and are not serialised into a props payload.
 *
 * What it adds is three scrubbed animations, and every one of them is an ENHANCEMENT OF A LAYOUT THAT
 * ALREADY WORKS:
 *
 *   1. **Parallax inside each chapter's frame.** The photograph is drawn 18% larger than its frame
 *      (`StoryPicture`'s overscan) and drifts a few percent as the chapter passes. With no
 *      JavaScript it is a photograph, correctly cropped.
 *   2. **The progress rail.** A hairline that fills as the reader descends. With no JavaScript it is
 *      an empty hairline — and the chapter count beside it is TEXT, so the information the rail
 *      carries is never only in the motion (contract §1.5).
 *   3. **Chapter marks.** Each chapter's dot fills as its chapter reaches the middle of the screen.
 *      The same rule applies: the chapter's own number is written next to it.
 *
 * ⚠ THE STICKINESS IS `position: sticky` IN THE SERVER COMPONENT'S CLASSES AND IS NOT TOUCHED HERE.
 * That is what makes the block degrade to something worth reading: a chapter whose photograph stays
 * put while its words scroll is a CSS feature, and GSAP failing to load costs the drift and the rail
 * and nothing else.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ EVERY ELEMENT IS FOUND BY `data-*` ATTRIBUTE, never by class name. A Tailwind class is a
 * styling decision somebody will change; `data-story-figure` is a contract between these two files
 * and reads as one at both ends.
 */

import type { ReactNode } from "react";

import { useGsapScope } from "@/components/motion/gsap/useGsapScope";

export interface StoryStageProps {
  /**
   * How far each photograph drifts within its frame, as a percentage of its own height, in EACH
   * direction — so the end-to-end travel is twice this.
   *
   * ⚠ MUST STAY INSIDE THE OVERSCAN, WITH SOMETHING LEFT OVER. `StoryPicture` draws a parallax image
   * at 1.18× its frame, centred, which leaves exactly 9% of the frame's height spare beyond each
   * edge. Drift past the spare and the frame shows through as a bar at one end of the travel — the
   * classic "why is there a pale line under my photograph" bug. 7 leaves a margin and is already
   * enough to read as depth; the ceiling below is what a value from anywhere else is held to.
   */
  drift?: number;
  children: ReactNode;
}

/**
 * The most drift the overscan can afford, in each direction.
 *
 * ⚠ 8 AND NOT 9, AND THE DIFFERENCE IS THE WHOLE POINT OF THE CONSTANT. The two numbers are directly
 * comparable — GSAP's `yPercent` is a percentage of the element's own LAYOUT height and is emitted as
 * a `translate()` composed BEFORE the `scale(1.18)`, so the travel is not multiplied by the overscan
 * and 9% of travel meets 9% of spare exactly. Flush is not safe: an `aspect-ratio` frame routinely
 * resolves to a fractional height, the scale rounds separately from the translate, and at the far end
 * of the scrub the seam shows as a hairline of `bg-surface-100` along one edge. 8 keeps 1% of the
 * frame's height in hand, which is what `CraftPhoto` sized the 1.18 for and what `ParallaxStage`
 * already clamps its own end-to-end figure of 16 down to. The two blocks appear on one page and had
 * better agree.
 *
 * More drift than this is a bigger overscan in `StoryPicture` and `CraftPhoto`, never a bigger number
 * here.
 */
const MAX_SAFE_DRIFT = 8;

export function StoryStage({ drift = 7, children }: StoryStageProps) {
  const safeDrift = Math.min(Math.max(drift, 0), MAX_SAFE_DRIFT);

  const scopeRef = useGsapScope<HTMLDivElement>(
    ({ gsap, ScrollTrigger, q, scope }) => {
      // ── 1. Parallax, one trigger per chapter ────────────────────────────────
      //
      // The TRIGGER is the chapter, not the figure. A sticky figure stops moving relative to the
      // viewport the moment it sticks, so a trigger on the figure itself would report almost no
      // progress for most of the chapter and the drift would happen in a rush at each end.
      for (const figure of q("[data-story-figure]")) {
        const image = figure.querySelector<HTMLElement>("img");
        const chapter = figure.closest<HTMLElement>("[data-story-chapter]");
        if (!image || !chapter || safeDrift === 0) continue;

        gsap.fromTo(
          image,
          { yPercent: -safeDrift },
          {
            yPercent: safeDrift,
            // `ease: "none"` for anything scrubbed, always. An eased scrub means the picture moves
            // at a different speed from the reader's own hand, which is the thing that reads as the
            // page being laggy rather than as depth.
            ease: "none",
            scrollTrigger: {
              trigger: chapter,
              start: "top bottom",
              end: "bottom top",
              scrub: true
            }
          }
        );
      }

      // ── 2. The progress rail ────────────────────────────────────────────────
      const fill = q("[data-story-progress-fill]")[0];
      if (fill) {
        gsap.fromTo(
          fill,
          { scaleY: 0 },
          {
            scaleY: 1,
            ease: "none",
            scrollTrigger: {
              trigger: scope,
              // From the moment the story reaches the middle of the screen to the moment its last
              // chapter leaves it — so the rail is full exactly when the story is finished, rather
              // than when its bottom edge crosses the bottom of the window with a chapter still
              // unread above the fold.
              start: "top center",
              end: "bottom center",
              scrub: true
            }
          }
        );
      }

      // ── 3. Chapter marks ────────────────────────────────────────────────────
      //
      // `toggleClass` rather than a tween: the mark's filled state is a STYLE, and expressing it as
      // a class means the same appearance is reachable from CSS — including by the `:target` rule
      // and by anything a later stylesheet wants to do with it.
      //
      // ⚠ `ScrollTrigger.create` AND NOT `gsap.to(mark, { scrollTrigger })`. The tween spelling asks
      // GSAP for a half-second tween with no properties in it — a real tween on a real timeline, one
      // per chapter, animating nothing — purely as a vehicle for the trigger that does the work. The
      // trigger IS the intent, so the trigger is what gets created.
      const chapters = q("[data-story-chapter]");
      for (const chapter of chapters) {
        const index = chapter.dataset.storyChapter;
        const mark = index ? scope.querySelector<HTMLElement>(`[data-story-mark="${index}"]`) : null;
        if (!mark) continue;

        ScrollTrigger.create({
          /*
           * ⚠ THE MARK STAYS FILLED UNTIL THE RAIL RETREATS PAST IT, WHICH IS WHY THE END IS THE
           * STORY AND NOT THE CHAPTER.
           *
           * Ending at the chapter's own `bottom center` un-fills each dot the moment the NEXT chapter
           * reaches the middle of the screen. The rail beside them is scrubbed monotonically and
           * stays where it has got to — so a purple rail would be drawn straight past a column of
           * grey dots, with only ever one dot filled at a time. That contradicts the rail and the
           * class's own name in one gesture.
           *
           * From this chapter's top crossing the centre to the STORY's bottom crossing it, the dot is
           * filled for exactly as long as the rail is drawn past it, and un-fills on the way back up
           * in reverse order for the same reason. Two indicators, one geometry, no second number to
           * keep in step.
           */
          trigger: chapter,
          start: "top center",
          endTrigger: scope,
          end: "bottom center",
          toggleClass: { targets: mark, className: "is-reached" }
        });
      }
    },
    [safeDrift]
  );

  return <div ref={scopeRef}>{children}</div>;
}
