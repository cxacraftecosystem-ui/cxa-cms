"use client";

/**
 * ProcessStage — the CLIENT half of the PROCESS_STEPS block, and deliberately the smaller half.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT RENDERS: A DIV. Nothing else.
 *
 * `ProcessStepsSection` — a Server Component — renders every stage, every title, every photograph
 * and the SVG rail itself. This wraps that markup in the element GSAP scopes to, finds what it needs
 * by `data-*` attribute, and builds three scrubbed animations. So the description of how a thing is
 * made arrives in the HTML, is indexed, reads with JavaScript switched off, and is never serialised
 * into a client props payload.
 *
 *   1. **The line draws itself.** The purple path down the rail is scrubbed from empty to full by
 *      `stroke-dashoffset`. The GREY TRACK BEHIND IT IS ALWAYS DRAWN, in the server markup, so the
 *      stages are joined by a line whatever happens here.
 *   2. **Each stage's marker fills** as that stage reaches the middle of the screen — a class toggle,
 *      so the appearance stays in the stylesheet with the rest of the styling and this file says only
 *      WHEN.
 *   3. **Each photograph drifts** inside its frame as its stage passes, which is the only thing that
 *      gives the block any depth. With no JavaScript it is a photograph, correctly cropped.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NOTHING HERE CARRIES INFORMATION. The rail, the fill and the markers are `aria-hidden`
 * decoration; each stage's position in the process is written as a real number beside it and as an
 * `<ol>` around it (contract §1.4). A reduced-motion reader builds none of this — `useGsapScope`
 * returns before the runtime is even imported — and loses nothing but the drawing.
 *
 * ⚠ EVERY ELEMENT IS FOUND BY `data-*` ATTRIBUTE, never by class name. A Tailwind class is a styling
 * decision somebody will change next week; `data-process-mark` is a contract between these two files
 * and reads as one at both ends.
 */

import type { ReactNode } from "react";

import { useGsapScope } from "@/components/motion/gsap/useGsapScope";

/**
 * How far each photograph travels inside its frame, as a percentage of its own height.
 *
 * ⚠ IT MUST STAY WELL INSIDE THE OVERSCAN. `StoryPicture`'s `parallax` marker draws the image at
 * 1.18× its frame, which leaves 9% of spare height at each end. Drift further than that and the frame
 * shows through as a bar along one edge — the "why is there a pale line under my photograph" bug. 6
 * leaves room to spare and is still enough to read as depth.
 *
 * A constant rather than a prop: `StoryStage` exposes one because a story's chapters are full-bleed
 * and an editor may reasonably want more or less; a process diagram's pictures are small and there is
 * no second correct answer to tune towards.
 */
const PICTURE_DRIFT = 6;

export interface ProcessStageProps {
  children: ReactNode;
}

export function ProcessStage({ children }: ProcessStageProps) {
  const scopeRef = useGsapScope<HTMLDivElement>(({ gsap, ScrollTrigger, q, scope }) => {
    // ── 1. The line ─────────────────────────────────────────────────────────
    //
    // ⚠ `scaleY`, NOT `strokeDashoffset`, AND THE DIFFERENCE IS A REPAINT PER SCROLL FRAME.
    //
    // The rail used to be an SVG path drawn by scrubbing its dash offset. That is neither transform
    // nor opacity, so no engine composites it: the rail repainted on the MAIN THREAD on every scroll
    // frame, for the whole length of a block that is deliberately several viewports tall. On a dead
    // straight line the two are visually identical, so the markup is now two divs and this is a
    // transform — see the long note at the rail in ProcessStepsSection.tsx.
    //
    // No normalisation is needed either. A scale is a ratio by definition, so 0 → 1 is one full pass
    // whatever height the rail ends up, with no `pathLength`, no `getTotalLength()` and nothing to
    // recompute when a late-decoding photograph changes the page height. `StoryStage`'s progress rail
    // has always been scrubbed this way; the two blocks now agree in mechanism as well as appearance.
    const fill = q("[data-process-line-fill]")[0];
    if (fill) {
      gsap.fromTo(
        fill,
        { scaleY: 0 },
        {
          scaleY: 1,
          // `ease: "none"` on anything scrubbed, always. An eased scrub moves at a different speed
          // from the reader's own hand, which is what reads as the page lagging rather than as the
          // line being drawn.
          ease: "none",
          scrollTrigger: {
            // ⚠ THE TRIGGER IS THE SCOPE — the container that holds the rail AND the stages — and
            // never a child of it. It is also what makes the timing exact rather than approximate:
            // the rail spans this element top to bottom, so between "top centre" and "bottom centre"
            // the drawn head of the line sits at the middle of the screen the whole way down. The
            // line therefore reaches each marker at the same instant that marker crosses the centre,
            // which is the instant the toggle below fires. Two animations, one moment, by geometry
            // rather than by two hand-tuned numbers that would drift apart.
            trigger: scope,
            start: "top center",
            end: "bottom center",
            scrub: true
          }
        }
      );
    }

    // ── 2. The markers ──────────────────────────────────────────────────────
    //
    // `toggleClass` rather than a tween: the filled state is a STYLE, and expressing it as a class
    // keeps the appearance in the server component beside the rest of the marker's styling — and
    // leaves it reachable from CSS for anything a later stylesheet wants to do with it.
    //
    // ⚠ `ScrollTrigger.create` AND NOT `gsap.to(mark, { scrollTrigger })`. The tween spelling asks
    // GSAP for a half-second tween with no properties in it — a real tween on a real timeline, one per
    // stage, animating nothing — purely as a vehicle for the trigger that does the work.
    const stages = q("[data-process-stage]");
    for (const stage of stages) {
      const index = stage.dataset.processStage;
      const mark = index ? scope.querySelector<HTMLElement>(`[data-process-mark="${index}"]`) : null;
      if (!mark) continue;

      ScrollTrigger.create({
        /*
         * ⚠ THE MARKER STAYS FILLED FOR AS LONG AS THE LINE IS DRAWN PAST IT, WHICH IS WHY THE END IS
         * THE SCOPE AND NOT THE STAGE.
         *
         * The claim above — that the line reaches each marker at the same instant the marker crosses
         * the centre — was only half the story. Ending at the stage's own `bottom center` also
         * UN-fills the marker the instant the next stage reaches the centre, while the line, being
         * scrubbed, stays drawn past it. The block then shows a finished purple line threaded through
         * a column of grey discs, with a single filled disc travelling down it: exactly the
         * inconsistency the shared geometry was supposed to rule out.
         *
         * The drawn head of the line sits at the middle of the screen the whole way down (see above),
         * so "the line has passed this marker" is precisely "this stage's top has crossed the centre
         * and the block's bottom has not". That is this trigger's span, it needs no tuning, and it
         * reverses correctly when the reader scrolls back up and the line retreats.
         */
        trigger: stage,
        start: "top center",
        endTrigger: scope,
        end: "bottom center",
        toggleClass: { targets: mark, className: "is-reached" }
      });
    }

    // ── 3. The photographs ──────────────────────────────────────────────────
    for (const figure of q("[data-process-figure]")) {
      const image = figure.querySelector<HTMLElement>("img");
      const stage = figure.closest<HTMLElement>("[data-process-stage]");
      if (!image || !stage) continue;

      gsap.fromTo(
        image,
        { yPercent: -PICTURE_DRIFT },
        {
          yPercent: PICTURE_DRIFT,
          ease: "none",
          scrollTrigger: {
            // The stage rather than the figure, so a photograph and the words beside it travel on
            // one clock. Triggering on the figure would give a tall stage and a short one two
            // different drift speeds for no reason a reader could name.
            trigger: stage,
            start: "top bottom",
            end: "bottom top",
            scrub: true
          }
        }
      );
    }
  }, []);

  return <div ref={scopeRef}>{children}</div>;
}
