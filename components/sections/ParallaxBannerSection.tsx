/**
 * ParallaxBannerSection — one photograph across the whole window, a line of writing on it, and the
 * picture travelling a little more slowly than the page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ARCHITECTURE, WHICH IS THE SAME ARCHITECTURE AS THE OTHER NARRATIVE BLOCKS.
 *
 * This is a SERVER COMPONENT. The eyebrow, the heading, the sentence, the button and the photograph
 * are all rendered here and arrive in the HTML — indexed by a crawler, readable with JavaScript
 * switched off, and never serialised into a client props payload. `ParallaxStage` is a wrapper of a
 * couple of dozen lines that adds ONE scrubbed tween and owns no content at all.
 *
 * ⚠ EVERYTHING IS ALREADY IN ITS FINAL, READABLE POSITION IN THE HTML. GSAP only scrubs the
 * photograph's drift; it never reveals anything. There is no `opacity: 0` waiting to be rescued, so a
 * failed animation chunk, a reader who has asked for less motion and a reader with no JavaScript at
 * all each get the same finished band: a photograph with a heading on it. The entrance of the words
 * is `Reveal`, which is framer's job and not GSAP's (see components/motion/gsap/runtime.ts).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * FULL BLEED IS THE ABSENCE OF `.shell`, NOT A NEGATIVE MARGIN. `.shell` is a max-84rem column that
 * every other block opens with; a band that runs to both edges of the window is simply a section that
 * does not open one, and it carries its own `.shell` INSIDE for the words so that the writing still
 * lines up with the column above and below it. `<main>` adds no horizontal padding of its own
 * (contract §7), so there is nothing to break out of and nothing to pay back.
 *
 * ⚠ THE TYPE ON THE BAND IS WHITE IN BOTH THEMES AND MUST NOT GO THROUGH THE `ink-*` LADDER. The
 * usual rule — never hardcode a neutral, every grey inverts — exists because a page's ground inverts
 * under `[data-theme="dark"]`. A photograph does not: it is the same photograph in both themes, so
 * type over it that inverted would be black-on-dark half the time. Same reasoning as the hero's white
 * headline, and the same narrow allowance.
 *
 * ⚠ THE SCRIM IS A LICENCE TO PUT WORDS OVER AN UNKNOWN PICTURE, NOT DECORATION. An editor choosing a
 * photograph is not thinking about the WCAG contrast of white type over its lower left quarter, and
 * the photograph can be changed later by somebody who is not thinking about it either. So the default
 * lays a gradient under the words — a gradient, rising from the foot of the band where the words sit,
 * rather than a flat wash that would grey out the whole picture — and the "no scrim" setting still
 * puts a shadow behind the glyphs, because "none" must mean "no veil over the photograph" and never
 * "the heading is now the same colour as the sky in it".
 */

import { ArrowRight } from "lucide-react";
import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { ParallaxStage } from "@/components/sections/story/ParallaxStage";
import { StoryPicture } from "@/components/sections/story/StoryPicture";
import { LinkButton } from "@/components/ui/Button";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { ParallaxBannerSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface ParallaxBannerSectionProps {
  data: ParallaxBannerSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. */
  resolved?: ResolvedSectionData;
}

type BannerHeight = ParallaxBannerSectionData["height"];
type BannerOverlay = ParallaxBannerSectionData["overlay"];
type BannerAlign = ParallaxBannerSectionData["align"];

/**
 * Complete literal class strings for every height, never assembled from the payload — a
 * `min-h-[${x}]` is invisible to the content scanner and is purged (contract §5).
 *
 * ⚠ `screen` IS DECLARED TWICE ON PURPOSE — the same SHAPE of progressive enhancement `.nav-sheet`
 * makes in globals.css (contract §14), and deliberately not the same unit. `100vh` on a phone is the
 * height of the window with the address bar HIDDEN, so a band sized in it is taller than the screen
 * until the reader has scrolled — and then the bar slides away mid-gesture and everything below the
 * band jumps. `svh` is the SMALLEST viewport height, address bar showing, which never changes while
 * the reader scrolls; the `@supports` test means a browser too old to know the unit still gets a
 * full-screen band rather than no height at all.
 *
 * The sheet takes `dvh` and this takes `svh` because they want opposite things from the same fact.
 * A menu panel is transient and should always fit the window as it is NOW, so it wants the height
 * that tracks the address bar. A band is scrolled PAST, and a height that tracks the address bar
 * would grow the band mid-gesture and drag the rest of the page under the reader's thumb — which is
 * the very jump `vh` causes, arriving by the opposite route.
 *
 * The other two are fixed rem heights, so nothing about them depends on the viewport at all.
 */
const HEIGHT_CLASS: Record<BannerHeight, string> = {
  md: "min-h-[20rem] sm:min-h-[24rem]",
  lg: "min-h-[26rem] sm:min-h-[32rem] lg:min-h-[36rem]",
  screen: "min-h-[100vh] supports-[height:100svh]:min-h-[100svh]"
};

/**
 * The scrim, as a gradient rising from the foot of the band.
 *
 * It is `purple-950` rather than black because that is the ground the hero already lays over a
 * photograph, and one photographic ground colour across the site is worth more than the two or three
 * percent of extra darkness a neutral would buy. Neither shade inverts, which is the point.
 *
 * The words are anchored to the bottom of the band whatever `align` says about their horizontal
 * position, so a vertical gradient is always underneath them — there is no alignment for which this
 * is a scrim over the wrong part of the picture.
 */
const SCRIM_CLASS: Record<BannerOverlay, string> = {
  scrim: "bg-gradient-to-t from-purple-950/85 via-purple-950/40 to-transparent",
  deep: "bg-gradient-to-t from-purple-950/95 via-purple-950/70 to-purple-950/25",
  none: ""
};

/**
 * What "none" still owes the reader.
 *
 * A shadow on the glyphs costs the photograph nothing — it darkens the two or three millimetres
 * immediately behind each stroke rather than the picture — and it is the difference between a heading
 * that is merely hard to read over a pale sky and one that is not there at all. The other two
 * settings do not carry it: over a scrim it would only make the type look smudged.
 */
const NO_SCRIM_TEXT_SHADOW = "[text-shadow:0_2px_14px_rgba(0,0,0,0.55)]";

/** The words' own column. Complete literal strings, one per alignment (contract §5). */
const ALIGN_CLASS: Record<BannerAlign, string> = {
  left: "items-start text-left",
  center: "mx-auto items-center text-center",
  right: "ml-auto items-end text-right"
};

export function ParallaxBannerSection({ data, section, resolved }: ParallaxBannerSectionProps) {
  const eyebrow = data.eyebrow.trim();
  const heading = data.heading.trim();
  const body = data.body.trim();
  const action = data.cta.label && data.cta.href ? data.cta : null;

  /*
   * ⚠ THE OVERSCAN IS PART OF THE DRIFT AND MUST SWITCH OFF WITH IT. `parallax` is not "animate this"
   * — it is "draw this 18% larger than its frame so a tween has somewhere to travel", plus a
   * `will-change: transform` that promotes the picture to its own compositor layer. At `speed: 0` the
   * schema promises "a plain photograph", and passing the marker anyway delivers the opposite: a crop
   * 18% tighter than the one the editor chose (the top and bottom of their photograph gone), for a
   * tween `ParallaxStage` then declines to build, on a layer nothing will ever write to.
   */
  const drifts = data.speed > 0;

  const hasWords = Boolean(eyebrow || heading || body || action);
  const hasPicture = Boolean(data.mediaId.trim() || data.craftImage.trim());

  /*
   * Nothing configured anywhere: no picture named and not a word written. A band with neither is not
   * an empty state worth stating — it is a block an editor added and then emptied, and drawing a
   * screen-high indigo panel to announce it would be shouting.
   *
   * Note what this does NOT return null for. A picture NAMED but not RESOLVED — an asset deleted from
   * the library, a manifest slug retired by a later run of the fetcher — still renders, because
   * `StoryPicture` states that absence in so many words and an editor who cannot see that the
   * photograph is missing cannot put it back (contract §1.6).
   */
  if (!hasWords && !hasPicture) return null;

  return (
    <section
      id={`s-${section.id}`}
      data-anchor=""
      // No bottom padding. The credit a bundled photograph carries is laid OVER the foot of the band
      // (`creditOverlay` below) rather than under it, so there is no strip to reserve and one band can
      // meet the next without a gap.
    >
      <ParallaxStage
        speed={data.speed}
        className={cn(
          // `isolate` gives the picture, the scrim and the words a stacking context of their own, so
          // painting order is DOM order and no z-index has to be invented for them (contract §6).
          //
          // `bg-purple-950` is the ground the picture is laid on. It is visible only in the moment
          // before a photograph decodes, which is precisely when a band of the page background would
          // read as a hole.
          "relative isolate flex w-full items-end bg-purple-950",
          HEIGHT_CLASS[data.height]
        )}
      >
        {/*
          THE PHOTOGRAPH. `data-parallax-figure` is what `ParallaxStage` finds it by; it is a contract
          between these two files and not a styling hook.

          The layer is absolute so the band's height comes from `HEIGHT_CLASS` and never from the
          picture's own proportions — a banner is a shape the editor chose, not a shape the photograph
          brought with it.
        */}
        <div data-parallax-figure className="absolute inset-0">
          <StoryPicture
            mediaId={data.mediaId}
            craftSlug={data.craftImage}
            resolved={resolved}
            // A ratio is what puts BOTH sources into `fill` + `object-cover` mode; the frame's height
            // then comes from the band, since an explicit height beats `aspect-ratio` in CSS. Without
            // it a craft photograph renders at its own intrinsic height and a 3:2 picture at 100vw is
            // half as tall again as an `lg` band.
            aspect="16 / 9"
            sizes="100vw"
            parallax={drifts}
            // THE CREDIT GOES ON THE PHOTOGRAPH. A band that spans the window has no "under" — the
            // strip below it is the page's own ground, where a credit reads as belonging to whatever
            // comes next. `CraftPhoto` carries its own scrim for this, which matters because the
            // photograph underneath can be any colour at all.
            //
            // It cannot collide with the band's own words: those sit in a `.shell` with `pb-12`
            // (`md:pb-16`), so they stop 48–64px above the foot, while the credit occupies roughly
            // the bottom 30px. That holds at every `align`, including `right`.
            creditOverlay
            className={cn(
              "h-full w-full",
              // ⚠ THE FRAME IS FLATTENED FROM OUT HERE, and these are the only classes in this file
              // that reach into another component's markup. `StoryPicture` frames a picture for
              // a COLUMN — 16px of radius, a hairline and a shadow — which is right in a story
              // chapter and wrong on a band that runs to both edges of the window, where the radius
              // shows the ground through four corners and the hairline draws a box round the whole
              // screen. `!` because `cn()` is a plain join and one utility cannot beat another on
              // source order alone (contract §5). If the frame stops being the figure's only element
              // child the picture reverts to looking like a very wide card, which is a soft landing.
              "[&>div]:h-full [&>div]:!rounded-none [&>div]:!border-0 [&>div]:!shadow-none"
            )}
            emptyLabel="No photograph has been chosen for this banner yet."
          />
        </div>

        {/*
          The scrim. `aria-hidden` because it says nothing — it is a contrast device — and transparent
          to the pointer so that a sheet of glass across the whole band can never be the thing a click
          lands on. It stops at the foot of the band, so the credit line beneath is not veiled by it.
        */}
        {SCRIM_CLASS[data.overlay] ? (
          <div
            aria-hidden="true"
            className={cn("pointer-events-none absolute inset-0", SCRIM_CLASS[data.overlay])}
          />
        ) : null}

        {hasWords ? (
          // `relative`, so the words paint above the two absolute layers by DOM order alone.
          <div className="shell relative w-full pb-12 pt-20 md:pb-16 md:pt-28">
            <Reveal
              className={cn(
                "flex max-w-3xl flex-col",
                ALIGN_CLASS[data.align],
                data.overlay === "none" && NO_SCRIM_TEXT_SHADOW
              )}
              // Shorter than the default 24px: the band is often most of the screen, so the words are
              // already in view when the reveal fires and a long travel reads as the heading settling
              // late rather than as it arriving.
              distance={16}
            >
              {eyebrow ? (
                // `.eyebrow` is purple-700, which has nothing to sit against on a photograph. A
                // utility beats a `@layer components` recipe whatever the order of the class string
                // (contract §5), so no `!` is needed here. White rather than the hero's gold: gold is
                // the hero's own allowance and is spent nowhere else on the public site (§1.1).
                <p className="eyebrow text-white/85">{eyebrow}</p>
              ) : null}

              {heading ? (
                // An `<h2>`: the band is a section of the page, a peer of every other block's
                // heading, and never the page's `<h1>` — that belongs to the page or to the hero.
                <h2
                  className={cn(
                    "display-title text-balance text-3xl text-white sm:text-4xl md:text-5xl",
                    eyebrow && "mt-3"
                  )}
                >
                  {heading}
                </h2>
              ) : null}

              {body ? (
                <p
                  className={cn(
                    "max-w-2xl text-base leading-relaxed text-white/80 sm:text-lg",
                    (eyebrow || heading) && "mt-4"
                  )}
                >
                  {body}
                </p>
              ) : null}

              {action ? (
                <div
                  className={cn(
                    eyebrow || heading || body ? "mt-8" : undefined,
                    // The shadow above is inherited, and a button is not type over a photograph — it
                    // is a white plate with purple words on it, where a black glow under the label
                    // reads as a printing fault.
                    data.overlay === "none" && "[text-shadow:none]"
                  )}
                >
                  <LinkButton
                    href={action.href}
                    icon={ArrowRight}
                    iconPosition="end"
                    // The purple fill has nothing to sit against on a photograph, so the action
                    // inverts — the same swap, for the same reason, that the hero makes over its own
                    // dark ground. It does not invert with the theme because the band does not.
                    className="!bg-white !text-purple-800 hover:!bg-purple-50 hover:!shadow-none"
                  >
                    {action.label}
                  </LinkButton>
                </div>
              ) : null}
            </Reveal>
          </div>
        ) : null}
      </ParallaxStage>
    </section>
  );
}
