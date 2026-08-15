/**
 * StoryScrollSection — chapters of writing, each with a photograph that waits while its words go by.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURE, WHICH IS THE INTERESTING PART OF THIS BLOCK.
 *
 * This is a SERVER COMPONENT. Every word of the story, every heading and every photograph is
 * rendered here and arrives in the HTML — indexed by a crawler, readable with JavaScript switched
 * off, and never serialised into a client props payload. `StoryStage` is a nine-line client wrapper
 * around it that adds three scrubbed animations and owns no content at all.
 *
 * **The effect that makes the block worth having is CSS.** Each chapter's figure is
 * `position: sticky` inside its own chapter, so the photograph holds still while that chapter's
 * paragraphs scroll past and is then carried away by the next chapter arriving underneath it. No
 * JavaScript is involved in that, which is why the block degrades to something genuinely good rather
 * than to a pile of overlapping text.
 *
 * ⚠ THE ALTERNATIVE — one pinned container, chapters stacked on top of one another, cross-faded by
 * scroll position — was deliberately NOT built. It looks the same when it works. When the GSAP chunk
 * fails, or the reader has asked for less motion, or a `ResizeObserver` fires at the wrong moment, it
 * is every chapter of the story printed on top of every other chapter. That failure mode is not
 * worth the identical success mode.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ ON A NARROW SCREEN NOTHING STICKS AND THE PHOTOGRAPH COMES FIRST, whatever `side` says — the
 * same rule `MediaSplitSection` follows and for the same reason: stacked, a text-then-image order
 * puts a viewport of prose between a caption and the picture it describes. Sticky is `lg:` and up,
 * where both halves are on screen together.
 *
 * ⚠ THE PROGRESS RAIL IS NEVER THE ONLY SIGNAL. It is `aria-hidden` decoration; the chapter's
 * position is also written as "Chapter 2 of 5" in text, which is what a screen-reader user gets,
 * what a reduced-motion reader gets (the rail never fills for them, because `StoryStage` builds no
 * animation at all), and what anybody gets if the animation library never arrives. Contract §1.5.
 */

import { ArrowRight } from "lucide-react";
import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { CinematicScroll } from "@/components/sections/story/CinematicScroll";
import { StoryPicture } from "@/components/sections/story/StoryPicture";
import { StoryStage } from "@/components/sections/story/StoryStage";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { StoryScrollSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface StoryScrollSectionProps {
  data: StoryScrollSectionData;
  section: PageSection;
  resolved?: ResolvedSectionData;
}

/**
 * The chapter body, as paragraphs.
 *
 * A blank line is a paragraph break — the convention every plain-text field on the site uses, and
 * the one an editor produces without being told. `filter(Boolean)` because a run of three newlines
 * would otherwise render an empty `<p>`, which is a gap in the rhythm of the column with nothing in
 * it.
 */
function paragraphsOf(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function StoryScrollSection({ data, section, resolved }: StoryScrollSectionProps) {
  /*
   * The cinematic presentation replaces this block's whole rendering with the Centre's authored
   * scroll story — see the schema's `presentation` field and CinematicScroll's header for why its
   * words are code rather than the chapter fields. The chapter data stays in the row untouched, so
   * switching back in the studio restores the ordinary story exactly as it was.
   */
  if (data.presentation === "cinematic") {
    return <CinematicScroll section={section} />;
  }

  const chapters = data.chapters;

  // A story with no chapters is a heading and nothing else. The heading is still worth rendering —
  // an editor who has written it and not yet added a chapter should see their heading on the page,
  // not an absence they cannot distinguish from a broken block — but with neither heading nor
  // chapters there is nothing to draw at all.
  if (chapters.length === 0 && !data.heading && !data.eyebrow && !data.body) return null;

  const mediaFirstOnWide = data.side === "left";
  const showProgress = data.showProgress && chapters.length > 1;

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {data.eyebrow || data.heading || data.body ? (
          <Reveal className="mx-auto max-w-3xl text-center">
            {data.eyebrow ? <p className="eyebrow">{data.eyebrow}</p> : null}
            {data.heading ? (
              <h2 className={cn("display-title text-balance text-3xl sm:text-4xl", data.eyebrow && "mt-3")}>
                {data.heading}
              </h2>
            ) : null}
            {data.body ? (
              <p className="mt-5 text-base leading-relaxed text-ink-700">{data.body}</p>
            ) : null}
          </Reveal>
        ) : null}

        {chapters.length === 0 ? null : (
          <StoryStage>
            {/*
              `<ol>` because the chapters are ordered and a screen reader should say so — "list, 5
              items" and then "1 of 5" as the reader moves through it. A `<div>` here would throw
              away the one piece of structure this block is entirely made of.
            */}
            <ol className={cn("relative mt-16 md:mt-20", showProgress && "md:pl-12")}>
              {showProgress ? (
                /*
                  The rail. `aria-hidden` because everything it says is also said in words below, and
                  a decorative line announced as "graphic" between every chapter would be noise.

                  Hidden below `md`: a vertical rail down the side of a phone costs 3rem of a 390px
                  screen to draw a line whose whole job is to relate two columns that, at that width,
                  are one column.
                */
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-3 left-[9px] top-3 hidden w-px bg-line-200 md:block"
                >
                  <div
                    data-story-progress-fill
                    // `origin-top` + `scale-y-0`: the resting state is an EMPTY rail, which is what a
                    // reader with no JavaScript and a reader with reduced motion both get, and it is
                    // honest — nothing has been read yet. Scaling rather than animating `height`
                    // keeps this off the layout path entirely.
                    className="h-full w-full origin-top scale-y-0 bg-purple-700"
                  />
                </div>
              ) : null}

              {chapters.map((chapter, index) => {
                const paragraphs = paragraphsOf(chapter.body);
                const hasLink = Boolean(chapter.href && chapter.ctaLabel);

                return (
                  <li
                    // Index-keyed deliberately. These rows carry no identity of their own — there is
                    // no id in the payload — and they are reordered only by an editor rewriting the
                    // array, which re-renders the whole block anyway. A key built from the title
                    // would collide the moment two chapters were called the same thing.
                    key={index}
                    data-story-chapter={index}
                    className={cn("relative", index > 0 && "mt-20 md:mt-28")}
                  >
                    {showProgress ? (
                      <span
                        data-story-mark={index}
                        aria-hidden="true"
                        // The filled state is a CLASS that `StoryStage` toggles, not a tween, so the
                        // appearance lives in this file with the rest of the styling and the
                        // animation file says only WHEN.
                        className="absolute -left-12 top-1.5 hidden h-[18px] w-[18px] rounded-full border-2 border-line-200 bg-bg-0 transition-colors duration-300 ease-out [&.is-reached]:border-purple-700 [&.is-reached]:bg-purple-700 md:block"
                      />
                    ) : null}

                    <div className="grid items-start gap-8 lg:grid-cols-2 lg:gap-14">
                      <Reveal
                        className={cn("order-1", !mediaFirstOnWide && "lg:order-2")}
                        // Each chapter's photograph reveals as it arrives rather than all of them at
                        // once — `Reveal` is per-element and `once`, so a long story does not
                        // accumulate observers.
                        distance={16}
                      >
                        <div
                          data-story-figure
                          // THE STICKY, and the whole reason this block reads the way it does.
                          // `--nav-clearance` is the one number the floating header's height lives
                          // in (globals.css); adding to it here rather than restating it means the
                          // photograph follows the header if the header ever changes.
                          className="lg:sticky lg:top-[calc(var(--nav-clearance)+1.5rem)]"
                        >
                          <StoryPicture
                            mediaId={chapter.mediaId}
                            craftSlug={chapter.craftImage}
                            resolved={resolved}
                            aspect="4 / 5"
                            sizes="(min-width: 1024px) 36rem, 100vw"
                            caption={chapter.caption || undefined}
                            parallax
                            emptyLabel="No photograph has been chosen for this chapter yet."
                          />
                        </div>
                      </Reveal>

                      <Reveal
                        className={cn(
                          "order-2 lg:min-h-[60vh]",
                          !mediaFirstOnWide && "lg:order-1"
                        )}
                        distance={16}
                      >
                        {/*
                          The count, in words, and NOT `aria-hidden`. This is the static half of the
                          progress signal: the rail and the marks are motion, and a reader who never
                          sees motion still needs to know where they are in the story.
                        */}
                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-500">
                          Chapter {index + 1} of {chapters.length}
                          {chapter.kicker ? (
                            <>
                              <span aria-hidden="true"> · </span>
                              <span className="text-purple-700">{chapter.kicker}</span>
                            </>
                          ) : null}
                        </p>

                        {chapter.title ? (
                          // Level 3: the block's own `heading` above is the `<h2>`, so a chapter is a
                          // rung below it. Where the block has no heading this still cannot be an
                          // `<h2>` — the PAGE may have other `<h2>`s and a chapter is not their peer.
                          <h3 className="display-title mt-3 text-balance text-2xl sm:text-3xl">
                            {chapter.title}
                          </h3>
                        ) : null}

                        {paragraphs.length > 0 ? (
                          <div className="prose-measure mt-5 space-y-4">
                            {paragraphs.map((paragraph, paragraphIndex) => (
                              <p key={paragraphIndex} className="text-base leading-relaxed text-ink-700">
                                {paragraph}
                              </p>
                            ))}
                          </div>
                        ) : null}

                        {hasLink ? (
                          <a
                            href={chapter.href}
                            className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-purple-700 underline decoration-purple-300 underline-offset-4 transition hover:decoration-purple-700"
                          >
                            {chapter.ctaLabel}
                            <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
                          </a>
                        ) : null}
                      </Reveal>
                    </div>
                  </li>
                );
              })}
            </ol>
          </StoryStage>
        )}
      </div>
    </section>
  );
}
