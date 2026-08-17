/**
 * RichTextSection — the everyday block: whatever this page says in its own words.
 *
 * A Server Component. `components/RichText.tsx` walks the stored Tiptap document and whitelists the
 * nodes it draws, so there is nothing interactive here; `Reveal` is the only client piece.
 *
 * IT ENTERS ON THE HOUSE REVEAL, like every other content block — on a page where the call to action
 * above it and the figures below it both rise into place, a passage of text that simply exists reads
 * as a fault rather than as restraint.
 *
 * ⚠ IT ASKS FOR `amount="some"` RATHER THAN THE DEFAULT, and of every block on the site this is the
 * one that must. framer hands `amount` to an IntersectionObserver as a threshold, and an element more
 * than about three viewports tall can never have 0.3 of itself on screen at once — so the default
 * would simply never fire. The length of this block is whatever the editor wrote, and a long essay
 * left at `opacity: 0` is a page that is complete in the DOM and blank to read.
 *
 * THE TWO WIDTHS ARE A COLUMN DECISION; THE MEASURE IS A READING ONE, AND THEY ARE NOT THE SAME
 * QUESTION. `width` chooses the container — `shell-narrow` (52rem) or the full `shell` (84rem) — which
 * is what a wide table or a full-bleed figure needs. The MEASURE, from `lib/typography/typeset.ts`,
 * chooses how long a line of text inside that container is allowed to get. An unset measure means "the
 * house style in a narrow block, no limit in a wide one", which is exactly what this file did before
 * the control existed, so nothing an editor has already published moves.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SIX ARRANGEMENTS, AND THE ONE THAT MUST NEVER MOVE.
 *
 * `layout` chooses how the passage is arranged (`richTextSectionSchema`): three text-alone
 * arrangements and three that include a picture.
 *
 *  • **"left"** is every row saved before the field existed, and IT IS TODAY'S RENDERING TO THE BYTE:
 *    the same shell classes, the same `alignment`-driven `text-*`, the same centred measure. Nothing
 *    an editor has already published moves. ⚠ Touch this path only knowing that.
 *  • **"right"** pushes the SAME constrained measure to the container's end (`ml-auto` where "left"
 *    writes `mx-auto`) and keeps the text flush left inside it — a moved column, not right-aligned
 *    prose, because a ragged LEFT edge makes every line start somewhere different.
 *  • **"center"** centres the measure and the headings, and centres the BODY only when it is short
 *    (`isShortRichText`): a centred standfirst is composition, a centred essay is unreadable.
 *  • **The two split arrangements** reuse MediaSplitSection's two-column grammar: picture first in
 *    the DOM so it stacks ABOVE the words on a phone, `lg:order-*` swapping sides only where both
 *    halves are on screen at once. `items-start`, not MediaSplit's `items-center` — its body is one
 *    short paragraph, this one is an essay of arbitrary length, and a picture vertically centred
 *    against an essay floats detached from the words it belongs to. The picture is plain and
 *    sticky-free; with NEITHER picture field set the arrangement collapses to its text-alone
 *    counterpart (MediaSplit's rule: an empty frame beside the words reads as a broken image, not an
 *    unfinished one), while a picture that WAS chosen and no longer resolves is a stated absence —
 *    `StoryPicture` says so on the page, so an editor can see what to put back.
 *  • **"center-media-between"** is heading → picture → body, all centred on the same column: the
 *    picture wears the text's own measure so the three read as one passage, and is capped at 48rem
 *    when the measure is "fill the column" — a full-bleed photograph between a heading and its first
 *    sentence stops being an illustration and starts being a section break.
 *
 * The picture goes through `StoryPicture`, which owns the mediaId-over-craftImage precedence and the
 * licence credit. `showRegion={false}` because this block appears on arbitrary pages that have said
 * nothing about regions; `creditOnCreditsPage` is NOT passed for the same reason — the adjacent
 * credit stays, since only compositions the /credits page demonstrably covers may drop it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IT IS `async`, AND THAT IS A DEPARTURE FROM THE RULE IN `SectionRenderer.tsx` — worth stating
 * plainly. That file's header says renderers do not query, because `lib/sections/resolve.ts` batches
 * every ROW a page needs; the settings groups are not part of that batch and it reads the `contact`
 * group itself for the same reason. This reads the `typography` group through `houseTypeset()` in
 * `components/site/ProseArticle.tsx` — the site's ONE reader of that group — which goes through
 * `getSettingCached` and is therefore `cache()`-wrapped: a page holding twelve text blocks pays for one
 * read, and a layout that has already read the settings pays for none. Threading it through
 * `SectionRenderer` as a prop, the way `contact` is, would be tidier and is the one change worth making
 * if that file is ever opened for it.
 *
 * An empty document with no heading and no chosen picture renders NOTHING rather than an empty
 * `<section>` full of vertical rhythm: a block that was never filled in should not push the rest of
 * the page down.
 *
 * ⚠ A HEADING IS NOT FORCED HERE, unlike in the FAQ, the timeline, the feature grid and the figures —
 * where a missing `<h2>` takes the page from `<h1>` straight to the `<h3>`s inside those blocks. Two
 * reasons. A text block is very often a CONTINUATION of the passage above it rather than the start of
 * a new section, and the stored document carries its own headings: `components/RichText.tsx` clamps the
 * editor's level 1 to an `<h2>`, so the outline is already whole without one from this file. A heading
 * invented here would either repeat the document's own first line or add a rung nothing corresponds to.
 */

import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { RichText } from "@/components/RichText";
import { StoryPicture } from "@/components/sections/story/StoryPicture";
import { houseTypeset } from "@/components/site/ProseArticle";
import { SectionHeading } from "@/components/site/SectionHeading";
import { pictureFromMap } from "@/lib/media/screens";
import { isEmptyRichText, isShortRichText, parseRichText } from "@/lib/richtext";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { RichTextSectionData } from "@/lib/sections/schema";
import {
  resolveTypeset,
  sectionHeadingWrapClass,
  typesetClassName,
  typesetIsConstrained,
  typesetMeasureClassName,
  typesetOf
} from "@/lib/typography/typeset";
import { cn } from "@/lib/utils";

export interface RichTextSectionProps {
  data: RichTextSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. Only the
   *  with-picture arrangements read it. */
  resolved?: ResolvedSectionData;
}

/** Complete literal class strings — a name built by concatenation is purged (contract §5). */
const ALIGN_CLASS: Record<RichTextSectionData["alignment"], string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right"
};

export async function RichTextSection({ data, section, resolved }: RichTextSectionProps) {
  const doc = parseRichText(data.body);
  // A document holding one empty paragraph is what an untouched Tiptap field looks like, and
  // `isEmptyRichText` is the only thing that knows that (see lib/richtext.ts).
  const hasBody = !isEmptyRichText(doc);
  const hasHeading = data.heading.length > 0 || data.eyebrow.length > 0;

  const layout = data.layout;
  const withPicture =
    layout === "text-left-media-right" ||
    layout === "text-right-media-left" ||
    layout === "center-media-between";
  // "Chosen" is a fact about the PAYLOAD; whether it resolves is a fact about the render, and
  // StoryPicture is what states the difference on the page. The text-alone arrangements ignore both
  // fields entirely, exactly as their help text promises.
  const pictureChosen =
    withPicture && (data.mediaId.trim().length > 0 || data.craftImage.trim().length > 0);

  /**
   * The per-screen framing, resolved once for whichever with-picture arrangement runs below.
   *
   * Inside the same `withPicture` test `resolve.ts` uses for the ids, so a framing left behind by a
   * switch to a text-alone arrangement resolves to nothing rather than to a picture the map happens to
   * hold for another block. It reaches `StoryPicture`'s uploaded branch only — a `craftImage` slug is a
   * compiled-in file with no media row and nothing to frame, which is that prop's own note.
   */
  const picture = withPicture
    ? pictureFromMap(data.mediaId, data.mediaScreens, resolved?.media)
    : null;

  // Before the read, not after: a block with nothing in it must not cost a query.
  if (!hasBody && !hasHeading && !pictureChosen) return null;

  const narrow = data.width === "narrow";

  // The two centred arrangements centre the heading always and the body only when it is short —
  // a centred essay makes every line start in a different place. See `isShortRichText`.
  const centred = layout === "center" || layout === "center-media-between";
  const centreBody = centred && hasBody && isShortRichText(doc);

  /**
   * The alignment handed to `resolveTypeset` gates the drop cap and justification, which act on the
   * BODY prose — so it follows the edge the body actually gets, not the arrangement's name. The
   * "left" arrangement keeps reading `alignment`, exactly as it always has; every other arrangement
   * sets the body flush left except a centred SHORT body.
   *
   * ⚠ MUST MATCH the same computation in components/studio/sections/RichTextForm.tsx, or the studio
   * warns about a page that is right (or stays silent about one that is wrong).
   */
  const proseAlignment: RichTextSectionData["alignment"] =
    layout === "left" ? data.alignment : centreBody ? "center" : "left";

  /**
   * ⚠ THE HOUSE STYLE IS READ BY `houseTypeset()` IN `components/site/ProseArticle.tsx`, AND THAT
   * IMPORT IS THE POINT RATHER THAN AN ECONOMY. This file used to keep its own copy of the read — the
   * same `getSettingCached("typography")`, the same fallback, the same `catch` — and a settings group
   * with two readers is two places that can disagree about what the house style is. The disagreement
   * would show up as an article and a text block on the same page set in two different faces, which is
   * precisely how this area got into the state it was in. ONE resolution path: one reader, one
   * `resolveTypeset()`, whatever the block.
   *
   * Only the OVERRIDES differ, and they are the argument below: a `PageSection` carries per-block
   * typesetting and an article does not.
   */
  const typeset = resolveTypeset({
    block: typesetOf(data),
    house: await houseTypeset(),
    alignment: proseAlignment,
    width: data.width
  });

  const constrained = typesetIsConstrained(typeset);

  /**
   * The block's own heading (or its lone eyebrow), with the measure travelling on it.
   *
   * The block's own heading is NOT a node in the document, so it inherits none of the recipe's custom
   * properties — the measure and the line-breaking treatment are handed to it explicitly, or it would
   * be the one heading on the page set to different rules.
   */
  const headingFor = (align: "start" | "center", columnClass: string) =>
    data.heading ? (
      <SectionHeading
        eyebrow={data.eyebrow || undefined}
        title={data.heading}
        align={align}
        className={cn("mb-10", columnClass, sectionHeadingWrapClass(typeset))}
      />
    ) : data.eyebrow ? (
      <p className={cn("eyebrow mb-6", columnClass, align === "center" && "text-center")}>
        {data.eyebrow}
      </p>
    ) : null;

  // `.prose-typeset` and its `ts-*` companions all land on THIS element: the recipe in globals.css
  // is written as `.prose-typeset <element>`, which outranks the per-node utilities RichText writes
  // without needing `!` anywhere (contract §5).
  const bodyFor = (className: string) =>
    hasBody ? (
      <div className={className}>
        <RichText value={doc} />
      </div>
    ) : null;

  // ── Text beside a picture — MediaSplit's two-column grammar ────────────────
  if (pictureChosen && layout !== "center-media-between") {
    const mediaRight = layout === "text-left-media-right";
    return (
      <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
        <div className={narrow ? "shell-narrow" : "shell"}>
          <div className="grid items-start gap-10 lg:grid-cols-2 lg:gap-16">
            {/* Picture first in the DOM, whatever the side: the halves stack on a phone, and a
                text-then-image order there puts a full viewport of prose between the reader and the
                picture it was written around (MediaSplitSection's rule, restated). */}
            <Reveal className={cn("order-1", mediaRight && "lg:order-2")}>
              <StoryPicture
                mediaId={data.mediaId}
                craftSlug={data.craftImage}
                resolved={resolved}
                picture={picture}
                sizes="(min-width: 1024px) 42rem, 100vw"
                showRegion={false}
                emptyLabel="The picture chosen for this passage is no longer available."
              />
            </Reveal>

            {/* `amount="some"` for the same reason as the header: this half is as long as the essay
                the editor wrote. The measure still caps the line length inside the cell; there is no
                centring, because the grid cell IS the column. */}
            <Reveal amount="some" className={cn("order-2", mediaRight && "lg:order-1")}>
              {headingFor("start", typesetMeasureClassName(typeset))}
              {bodyFor(typesetClassName(typeset))}
            </Reveal>
          </div>
        </div>
      </section>
    );
  }

  // ── Centred, with the picture between the heading and the body ─────────────
  if (pictureChosen && layout === "center-media-between") {
    const columnClass = cn(typesetMeasureClassName(typeset), constrained && "mx-auto");
    return (
      <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
        <div className={cn(narrow ? "shell-narrow" : "shell", "text-left")}>
          {/* One reveal around heading, picture and body: they are one passage, and a picture that
              arrives on a different beat from its own heading reads as two blocks. */}
          <Reveal amount="some">
            {headingFor("center", columnClass)}
            {/* The picture wears the TEXT'S measure, so heading, picture and body read as one column.
                With no measure to wear ("fill the column"), it is capped instead — see the header. */}
            <div className={cn(constrained ? columnClass : "mx-auto max-w-3xl", hasBody && "mb-10")}>
              <StoryPicture
                mediaId={data.mediaId}
                craftSlug={data.craftImage}
                resolved={resolved}
                picture={picture}
                sizes="(min-width: 1024px) 48rem, 100vw"
                showRegion={false}
                emptyLabel="The picture chosen for this passage is no longer available."
              />
            </div>
            {bodyFor(
              cn(typesetClassName(typeset), constrained && "mx-auto", centreBody && "text-center")
            )}
          </Reveal>
        </div>
      </section>
    );
  }

  // ── Text alone ──────────────────────────────────────────────────────────────
  //
  // Also where a with-picture arrangement lands while NEITHER picture field is set: it collapses to
  // its text-alone counterpart (see the header), which is what an editor sees between choosing the
  // arrangement and choosing the picture.
  //
  // ⚠ THE "left" PATH BELOW IS TODAY'S RENDERING TO THE BYTE. `placement` is "mx-auto", `centreBody`
  // is false and the falsy `cn()` entries drop out, so every class string is exactly what this file
  // wrote before `layout` existed. Compare against the git history before changing anything here.
  const placement = layout === "right" || layout === "text-right-media-left" ? "ml-auto" : "mx-auto";

  /**
   * The measure travels with anything that stands over the text.
   *
   * The placement is a consequence of the measure rather than a separate decision: a column narrower
   * than its container has to be put somewhere — centred for the arrangements that read as today, at
   * the container's end for "right". A block whose measure is "fill the column" is already as wide as
   * its container, so there is nothing to place and no class is written.
   */
  const columnClass = cn(typesetMeasureClassName(typeset), constrained && placement);

  const headingAlign: "start" | "center" =
    layout === "left"
      ? data.alignment === "center"
        ? "center"
        : "start"
      : centred
        ? "center"
        : "start";

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      {/* Only the "left" arrangement reads `alignment` — it is that arrangement's own control, and
          every other arrangement sets its text flush left (or centres it piecewise, above). */}
      <div
        className={cn(
          narrow ? "shell-narrow" : "shell",
          layout === "left" ? ALIGN_CLASS[data.alignment] : "text-left"
        )}
      >
        {/*
          One reveal around the whole passage rather than one for the heading and another for the
          body: a heading that arrives ahead of its own first sentence reads as two blocks, which is
          the opposite of what this one is. The measure and the centring stay on the children, so the
          inline transform this writes has nothing to collide with.
        */}
        <Reveal amount="some">
          {headingFor(headingAlign, columnClass)}
          {bodyFor(
            cn(typesetClassName(typeset), constrained && placement, centreBody && "text-center")
          )}
        </Reveal>
      </div>
    </section>
  );
}
