/**
 * ProcessStepsSection — how a thing is made, stage by stage, with a line that draws itself between
 * the stages as the reader descends.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT ACTION_STEPS AND THE DIFFERENCE IS THE READER'S JOB (see `processStepsSectionSchema`).
 *
 * ACTION_STEPS is a list of things the READER must DO — it carries closing dates, buttons and an
 * open/closed state, and its spine is deliberately STATIC because a checklist is something you work
 * down while looking away at a form. This block describes what SOMEBODY ELSE does: how indigo is
 * fermented, how a pot is fired. There is nothing to click and no deadline to miss, which is exactly
 * why it is allowed to be beautiful — a drawn line on an application deadline would be decoration
 * competing with the one thing on the page that matters.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A SERVER COMPONENT. Every stage, every title and every photograph is rendered here and arrives in
 * the HTML — indexed, readable with JavaScript switched off, never serialised into a props payload.
 * `ProcessStage` is a client wrapper that owns no content at all and adds three scrubbed animations.
 *
 * ⚠ THE LINE AND THE MARKERS ARE DECORATION AND NOTHING DEPENDS ON THEM. They are `aria-hidden`; the
 * order of the stages is carried by the `<ol>` (which is what makes a screen reader say "3 of 6") and
 * by a real, visible, selectable numeral in each marker. A reduced-motion reader gets no drawing at
 * all — `ProcessStage` builds nothing — and a reader whose animation chunk never arrives gets the
 * same. Both still get a numbered, joined-up sequence of stages, because the grey TRACK behind the
 * fill is drawn in this file and is always there (contract §1.4).
 *
 * ⚠ THE PURPLE FILL'S RESTING STATE IS AN EMPTY RAIL, and that is honest rather than broken: nothing
 * has been read yet. It is the same treatment `StoryScrollSection` gives its progress rail, and it is
 * why an undrawn line is not a violation of the "already in its final position" invariant that
 * governs every scrubbed animation here — the line that JOINS the stages is the track, and the track
 * is finished before any JavaScript runs.
 *
 * ⚠ NARROW SCREENS ARE ALWAYS ONE COLUMN, whatever `layout` says. `alternating` only takes effect
 * from `lg`, where there is room either side of a centred line; below that a two-sided diagram is a
 * pair of 160px columns and the "opposite side of the line" reads as nothing at all.
 */

import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { ProcessStage } from "@/components/sections/story/ProcessStage";
import { StoryPicture } from "@/components/sections/story/StoryPicture";
import { SectionHeading } from "@/components/site/SectionHeading";
import { sectionLabel } from "@/lib/sections/registry";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { ProcessStep, ProcessStepsSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface ProcessStepsSectionProps {
  data: ProcessStepsSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. */
  resolved?: ResolvedSectionData;
}

type ProcessLayout = ProcessStepsSectionData["layout"];

/**
 * ONE OWNER OF THE HORIZONTAL AXIS, and it is the five maps below (`RAIL_POSITION`, `MARK_POSITION`,
 * `ROW_LAYOUT`, `CARD_SIDE`, `CARD_WIDTH`) plus `PICTURE_SIZES`, which reads its numbers off them.
 *
 * The rail, every marker and every card have to agree on where the centre line is at two different
 * breakpoints and in two different layouts. Three independent guesses reconciled by eye is a
 * three-way agreement that has to be re-derived by hand every time a size moves — and it has already
 * broken once upstream. So the numbers are written once, here, and the geometry is:
 *
 *   • ONE COLUMN (every narrow screen, and `column` at every width): the line's centre is at
 *     `1.375rem`, which is half of the 44px marker, so a marker at `left-0` sits on it. The card
 *     clears both with `pl-16` (4rem).
 *   • ALTERNATING from `lg`: the line's centre is at 50%, the marker is pulled back onto it by half
 *     its own width, and the card sits in one half of a two-column grid whose 6rem gutter leaves
 *     1.625rem of air between the card's edge and the marker.
 *
 * ⚠ The markers are centred with NEGATIVE MARGINS, never `-translate-x-1/2`. A transform utility on
 * an element inside a `Reveal` loses to framer's inline `transform` (contract §8) — and although
 * these particular markers sit outside the reveal, using two different centring techniques in one
 * file is how the wrong one gets copied into the wrong place.
 *
 * Complete literal class strings throughout: a class assembled by concatenation is purged by the
 * content scanner and the rail simply vanishes (contract §5).
 */
const RAIL_POSITION: Record<ProcessLayout, string> = {
  alternating: "left-[1.375rem] lg:left-1/2",
  column: "left-[1.375rem]"
};

const MARK_POSITION: Record<ProcessLayout, string> = {
  alternating: "left-0 lg:left-1/2 lg:-ml-[1.375rem]",
  column: "left-0"
};

const ROW_LAYOUT: Record<ProcessLayout, string> = {
  alternating: "pl-16 lg:grid lg:grid-cols-2 lg:gap-x-24 lg:pl-0",
  column: "pl-16"
};

/**
 * Which half of the grid a stage's card sits in.
 *
 * ⚠ THE TEXT STAYS LEFT-ALIGNED ON BOTH SIDES. Mirroring the alignment so the left-hand cards read
 * right-to-left is the obvious flourish and it is wrong: a ragged left edge costs a reader the anchor
 * their eye returns to on every line, and half the stages of a process would be measurably harder to
 * read than the other half. Only the card's POSITION alternates.
 */
const CARD_SIDE: Record<"start" | "end", string> = {
  start: "lg:col-start-1",
  end: "lg:col-start-2"
};

/** The card's own width. In `alternating` the grid column already bounds it. */
const CARD_WIDTH: Record<ProcessLayout, string> = {
  alternating: "",
  // A 3:2 photograph across the full 84rem shell is a poster, not a diagram. 42rem keeps the picture
  // and the paragraph under it on one comfortable measure.
  column: "max-w-2xl"
};

/**
 * What the browser should assume about the picture's rendered width before CSS has been applied.
 * Wrong here means either a blurred photograph or a needlessly large download, so the two layouts get
 * two honest answers rather than one convenient one.
 *
 * ⚠ THE ERROR IS NOT SYMMETRIC AND THAT IS WHY EVERY NUMBER HERE ROUNDS UP. Over-declaring costs a
 * few kilobytes; under-declaring makes the browser commit to a source narrower than the slot and no
 * later layout pass will fetch a better one, so the photograph is soft for the life of the page.
 *
 * `alternating` has to describe THREE widths, not two, because `alternating` is only alternating from
 * `lg` — below it the row is the same single column `column` is, but with no `max-w-2xl` bounding it
 * (see `CARD_WIDTH`). The slot there is the shell minus its own padding minus `pl-16`, which is about
 * 83–88vw between `sm` and `lg` and about 73vw on a phone. A single flat figure for that whole range
 * is the trap this note exists for: `40rem` is the exact slot width at 768px and understates it by
 * half a viewport at 1023px, which is precisely where a laptop reader meets a blurred photograph.
 */
const PICTURE_SIZES: Record<ProcessLayout, string> = {
  alternating: "(min-width: 1024px) 34rem, (min-width: 640px) 88vw, 92vw",
  // Bounded by `max-w-2xl` from the width at which 42rem fits, and the shell's own padding below it.
  column: "(min-width: 640px) 42rem, 100vw"
};

/**
 * The marker on the line: a disc with this stage's number in it.
 *
 * `[&.is-reached]:*` is the filled state, and `ProcessStage` toggles the class. The RESTING state is
 * a complete, legible, numbered disc — it is not a placeholder waiting for JavaScript, which is what
 * lets the reduced-motion path build nothing at all.
 *
 * `text-white` on `bg-purple-700` is deliberate and is not a hardcoded neutral: brand purple does not
 * invert between themes, so its foreground must not either (contract §3). `text-purple-700` at rest
 * sits on `bg-card`, which does invert, and the numeral inherits both.
 */
const MARK_BASE =
  "absolute top-0 flex h-11 w-11 items-center justify-center rounded-full border border-line-200 bg-card text-purple-700 shadow-sm transition-colors duration-300 ease-out [&.is-reached]:border-purple-700 [&.is-reached]:bg-purple-700 [&.is-reached]:text-white";

/**
 * Is there anything in this stage at all, or is it a row an editor added and has not typed into yet?
 *
 * The same filter `ActionStepsSection` and `TimelineSection` apply, and it is the OPPOSITE case to
 * the rule that nothing may be silently dropped: there is no content to lose here and nothing a
 * reader could act on. A stage with words but no picture is NOT blank and is never dropped — it keeps
 * its number and `StoryPicture` states the missing photograph in so many words.
 */
function isFilledIn(step: ProcessStep): boolean {
  return (
    step.title.length > 0 ||
    step.detail.length > 0 ||
    step.meta.length > 0 ||
    step.mediaId.length > 0 ||
    step.craftImage.length > 0
  );
}

/*
 * ⚠ THERE IS NO `RAIL_PATH` ANY MORE, AND THAT IS THE POINT.
 *
 * The rail used to be an SVG path (`M1 0 V 100`) scrubbed by its `stroke-dashoffset`, with a
 * `pathLength={100}` normalisation, a `preserveAspectRatio="none"` stretch and a note about butt caps
 * — because a round cap of one user unit becomes a twenty-pixel bulge once the box is scaled
 * twentyfold. All of that machinery existed to draw a straight vertical line.
 *
 * It is now two divs and a scrubbed `scaleY`, which is composited where a dash offset is not. See the
 * comment at the markup below.
 */

export function ProcessStepsSection({ data, section, resolved }: ProcessStepsSectionProps) {
  const stages = data.steps.filter(isFilledIn);

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const showsHeader = Boolean(heading || eyebrow || body);

  // Nothing written anywhere. A freshly added block is seeded with three stages, so this state is
  // only reachable by an editor deliberately emptying every field — which is an editor saying "not
  // this block". A heading WITHOUT stages still renders below: an editor who has written it and not
  // yet added a stage should see their own heading on the page rather than an absence they cannot
  // tell apart from a broken block.
  if (stages.length === 0 && !showsHeader) return null;

  const layout = data.layout;
  const lastIndex = stages.length - 1;

  const rows = stages.map((stage, index) => {
    const title = stage.title.trim();
    const meta = stage.meta.trim();
    const detail = stage.detail.trim();

    return (
      <li
        // ⚠ INDEX ALONE, AND THE TITLE MUST NOT BE PART OF IT. These rows carry no identity of their
        // own — there is no id in the payload — and they are reordered only by an editor rewriting
        // the array, which re-renders the block anyway. A key that folds the title in looks like it
        // buys stability and buys the opposite: the key changes the moment an editor types, React
        // unmounts the `<li>` and mounts a new one, and the ScrollTriggers `ProcessStage` built are
        // left measuring a node that is no longer in the document — `useGsapScope` rebuilds on its
        // dependency list, not on a re-render, so that stage's marker and drift die silently in the
        // studio's live preview. Same key `StoryScrollSection` uses, for the same reason.
        key={index}
        data-process-stage={index}
        className={cn(
          "relative",
          ROW_LAYOUT[layout],
          // The gap between stages, paid by every row except the last. It is written as a branch
          // rather than `last:pb-0` because `lg:pb-24` lives inside a media query and would win over
          // `last:pb-0` on the final row — leaving 6rem of drawn line hanging below the last stage.
          index < lastIndex && "pb-16 lg:pb-24"
        )}
      >
        {/*
          THE MARKER. `aria-hidden` because it says exactly what the `<ol>` around it already says,
          and a decorative disc announced as "graphic, 3" between every stage would be noise.

          It sits OUTSIDE the `Reveal` on purpose: the marker belongs to the line, and a marker that
          rose 16px into place would detach itself from the rail for half a second every time a stage
          arrived.
        */}
        <span
          data-process-mark={index}
          aria-hidden="true"
          className={cn(MARK_BASE, MARK_POSITION[layout])}
        >
          {data.numbered ? (
            // `font-display font-bold` rather than the `.display-title` recipe: that recipe carries
            // `text-ink-900`, which would beat the colour this numeral is meant to inherit from the
            // disc and leave a dark numeral on a purple fill once the marker is reached.
            <span className="font-display text-base font-bold leading-none">{index + 1}</span>
          ) : (
            // `bg-current` so the dot inherits the disc's colour and inverts with it — purple on the
            // card, white once the disc has filled.
            <span className="block h-2 w-2 rounded-full bg-current" />
          )}
        </span>

        <Reveal
          className={cn(CARD_WIDTH[layout], layout === "alternating" ? CARD_SIDE[index % 2 === 0 ? "start" : "end"] : undefined)}
          distance={16}
          // No per-index delay, deliberately. `ActionStepsSection` staggers its rows because they are
          // compact and arrive together; these stages are a viewport apart, so each one already
          // enters on its own and a delay computed from its index would only make the twelfth stage
          // wait for nothing.
        >
          <div data-process-figure>
            <StoryPicture
              mediaId={stage.mediaId}
              craftSlug={stage.craftImage}
              resolved={resolved}
              // 3:2 for every stage, from both picture sources, so a column of stages lines up and
              // the rail's markers stay level with the tops of the cards.
              aspect="3 / 2"
              sizes={PICTURE_SIZES[layout]}
              parallax
              emptyLabel="No photograph has been chosen for this stage yet."
            />
          </div>

          {title ? (
            // Level 3: the block's own heading below is the `<h2>`, so a stage is one rung under it.
            <h3 className="display-title mt-5 text-balance text-xl sm:text-2xl">{title}</h3>
          ) : null}

          {meta ? (
            <p className={cn("text-xs font-medium uppercase tracking-[0.14em] text-ink-500", title ? "mt-2" : "mt-5")}>
              {meta}
            </p>
          ) : null}

          {detail ? (
            <p className={cn("prose-measure text-sm leading-relaxed text-ink-700", title || meta ? "mt-3" : "mt-5")}>
              {detail}
            </p>
          ) : null}
        </Reveal>
      </li>
    );
  });

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {/*
          ALWAYS RENDERED. Every stage's title is an `<h3>`, so a block with no `<h2>` of its own
          takes the page from `<h1>` straight to `<h3>` — a rung missing from the outline a
          screen-reader user navigates by (contract §11). A heading the editor cleared is taken OFF
          SCREEN rather than invented, and the fallback words are the block's own name from
          `SECTION_REGISTRY` so they come from one place.
        */}
        <SectionHeading
          eyebrow={eyebrow || undefined}
          title={heading || sectionLabel(section.type)}
          titleClassName={heading ? undefined : "sr-only"}
          description={body || undefined}
          className={showsHeader ? "mb-14" : undefined}
        />

        {stages.length === 0 ? null : (
          <ProcessStage>
            {/*
              The rail is a SIBLING of the list, not a child of it: `<ol>` and `<ul>` admit `<li>` and
              script-supporting elements only, and a stray `<div>` inside one is invalid markup that
              some assistive technology quietly drops along with everything after it. This wrapper is
              also what the rail's `inset-y-0` measures against, and it holds nothing but the rail and
              the list — so the line spans exactly the first stage's top edge to the last stage's
              bottom edge, which is the span `ProcessStage` scrubs against.
            */}
            <div className="relative">
              <div
                aria-hidden="true"
                className={cn(
                  // `-ml-px` is half of the 2px width — see the geometry note on RAIL_POSITION.
                  "pointer-events-none absolute inset-y-0 -ml-px w-[2px]",
                  RAIL_POSITION[layout]
                )}
              >
                {/*
                  THE TRACK. Always drawn, in the server markup, in a themed neutral that inverts.
                  This is the line that JOINS the stages, and it is finished before any JavaScript
                  runs — which is what makes the fill over it a progress ornament rather than content
                  held hostage by a chunk that may never arrive.
                */}
                <div className="absolute inset-0 bg-line-200" />
                {/*
                  THE FILL, and it is TWO DIVS AND A `scaleY` RATHER THAN AN SVG PATH AND A DASH
                  OFFSET — which is what this was, and is worth explaining because the SVG version
                  looked more precise and was strictly worse.

                  `stroke-dashoffset` is neither transform nor opacity: no engine composites it, so
                  scrubbing it repainted the rail on the MAIN THREAD on every scroll frame, for the
                  whole length of a block that is deliberately several viewports tall. `scaleY` is a
                  transform, composited on the GPU, and on a DEAD STRAIGHT line the two are visually
                  identical — the path was `M1 0 V 100`, a plain vertical stroke.

                  It also deletes three problems the SVG had and this cannot have: the `pathLength`
                  normalisation, the `preserveAspectRatio="none"` stretch, and the butt-cap geometry
                  note about a round cap becoming a 20px bulge once the box is scaled twentyfold.

                  `origin-top scale-y-0` is the resting state — empty, because nothing has been read
                  yet — and it is what a reader with no JavaScript and a reader with reduced motion
                  both keep. `StoryStage`'s progress rail has always worked exactly this way; the two
                  blocks appear on one page and now agree in mechanism as well as in appearance.
                */}
                <div
                  data-process-line-fill
                  className="absolute inset-0 origin-top scale-y-0 bg-purple-700"
                />
              </div>

              {/*
                `<ol>` versus `<ul>` COMES FROM `numbered`, and the flag is not merely about printing
                digits: its help text says to turn it off "where the stages genuinely happen at once".
                So the flag is the editor's statement about whether this is a SEQUENCE, and the
                container has to agree with the numerals — an ordered list is what makes a screen
                reader say "3 of 6", which is the whole of what "stage 3" means, and claiming an order
                that does not exist is worse than claiming none.

                Written as two concrete branches rather than `const Tag = numbered ? "ol" : "ul"`,
                because TypeScript intersects the props of a union of intrinsic elements and collapses
                `children` to `never` — the trap `components/ui/Heading.tsx` documents at length.

                `list-none` because the markers on the rail ARE the list markers — and `role="list"` because
                Safari and VoiceOver drop list semantics entirely when `list-style: none` is set. The
                role is what puts them back; the semantics then stay
                and the browser's own bullets would sit outside them.
              */}
              {data.numbered ? (
                <ol role="list" className="list-none">{rows}</ol>
              ) : (
                <ul role="list" className="list-none">{rows}</ul>
              )}
            </div>
          </ProcessStage>
        )}
      </div>
    </section>
  );
}
