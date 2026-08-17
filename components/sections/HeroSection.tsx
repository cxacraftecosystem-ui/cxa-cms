"use client";

/**
 * HeroSection — the cinematic opening of a page, and the first thing anyone sees.
 *
 * It is a CLIENT component for four reasons and only four: the pointer-tracked wash, the scroll
 * parallax behind it, the capability probe that decides whether a WebGL canvas may run at all, and
 * the GSAP word reveal that `hero/HeroHeadline.tsx` owns. Everything it draws is otherwise static
 * markup, and everything it needs from the database arrives as a prop — a hero that queried for its
 * own backdrop would be a second round trip on the one view where time to first paint matters most.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE LAYER STACK, FOUR BACKDROPS — AND THE PREVIOUS VERSION HAD TWO OF EACH
 *
 * What this file used to do was branch: a photographic hero got the editor's picture and a flat
 * purple wash, and a drawn hero got the mesh, the tapestry, the pointer light and the pigment. Two
 * compositions, sharing a type ladder and nothing else, and an administrator who picked a photograph
 * lost every one of the Centre's own motifs in the process. Worse, the drawn one had no photography in
 * it at all — on a site whose subject is twenty-six documented craft traditions — so it came out as a
 * flat purple lattice with a sentence on it.
 *
 * There is now ONE stack, and only the picture in slot 2 changes. Back to front:
 *
 *   1. **The ground** — `bg-purple-950` on the section, carrying `.noise`, whose very low alpha grain
 *      is what stops a large flat gradient from banding on an 8-bit panel.
 *   2. **The picture, AND ONLY WHERE AN EDITOR CHOSE ONE.** The editor's image, or the editor's film
 *      over its own poster frame. There is no third case: a curated photograph from the craft manifest
 *      used to fill this slot on every other hero and it has been RETIRED — see `CURATED` below. So a
 *      hero nobody has given a picture to has no slot 2 at all, and layers 3 and 4 stand down with it.
 *   3. **The veil** — a flat `purple-950/55` over the whole picture.
 *   4. **The directional scrim** — nearly opaque where the words sit and thin where they do not, so
 *      the picture is only sacrificed in the quarter of the frame that is carrying type. The contrast
 *      arithmetic for both is written out at `SCRIM_CLASS`, and it is arithmetic rather than taste.
 *   5. **The mesh** (`.grad-mesh`) — three soft orbs of coloured light, now over the scrim rather
 *      than only in the drawn hero, so every backdrop keeps the brand's ambient light.
 *   6. **`CraftTapestry`**, parallaxing slowly as the hero scrolls away, and now PIERCED OPEN over
 *      the words by its `focus` prop. It is a sibling component and this file does not know what it
 *      draws; the hero owns the room, the tapestry owns the screen at the window.
 *   7. **The pointer wash** — one large radial gradient following the cursor on `SPRING_POINTER`,
 *      resting at the centre of the frame, and now installed over a photograph too (see below).
 *   8. **The suspended pigment** (`hero/ParticleField.tsx`), on the machines that can afford it.
 *   9. **Two vignettes and a hairline** — the frame of the picture, and the hero's own bottom edge.
 *
 *  10. On top: the content column, and — where the words leave room for it — the SHEET PLATES, two of
 *      the Centre's own contact sheets mounted like objects in a museum case. `SheetPlates`, at the
 *      foot of this file. These are the only pictures a default hero now carries.
 *
 * ⚠ ALL FOUR BACKGROUNDS ARE DARK, in both themes. The type ladder here is therefore the white one in
 * every mode and there is no branch deciding which — same narrow allowance, for the same reason, as
 * `ParallaxBannerSection`: a photograph does not invert, so type over it that inverted would be
 * black-on-dark half the time.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE FOUR BACKGROUNDS, as an editor meets them
 *
 *   particles — everything above, plus a react-three-fiber pigment field, dynamically imported with
 *               `ssr: false` so three.js is never in the bundle of a page that does not use it. The
 *               canvas is refused outright under reduced motion, on a coarse pointer, on a machine
 *               reporting few cores or little memory, and where WebGL cannot be had. Every refusal
 *               falls back to `gradient`, which is a FINISHED DESIGN and not a degradation.
 *   gradient  — the tapestry at FULL strength, the mesh and the light, with the vitrine's two contact
 *               sheets carrying the photography. Needs no media, and is now the commonest hero on the
 *               site rather than the fallback it reads as.
 *   image     — the editor's asset in slot 2 instead. The sheet plates stand down: when somebody has
 *               chosen a photograph, that photograph is the hero and a vitrine over it is clutter.
 *   video     — the same, autoplaying muted, over a still frame drawn from the asset's own derivatives.
 *               Under reduced motion the film is not mounted and THE STILL IS WHAT REMAINS, which is a
 *               considerably better hero than the empty indigo panel that used to be there.
 *
 * ⚠ THE POINTER WASH NOW RUNS OVER PHOTOGRAPHS, WHICH REVERSES A DELIBERATE DECISION. The note that
 * used to sit here said the light was withheld from a photographic hero because the only thing
 * guaranteeing white type's contrast was a flat wash of known opacity, and a moving warm patch on top
 * would make that contrast depend on where the reader's hand happened to be. That was correct about
 * the old flat wash and is not correct about the layered scrim, for two reasons. First, under the
 * words the scrim now composites to about 0.95 of `purple-950`, so what the light plays over is
 * effectively the brand's own ground rather than an unknown picture. Second, the wash's own stops are
 * DARKER than white type by a wide margin and barely move the ground at all: gold-500 at 0.17 alpha
 * over `purple-950` lands near relative luminance 0.041, against the ground's own 0.046 — the light
 * reads as warmth, not as brightness, and the worst case it can produce is a fraction of a stop. The
 * hero was the only surface on the site where the pointer meant anything, and half the site's heroes
 * were not getting it.
 *
 * ⚠ AND EXACTLY ONE OTHER LAYER MAY ANSWER THE POINTER AT A TIME. Giving the wash to every backdrop
 * made the count worse, not better: three separate reactive layers on one surface, driven by three
 * `window` listeners and six springs. `CraftTapestry` is now handed `interactive` only where the
 * particle field is NOT running, so a reader moving the cursor across the hero drives the wash plus
 * one depth cue rather than the wash plus two. The full argument, and what is deliberately not cut,
 * is at the `CraftTapestry` call site in layer 6.
 *
 * NO TOP PADDING FOR THE HEADER. `.page-top` on `<main>` pays `--nav-clearance` once for the whole
 * site (contract §7). 88vh is 100vh minus that clearance at a typical viewport, so the hero fills the
 * first screen without paying for the header a second time.
 */

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { motion, useScroll, useSpring, useTransform } from "framer-motion";
import { ArrowRight } from "lucide-react";
import type { PageSection } from "@prisma/client";

import { CraftTapestry } from "@/components/craft/CraftTapestry";
import { SPRING_POINTER, STAGGER } from "@/components/motion/constants";
import { RevealNoScriptRescue } from "@/components/motion/Reveal";
import { riseItem, staggerParent } from "@/components/motion/variants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { HeroHeadline } from "@/components/sections/hero/HeroHeadline";
import { HeroStat, type HeroFigure } from "@/components/sections/hero/HeroStat";
import { ScrollCue } from "@/components/sections/hero/ScrollCue";
import { LinkButton } from "@/components/ui/Button";
import { StoryInvite } from "@/components/site/story/StoryInvite";
import { MediaImage } from "@/components/ui/MediaImage";
import { craftSheet, type CraftSheet } from "@/lib/media/craft-sheets";
import { pictureFromMap } from "@/lib/media/screens";
import { pickVariant, publicObjectUrl } from "@/lib/media/url";
import type { MediaRow, ResolvedSectionData } from "@/lib/sections/resolve";
import type { HeroSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

/**
 * three + drei must not sit in the bundle of any page that does not use them, so the canvas is a
 * separate module behind `next/dynamic` with `ssr: false`. The chunk is only ever REQUESTED once the
 * capability probe at the foot of this file has said yes, so a phone that will not run it does not
 * download it either.
 *
 * ⚠ THAT GUARANTEE RESTS ON THE PROBE READING THE MOTION PREFERENCE ITSELF, and it is the one part of
 * this that cannot be delegated. `useReducedMotionPreference()` deliberately answers `false` until
 * after mount, because a prerendered page must not branch its first paint on something the server
 * cannot know — so the effect below runs its FIRST pass with `reduce === false` for every reader,
 * including one whose operating system has asked for less. Gating the element on that value alone
 * would put `<ParticleField />` into the tree for a single render, and `next/dynamic` fires its loader
 * on RENDER rather than in an effect: three.js and @react-three/fiber would already be in flight by
 * the time the second pass removed it, paid for by exactly the reader who asked for less. So the probe
 * reads both halves of the preference synchronously; the `reduce` guard in the effect is what handles
 * a reader who flips the in-app toggle afterwards.
 */
const ParticleField = dynamic(
  () => import("@/components/sections/hero/ParticleField").then((mod) => mod.ParticleField),
  { ssr: false }
);

export interface HeroSectionProps {
  data: HeroSectionData;
  section: PageSection;
  /**
   * The batched read from `lib/sections/resolve.ts`. `resolved.media` is keyed by ASSET id, because
   * one asset is regularly used by several blocks. Optional so a preview that has resolved nothing
   * still renders — with no asset the background falls back to the Centre's own photography rather
   * than to a hole.
   *
   * `import type` only: that module is `server-only`, and a type import is erased entirely.
   */
  resolved?: ResolvedSectionData;
  /**
   * Live figures for the row under the actions — "1,240 crafts documented".
   *
   * NOT part of the block payload, and deliberately so: `lib/sections/schema.ts` has no field for
   * them, and a figure an editor typed by hand would be a figure that goes stale. So these arrive
   * only from a caller that composes the hero itself and can count the rows — `SectionRenderer`
   * passes none, and the row is then simply absent, which is the right answer for a page built in the
   * studio out of blocks.
   *
   * There is no cap here and none is needed: this is a developer-facing prop rather than an editorial
   * list, so contract §1.6 does not apply. Three is as many as the row holds at 390px.
   */
  figures?: readonly HeroFigure[];
}

type Backdrop = HeroSectionData["backgroundKind"];
type Alignment = HeroSectionData["alignment"];

/**
 * Complete literal class strings for every alignment, never built by concatenation — a class assembled
 * from data is purged by the content scanner (contract §5).
 */
const COLUMN_CLASS: Record<Alignment, string> = {
  left: "items-start text-left",
  center: "mx-auto items-center text-center",
  right: "ml-auto items-end text-right"
};

/** The eyebrow's hairline leads the words, so on a right-aligned hero the row reverses. */
const EYEBROW_CLASS: Record<Alignment, string> = {
  left: "flex items-center gap-3",
  center: "flex items-center justify-center gap-3",
  right: "flex flex-row-reverse items-center gap-3"
};

/**
 * The hairline itself, drawn rather than switched on.
 *
 * A flat 1px bar of `gold-500/60` is a dash; a gradient that starts at nothing and arrives at gold is
 * a mark that was made with a tool, which is the whole register this page is written in. It has to
 * flip with the row, because on a right-aligned hero the line leads INTO the words from the right and
 * a gradient pointing the other way reads as a mistake nobody can name.
 */
const EYEBROW_RULE_CLASS: Record<Alignment, string> = {
  left: "h-px w-10 shrink-0 bg-gradient-to-r from-transparent to-gold-500/80",
  center: "h-px w-10 shrink-0 bg-gradient-to-r from-transparent via-gold-500/80 to-transparent",
  right: "h-px w-10 shrink-0 bg-gradient-to-l from-transparent to-gold-500/80"
};

const ACTIONS_CLASS: Record<Alignment, string> = {
  left: "flex flex-wrap items-center gap-3",
  center: "flex flex-wrap items-center justify-center gap-3",
  right: "flex flex-wrap items-center justify-end gap-3"
};

const FIGURES_CLASS: Record<Alignment, string> = {
  left: "flex flex-wrap gap-x-10 gap-y-6",
  center: "flex flex-wrap justify-center gap-x-10 gap-y-6",
  right: "flex flex-wrap justify-end gap-x-10 gap-y-6"
};

/** Each figure's own contents follow the column, so the hairline sits under the right edge of nothing. */
const FIGURE_CLASS: Record<Alignment, string> = {
  left: "items-start",
  center: "items-center",
  right: "items-end"
};

/**
 * THE SCRIM, AND WHY IT IS TWO LAYERS RATHER THAN THE ONE FLAT WASH THAT WAS HERE BEFORE.
 *
 * A photograph can be any colour. The old answer was `bg-purple-950/70` across the whole frame, which
 * is safe and costs the picture everything: at 70% the brightest sky in the library is dragged to the
 * same violet as the darkest, so an editor's photograph arrives as a texture nobody can identify. The
 * answer here is the one `ParallaxBannerSection` reasoned out — put the darkness WHERE THE WORDS ARE —
 * generalised to three alignments.
 *
 * THE ARITHMETIC, because "it looks fine" is not a contrast check. CSS composites in gamma space, so
 * `purple-950` (≈ rgb 53 27 82) at alpha *a* over the worst case (pure white) gives
 * `c = a·c_purple + (1−a)·255` per channel, and white type needs 4.5:1 against the result for body
 * copy (WCAG 1.4.3 — the introduction is 21px regular, which is NOT "large text").
 *
 *   • the flat veil alone, a = 0.55 …………… luminance ≈ 0.20 → 4.2:1  (not enough on its own)
 *   • veil + scrim under the words, a ≈ 0.95 … luminance ≈ 0.05 → 9.9:1  ✓ with two stops to spare
 *   • veil + scrim at the far edge, a ≈ 0.62 … luminance ≈ 0.18 → 4.4:1
 *
 * The far edge is where the picture is allowed to be a picture, and NO TYPE IS EVER PUT THERE: the
 * words are in a column on the words' side, the archive plates carry their own frames, and every
 * photograph's credit chip brings its own scrim (see ImageCredit). If a future block wants a caption
 * out at 62%, it owes its own plate — not a rebalancing of this gradient.
 *
 * `purple-950` rather than black throughout, matching the banner: one photographic ground colour
 * across the site is worth more than the two or three per cent of extra darkness a neutral would buy,
 * and neither inverts.
 */
const SCRIM_CLASS: Record<Alignment, string> = {
  left: "bg-gradient-to-r from-purple-950/90 via-purple-950/55 to-purple-950/20",
  // Centred words sit in the middle BAND of the frame, so the gradient runs top-to-bottom and is
  // heaviest across the middle. A left-to-right ramp would put its darkest edge where nothing is.
  center: "bg-gradient-to-b from-purple-950/45 via-purple-950/90 to-purple-950/55",
  right: "bg-gradient-to-l from-purple-950/90 via-purple-950/55 to-purple-950/20"
};

/**
 * The type scale, in two sizes: one for a hero sharing its width with the archive plates, one for a
 * hero that owns the whole column.
 *
 * Both are written out in full because `cn()` is a plain join and a size assembled from a condition is
 * invisible to the content scanner (contract §5). The difference is real work rather than tidiness: a
 * 84px headline in the 620px column the plates leave behind sets two words to a line and four lines to
 * a headline, which reads as a poster for a different building.
 *
 * The wrap hint differs with the size for the same reason. `text-balance` evens the lines of a SHORT
 * heading and browsers stop applying it past a handful of lines; `text-pretty` is the one that keeps
 * working on the four-line headline a narrow column produces, where the fault to avoid is a last line
 * holding one word.
 */
const HEADLINE_CLASS = {
  withPlates:
    "display-title text-pretty text-[2.4rem] leading-[1.06] text-white sm:text-5xl md:text-6xl lg:text-[3.9rem] lg:leading-[1.03] xl:text-[4.6rem] 2xl:text-[5.25rem] 2xl:leading-[1.0]",
  alone:
    "display-title text-balance text-[2.4rem] leading-[1.06] text-white sm:text-5xl md:text-6xl lg:text-7xl xl:text-[5.25rem] xl:leading-[1.02]",
  /**
   * The LONG tier, for a headline past `LONG_HEADLINE_CHARS`. The Centre's own identity line —
   * "Centre of Excellence for unified AI-enabled craft ecosystem platform", 69 characters — set
   * five display lines at the plate scale and pushed the buttons off a 768-tall laptop entirely.
   * A long headline is a SENTENCE and wants sentence-adjacent scale: these sizes hold it to three
   * lines beside the plates and keep the whole column (eyebrow → buttons) inside one viewport.
   * `text-pretty` in both, because a many-line headline is exactly where `text-balance` gives up.
   */
  withPlatesLong:
    "display-title text-pretty text-[1.9rem] leading-[1.1] text-white sm:text-[2.4rem] md:text-[2.8rem] lg:text-[3rem] lg:leading-[1.07] xl:text-[3.4rem] 2xl:text-[3.8rem]",
  aloneLong:
    "display-title text-pretty text-[1.9rem] leading-[1.1] text-white sm:text-[2.4rem] md:text-[3rem] lg:text-[3.5rem] xl:text-[4rem] xl:leading-[1.06]"
} as const;

/**
 * Where "long" begins. 52 keeps every headline the site shipped with on the big scale ("Research
 * that keeps a craft alive" is 33) and catches the identity line with room for editors to breathe.
 */
const LONG_HEADLINE_CHARS = 52;

/** The words' measure. Narrow beside the plates; the old generous column when it is alone. */
const WORDS_CLASS = {
  withPlates: "max-w-2xl",
  alone: "max-w-4xl lg:max-w-5xl"
} as const;

/**
 * Which side of the grid each column takes.
 *
 * DOM order is words-then-plates in every case, because that is reading order and it is what a screen
 * reader and a keyboard get: the sentence, then the pictures illustrating it. `order-*` moves the
 * plates visually for a right-aligned hero and touches nothing else.
 */
const PLATES_WORDS_ORDER: Record<Alignment, string> = {
  left: "",
  center: "",
  right: "lg:order-2"
};

const PLATES_ORDER: Record<Alignment, string> = {
  left: "",
  center: "",
  right: "lg:order-1"
};

/**
 * THE CENTRE'S OWN CONTACT SHEETS, CURATED BY HAND AND IN PREFERENCE ORDER.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS HERO NO LONGER SHOWS A PHOTOGRAPH THE CENTRE DOES NOT OWN, AND IT NO LONGER HAS A BACKDROP.
 *
 * What used to be here was three slugs out of `lib/media/craft-imagery.ts` — twenty-six photographs
 * licensed from Wikimedia Commons. They were good pictures and they were somebody else's. The Centre
 * has since supplied its own: `lib/media/craft-sheets.ts`, forty-three PLATES covering the nine
 * categories of its taxonomy and the thirty-four subcategories beneath them. Two of them now carry
 * the front page, and the third slot has been retired rather than refilled.
 *
 *   ground     — GONE, on the owner's direction, and its absence is a finished composition rather
 *                than a hole. `hasPicture` therefore goes false on every non-editorial hero, which
 *                stands the veil and the scrim down with it (layers 3 and 4) and hands the frame to
 *                the mesh, the tapestry, the light and the pigment. `CraftTapestry` reads the same
 *                condition through `intensity` and comes up from `quiet` to `full`, so what replaces
 *                the photograph is the Centre's own ornament at full strength — see layer 6.
 *
 *                ⚠ AND A SHEET COULD NOT HAVE TAKEN THE SLOT ANYWAY. It is a mosaic of six to eight
 *                cells: `object-cover` on a phone keeps roughly the central 43% of a 16:9 source, so
 *                the grid would be sliced through the middle of its cells and the cream gutters would
 *                render as grey rules under a 0.55 veil. The manifest's own header says so at length.
 *                Sheets are MOUNTED, at their own proportion, cropping nothing — see `SheetPlates`.
 *
 *   principal  — a CATEGORY plate: the whole of one branch of the taxonomy in one object. The eye
 *                lands here.
 *   inset      — a SUBCATEGORY plate, and deliberately from a DIFFERENT category and a different
 *                material. Two levels of one taxonomy in two pictures is the Centre's entire claim —
 *                that each of nine categories is itself a dozen living traditions — and stating it
 *                this way costs a sentence nobody has to read.
 *
 * ⚠ BOTH LISTS ARE ORDERED AND `craftSheet()` CAN RETURN NULL. The manifest is generated by
 * `scripts/build-craft-sheets.ts` and a plate can be retired by a later run, so a missing first
 * choice falls to the second rather than leaving a hole where a picture was. If a whole list is
 * unresolvable the vitrine is simply absent and the words take the full width, which is the
 * composition a centred hero already uses and is still a finished one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const CURATED = {
  principal: ["textile", "metal", "wood"],
  inset: ["mud-terracotta", "textile-embroidery", "metal-brass", "fibre-cane-bamboo"]
} as const;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE DEPTH LADDER, IN PIXELS OF TRAVEL OVER THE WHOLE OF THE HERO'S EXIT
 *
 * A layer translated by +t while the page scrolls up by S has moved (S − t) across the screen, so a
 * LARGER t is a layer that moves LESS and therefore reads as FURTHER AWAY. That is the rule
 * `CraftTapestry` states in its own header, and adding a photograph behind the tapestry broke it: at
 * the old +120 the ornament out-travelled anything a full-bleed picture can afford, so the drawn
 * layers were parallaxing as though they were behind the photograph they are painted on top of.
 *
 * The tapestry's own four layers are offset from ITS wrapper (jaali +88, block print +52, kolam +26,
 * pigment −16), so the wrapper's figure is a base that every one of them is measured from. Composing
 * the two gives the ladder, furthest first:
 *
 *      +56   the photograph            PICTURE_TRAVEL
 *      +40   the jaali                 −48 + 88   ← the screen at the window, behind the light
 *       +4   the block-printed cloth   −48 + 52
 *        0   THE WORDS                 no transform at all: the reader's own plane
 *      −22   the kolam                 −48 + 26   ← drawn on the ground, at the reader's feet
 *      −64   the pigment               −48 − 16   ← suspended in the air in front of everything
 *
 * ⚠ SO `PARALLAX_TRAVEL` IS NEGATIVE NOW, AND ITS SIGN IS THE WHOLE POINT. The tapestry LEADS the page
 * slightly because it is in front of the picture; only the picture lags it. The range is deliberately
 * small — 120 pixels from top to bottom of the ladder — because this is a background and the reader is
 * meant to feel the separation rather than watch it.
 *
 * The tapestry's wrapper is inset 10rem beyond the section on both edges and the picture is overscanned
 * (below), so no travel in this table can bring an edge into frame.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const PARALLAX_TRAVEL = -48;

const PICTURE_TRAVEL = 56;

/**
 * How much larger than the frame the photograph is drawn, so the travel above has somewhere to go.
 *
 * ⚠ AN OVERSCAN BY SCALE, NOT BY NEGATIVE INSETS, and that is a bandwidth decision rather than a
 * geometric one. Insetting the layer 5rem beyond the section makes it a box whose aspect ratio no
 * longer resembles the viewport's, and `object-cover` then scales the photograph by its HEIGHT: on a
 * 390px phone a picture rendered nearly 1300px wide, while `sizes="100vw"` had told the optimiser to
 * serve 390px of it. Every phone would have got a blurred backdrop. A scale keeps the box exactly the
 * section, so the rendered width is a known constant multiple of the viewport and `sizes` can say so.
 *
 * 1.18 is `CraftPhoto`'s own overscan constant, arrived at there for the same job, and it buys 9% of
 * the hero's height at each end — comfortably more than the 56px of travel at any hero this section can
 * produce. (It only ever has to cover the TOP: the travel is zero while the hero's top edge is at the
 * top of the window and maximal once the hero has left the screen entirely.)
 */
const PICTURE_OVERSCAN = 1.18;

/** What `PICTURE_OVERSCAN` means to the image optimiser, stated once so the two cannot drift apart. */
const PICTURE_SIZES = "120vw";

/**
 * The pointer wash, centred and constant.
 *
 * A module constant rather than an inline literal so it is unmistakably NOT recomputed per frame —
 * which is the whole point of the change described where it is used.
 */
const POINTER_WASH_GRADIENT =
  "radial-gradient(48rem 48rem at 50% 50%, oklch(0.7 0.145 80 / 0.17) 0%, oklch(0.56 0.205 305 / 0.14) 34%, transparent 68%)";

export function HeroSection({ data, section, resolved, figures = [] }: HeroSectionProps) {
  const reduce = useReducedMotionPreference();
  const sectionRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  /**
   * Both start FALSE, so the prerendered markup and the first client render agree with each other for
   * every reader, whatever their device turns out to report. The canvas and the interactive tapestry
   * are then ADDITIONS after hydration rather than replacements of something already painted — which
   * is the whole of the rule in contract §8 about never branching an `initial` state on a public page.
   */
  const [canvasAllowed, setCanvasAllowed] = useState(false);
  const [pointerFine, setPointerFine] = useState(false);

  const asset = data.backgroundMediaId ? resolved?.media[data.backgroundMediaId] : undefined;

  /**
   * The hero's framing, per screen width.
   *
   * ⚠ RESOLVED HERE AND NOT INSIDE `MediaImage`, because the alternate photographs live in the page's
   * own media map — `lib/sections/resolve.ts` fetched them alongside the background id, and this is the
   * first place that has it. `pictureFromMap` owns the lookup rather than a closure written out here: a
   * bucket naming a photograph the map does not hold must INHERIT rather than blank the picture, and that
   * is exactly the rule a hand-rolled `assetOf` gets subtly wrong.
   *
   * With no framing this returns a single band and `MediaImage` renders exactly as it did before the
   * field existed, which is what every hero on the site currently relies on.
   */
  const picture = pictureFromMap(data.backgroundMediaId, data.backgroundMediaScreens, resolved?.media);
  const backdrop = resolveBackdrop(data.backgroundKind, asset);
  /** The editor has given us a picture, so the Centre's own photography stands down. */
  const editorial = backdrop === "image" || backdrop === "video";
  const align = data.alignment;

  /**
   * The curated plates, or nothing.
   *
   * Picked in importance order so the dedupe falls the right way: the plate the eye lands on gets
   * first refusal, and the inset drops to its own next choice rather than the principal losing its
   * subject. The two lists cannot currently collide — one holds category plates and the other
   * subcategory plates — but `takeFirst` still refuses to use one plate twice, because a curator
   * adding a fourth fallback should not have to have noticed that.
   */
  const taken = new Set<string>();
  const principal = editorial ? null : takeFirst(CURATED.principal, taken);
  const inset = editorial ? null : takeFirst(CURATED.inset, taken);

  /**
   * A still frame for the film, drawn from the asset's OWN derivatives.
   *
   * ⚠ `pickVariant`, not `mediaSrc`. `mediaSrc` falls back to the original object when an asset has no
   * variants, and for a video that original is the video: it would be handed to `next/image`, which
   * asks the optimiser to resize an mp4 and gets a 400 back — a broken image icon over the hero. So the
   * still is only claimed to exist when a real image derivative does.
   *
   * It is rendered UNCONDITIONALLY, under the film, for every reader. That is what makes the
   * reduced-motion video hero a finished picture rather than an empty panel, and it does it without
   * branching the first paint on a preference the server cannot know (contract §8): the still is in the
   * prerendered HTML either way, and only the `<video>` on top of it comes and goes.
   */
  const videoStill = backdrop === "video" && asset ? pickVariant(asset, 1600) !== null : false;

  /**
   * Is anything at all painted in slot 2? Drives the veil and the scrim, and — deliberately — it does
   * NOT consult `reduce`. A film that reduced motion declines to mount still leaves its still frame,
   * and even in the one case where nothing is painted (a video with no derivatives, under reduced
   * motion) the veil is only a further darkening of the ground beneath it. A layer that appeared on
   * hydration would be a flash; a layer that is occasionally redundant is a slightly deeper indigo.
   *
   * ⚠ NOW EXACTLY `editorial`, WHICH IS THE CHANGE THAT RETIRED THE BACKDROP. The Centre's own
   * photograph used to be the other way this went true; with `CURATED.ground` gone there is no
   * non-editorial picture left to veil, so a hero nobody has given an image to paints none — and the
   * drawn layers, which were always the fallback, are now the design. `editorial` already implies an
   * asset: `resolveBackdrop` downgrades "image with no image" to `gradient` before this is read.
   */
  const hasPicture = editorial;

  /**
   * The archive plates, and the one rule that decides whether they appear.
   *
   * They need a HALF OF THE FRAME THAT THE WORDS ARE NOT USING, which a left- or right-aligned hero has
   * and a centred one does not. On a centred hero the picture is the full-bleed ground and the type
   * stands in the middle of it — a complete and older composition, not a degraded one — so the plates
   * are simply absent rather than squeezed in beside a column that runs through the middle.
   *
   * That makes the studio's `alignment` field do real compositional work: an administrator who moves
   * the words to one side gets the vitrine, and one who centres them gets the poster. It is the kind of
   * consequence worth writing down, because a future reader will otherwise "fix" the missing plates.
   */
  const plates = principal ? { principal, inset } : null;

  // ── Is there a mouse? ──────────────────────────────────────────────────────
  //
  // A live media query rather than a one-off read: a tablet gains a fine pointer the moment somebody
  // plugs a mouse into it, and losing the wash on the desk while keeping it on the sofa is a stranger
  // experience than never having had it.
  useEffect(() => {
    const query = window.matchMedia?.("(pointer: fine)");
    if (!query) return;
    const read = () => setPointerFine(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  // Two guards for one decision, and neither is redundant. `reduce` is the LIVE one: it re-runs this
  // effect when the reader flips the in-app toggle, so a canvas already on screen is taken away. The
  // probe's own synchronous read is the FIRST one: on the mounting pass `reduce` is still false for
  // everybody, and by the time it corrects itself the chunk would have been requested.
  useEffect(() => {
    if (backdrop !== "particles" || reduce) {
      setCanvasAllowed(false);
      return;
    }
    setCanvasAllowed(canRunParticleField());
  }, [backdrop, reduce]);

  /**
   * React has historically dropped the `muted` attribute across hydration, and an autoplaying video
   * that is not muted is refused outright by every browser — so the property is set imperatively as
   * well. The `play()` rejection is swallowed: a refused autoplay is a still frame, which is fine.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    void video.play().catch(() => undefined);
  }, [backdrop, asset]);

  // ── The parallax ───────────────────────────────────────────────────────────
  //
  // 0 when the hero's top meets the top of the viewport, 1 when its bottom does — so the whole travel
  // is spent while the hero is on its way out and none of it before the reader has touched anything.
  // ONE scroll source feeding two layers, so the picture and the ornament cannot drift out of step.
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"]
  });
  const tapestryY = useTransform(scrollYProgress, [0, 1], [0, PARALLAX_TRAVEL]);
  const pictureY = useTransform(scrollYProgress, [0, 1], [0, PICTURE_TRAVEL]);

  // ── The warm wash ──────────────────────────────────────────────────────────
  //
  // Two springs resting at the centre of the frame, so THE RESTING STATE IS A FINISHED GRADIENT and
  // not an empty state: a reader with no pointer at all — a touch device, a keyboard, a machine whose
  // JavaScript never arrived — gets a centred warm band, which is what the design would have been if
  // it had never followed anything. framer renders a MotionValue's current value into the style
  // attribute during SSR, so that band is in the prerendered HTML rather than appearing on hydration.
  const washX = useSpring(50, SPRING_POINTER);
  const washY = useSpring(50, SPRING_POINTER);
  /**
   * THE WASH IS A TRANSLATED LAYER, NOT A REGENERATED GRADIENT.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ IT USED TO BE A `useMotionTemplate` WRITING `background-image` ON EVERY POINTER FRAME, and that
   * is the largest violation of the transform/opacity rule the motion audit found anywhere.
   * `background-image` is neither: every frame reparsed a 48rem gradient string and REPAINTED THE FULL
   * HERO on the main thread. It ran on top of `ParticleField`'s canvas loop and the tapestry's two
   * pointer-driven transforms, so one movement of the mouse across the hero drove three independent
   * motion systems, one of them a full-layer repaint.
   *
   * The gradient is now a constant, painted once, and the pointer springs drive `x`/`y` — framer's
   * transform shorthands, which compose into a single `translate3d` and are composited on the GPU. The
   * light moves exactly as before and the main thread does nothing.
   *
   * ⚠ WHY TRANSLATING THE LAYER CANNOT UNCOVER AN EDGE, which is the obvious worry with a layer the
   * same size as its parent: the gradient's last stop is `transparent 68%`, so the layer is ALREADY
   * transparent well before its own boundary. Moving it reveals more transparency, never a seam. That
   * is also why the layer does not need to be oversized — an oversized one would need the translation
   * scaled to its size, which is a second number to keep in step for no gain.
   *
   * The range is deliberately identical to the old one: `at 50%` was the rest position, so `value - 50`
   * maps the same 0–100 spring output onto ±50% of the layer, putting the highlight exactly where
   * `at 0%` and `at 100%` used to put it.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const washTranslateX = useTransform(washX, (value) => `${value - 50}%`);
  const washTranslateY = useTransform(washY, (value) => `${value - 50}%`);

  /** Installed only where there is a cursor to follow and only where motion is welcome. */
  const washTracks = pointerFine && !reduce;

  useEffect(() => {
    if (!washTracks) return;

    // Percentages of the VIEWPORT rather than of the section's own box, which is what lets this run
    // without measuring anything: the hero is full-bleed and starts at the top of the page, so the
    // two agree closely for as long as it is on screen — and once it is not, nobody is looking.
    const onPointerMove = (event: PointerEvent) => {
      washX.set((event.clientX / window.innerWidth) * 100);
      washY.set((event.clientY / window.innerHeight) * 100);
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [washTracks, washX, washY]);

  const primary = data.primaryCta.label && data.primaryCta.href ? data.primaryCta : null;
  const secondary = data.secondaryCta.label && data.secondaryCta.href ? data.secondaryCta : null;
  const eyebrow = data.eyebrow.trim();
  const visibleFigures = figures.filter((figure) => Number.isFinite(figure.value) && figure.value > 0);

  /**
   * The scroll cue's own space, reserved on the section.
   *
   * The cue is absolutely positioned at the foot and the content column is vertically centred, so
   * without this the two meet on a short viewport. ONLY THE BOTTOM VARIES — the top padding is the
   * same in both states and now also carries `--bleed-top`, so it is written once in the class list
   * below instead of being duplicated into two alternatives that could drift apart.
   *
   * This still honours the rule that made it two complete alternatives before: `cn()` is a plain
   * join and CSS source order decides between two padding utilities that OVERLAP, so no `py-*`
   * appears here at all and `pt-*` and `pb-*` are kept strictly disjoint (contract §5).
   * ScrollCue.tsx carries the other half of this note.
   */
  const bottomPadding = data.showScrollCue ? "pb-28 md:pb-32" : "pb-16 md:pb-24";

  return (
    <section
      /* A stable hook for anything that must treat the hero as a whole — the print stylesheet
         collapses its viewport height and hides its decorative layers, and neither can be keyed on a
         Tailwind class somebody will change. */
      data-hero=""
      // The splash cursor (components/site/SplashCursor) stands down over the hero's own weather.
      data-splash-off=""
      /* Declares a section that paints EDGE TO EDGE, which is what earns it the header clearance to
         pay inwards instead of `<main>` paying it outwards — the full argument is beside `.page-top`
         in globals.css. The attribute is inert on its own: it only takes effect as `<main>`'s first
         child, so a hero placed further down a page behaves exactly as it always has. */
      data-bleed-top=""
      ref={sectionRef}
      id={`s-${section.id}`}
      data-anchor=""
      // `isolate` gives the backdrop layers a stacking context of their own, so painting order is DOM
      // order and no z-index has to be invented for them (contract §6).
      //
      // ⚠ THE HEIGHT IS DECLARED TWICE, which is the progressive enhancement `.nav-sheet` and the
      // parallax banner both make (contract §14) and not a duplicate. `vh` on a phone is the height of
      // the window with the address bar HIDDEN, so an 88vh hero is a tenth taller than the screen it
      // is meant to fill and the reader's first gesture is a scroll that reveals more indigo. `svh` is
      // the SMALLEST viewport height, bar showing, and never changes mid-gesture.
      //
      // ⚠ `--bleed-top` IS ADDED TO THE HEIGHT AND TO THE TOP PADDING, AND BOTH ARE REQUIRED. The
      // box grows upward by exactly what it pads inward, so the backdrop reaches the top of the
      // viewport while this flex column — which is `items-center`, and would otherwise rise by half
      // the clearance — stays on the pixel it occupied before. Add one without the other and the
      // headline moves. Away from the bleed the variable is `0px` and every `calc()` here collapses
      // to the value it had.
      className={cn(
        "relative isolate flex w-full items-center overflow-hidden bg-purple-950",
        "min-h-[calc(88vh_+_var(--bleed-top))] supports-[height:88svh]:min-h-[calc(88svh_+_var(--bleed-top))]",
        // 2.5/3.5rem, down from 4/6: the box is `items-center`, so the base padding is mostly a
        // floor under short viewports — and at 6rem, a 768-tall laptop gave the words less room
        // than the whitespace. The bleed term is unchanged: the clearance contract in globals.css
        // does not care what the base is, only that the two sides carry the same `--bleed-top`.
        "pt-[calc(2.5rem_+_var(--bleed-top))] md:pt-[calc(3.5rem_+_var(--bleed-top))]",
        bottomPadding
      )}
    >
      {/*
        Every backdrop layer lives in here, and the whole stack is transparent to the pointer so the
        actions above it stay pressable. `CraftTapestry`'s interactive mode follows the cursor from a
        `window` listener the way `ParticleField` does, which is the established pattern in this
        codebase precisely because an ornament must never be able to eat a click.

        `aria-hidden` on the wrapper is also what the print stylesheet keys on to take the whole of the
        atmosphere off paper (`[data-hero] [aria-hidden="true"]`). Everything in here is ornament by
        that definition, INCLUDING an editor's chosen backdrop — which is why the sheet plates are not
        in here: they are content, they are named by the "Pictured" line, and they print.
      */}
      <div aria-hidden="true" className="noise pointer-events-none absolute inset-0">
        {/*
          ── 2. THE PICTURE ───────────────────────────────────────────────────────────────────
          One wrapper, three possible contents, one parallax, one overscan. The box is exactly the
          section and the room for the travel comes from `scale` — see `PICTURE_OVERSCAN` for why that
          is not interchangeable with a negative inset. `y` is the transform framer writes inline, which
          is exactly why nothing in here is centred with a translate utility (contract §8), and the
          scale is a constant it writes once rather than anything that animates.
        */}
        {hasPicture ? (
          <motion.div
            className="absolute inset-0"
            style={{ y: reduce ? 0 : pictureY, scale: PICTURE_OVERSCAN }}
          >
            {backdrop === "image" && asset ? (
              <MediaImage
                media={asset}
                picture={picture}
                alt=""
                aspect="none"
                rounded="none"
                priority
                sizes={PICTURE_SIZES}
                className="h-full w-full"
              />
            ) : null}

            {backdrop === "video" && asset ? (
              <>
                {/*
                  The still gets a positioning wrapper of its own rather than an `!absolute` on
                  `MediaImage`'s frame. That frame is `relative`, and ⚠ `.relative` is defined AFTER
                  `.absolute` in Tailwind's own output — so an `absolute` passed in through `className`
                  loses on source order and the layer would sit in flow, pushing the film below it.
                  `cn()` is a plain join and cannot help (contract §5).
                */}
                {videoStill ? (
                  <div className="absolute inset-0">
                    <MediaImage
                      media={asset}
                      alt=""
                      aspect="none"
                      rounded="none"
                      priority
                      sizes={PICTURE_SIZES}
                      className="h-full w-full"
                    />
                  </div>
                ) : null}

                {/*
                  The ORIGINAL object, never `mediaSrc()`: that helper picks an image derivative when
                  one exists, and a poster frame is not a video. Under reduced motion the element is
                  not mounted at all and the still above is the finished background.
                */}
                {reduce ? null : (
                  <video
                    ref={videoRef}
                    src={publicObjectUrl(asset.objectKey) ?? undefined}
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
              </>
            ) : null}

            {/*
              ⚠ THERE IS NO THIRD BRANCH HERE ANY MORE. A curated photograph of the Centre's used to
              sit under the two above as the non-editorial backdrop; it was licensed from Wikimedia
              Commons and it has been retired rather than replaced — see `CURATED`. `hasPicture` is now
              exactly `editorial`, so this whole wrapper only ever mounts for an image or a film an
              administrator chose, and a hero nobody has given a picture to has no slot 2 at all.
            */}
          </motion.div>
        ) : null}

        {/* ── 3 + 4. THE VEIL AND THE DIRECTIONAL SCRIM. Only where there is a picture to veil. ── */}
        {hasPicture ? (
          <>
            <div className="absolute inset-0 bg-purple-950/55" />
            <div className={cn("absolute inset-0", SCRIM_CLASS[align])} />
          </>
        ) : null}

        {/* ── 5. The mesh, so the indigo is never flat and every backdrop keeps the same light. ── */}
        <div className="grad-mesh absolute inset-0" />

        {/*
          ── 6. THE CENTRE'S MOTIFS ────────────────────────────────────────────────────────────
          Inset well beyond the section on both vertical edges, so the parallax can never bring an edge
          of the motif field into view.

          `quiet` over a photograph and `full` over the drawn ground — the same ornament at the strength
          the layer beneath it can carry — and `focus={align}` is what pierces the lattice open where
          the words are, instead of running it straight through the middle of a sentence. That single
          prop is the difference between architecture and wallpaper; CraftTapestry's header explains it
          at length.

          ══════════════════════════════════════════════════════════════════════════════════════════
          ⚠ `!canvasAllowed` IS A RESTRAINT CUT, NOT A PERFORMANCE ONE, AND IT IS THE ONE TWO SEPARATE
          REVIEWERS ASKED FOR IN THE SAME WORDS.

          One movement of the cursor used to drive THREE independent reactive layers on this one
          surface, through three `window` pointermove listeners and six springs, all on SPRING_POINTER:
          the warm wash above (2 springs), this tapestry's `interactive` mode (2), and ParticleField's
          own field parallax (2). The reader learns everything those three have to say from the first
          of them — "this surface has depth" — and the second and third add cost without adding
          information. That is three things animating where one carries the meaning, which is the
          definition of over-scoring even when every individual piece is cheap and correct.

          `canvasAllowed` is exactly the right condition and it already exists: it is the state that
          says the pigment field is mounted and running. Where it is true, the particles are the
          stronger depth cue of the two — they are suspended in front of everything, so the parallax
          reads as air in the room rather than as the backdrop sliding — and the lattice stands down.
          Where it is false (every photographic or editorial backdrop, and every machine the probe
          refused) the tapestry keeps the pointer, because then it is the only thing that has it.

          ⚠ WHAT IS DELIBERATELY *NOT* CUT: the tapestry's SCROLL parallax, which is untouched by this
          and is where its four layers' depth separation actually lives. Only the pointer response goes.

          ⚠ AND THE ONE-RENDER FLICKER IS ACCOUNTED FOR RATHER THAN ACCIDENTAL. `canvasAllowed` starts
          `false` and the probe corrects it in an effect, so on a machine that will run the canvas this
          prop is `true` for a single commit before going false. Nothing is visible in that window: the
          tapestry's springs rest at zero and its layer wrappers start at a zero transform, so the
          listener is installed and removed having moved nothing. It costs one `addEventListener` and
          one `removeEventListener`, which is the correct price for not branching the FIRST PAINT on a
          capability the server cannot know (contract §8).
          ══════════════════════════════════════════════════════════════════════════════════════════
        */}
        <motion.div
          className="absolute inset-x-0 -bottom-40 -top-40"
          style={{ y: reduce ? 0 : tapestryY }}
        >
          <CraftTapestry
            intensity={editorial ? "quiet" : "full"}
            interactive={pointerFine && !reduce && !canvasAllowed}
            focus={align}
            className="absolute inset-0"
          />
        </motion.div>

        {/*
          ── 7. THE LIGHT ─────────────────────────────────────────────────────────────────────
          Not a fourth gradient recipe (contract §4) — a recipe is a named class in globals.css that
          other files depend on. This is one constant belonging to one element, and its stops are the
          warm and violet lobes of `--grad-mesh` at the alphas that ramp uses.
        */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            x: washTranslateX,
            y: washTranslateY,
            backgroundImage: POINTER_WASH_GRADIENT
          }}
        />

        {canvasAllowed ? <ParticleField className="absolute inset-0" /> : null}

        {/*
          ── 9. THE FRAME ─────────────────────────────────────────────────────────────────────
          Two vignettes and a hairline, and together they are what makes the band read as a plate
          rather than as a screenshot that ran out.

          ⚠ THE FOOT USED TO BE `bg-gradient-to-t from-bg-0`, fading the hero into the page canvas over
          160px, AND THAT IS THE PALE BAND AT THE BOTTOM OF THE SCREENSHOT THIS WORK STARTED FROM. In
          the dark theme it is invisible and harmless; in the light theme it interpolates #f7f6fb into
          deep indigo across a sixth of the hero, which is not a hand-off but fog — and it fogged the
          scroll cue and the credit line along with it. The replacement deepens the foot to full
          `purple-950` instead and closes it with a gold hairline: the hero now ENDS, deliberately, at
          an edge somebody drew. The section beneath it opens on the page's own canvas, which is what
          every other block on the site does.
        */}
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-purple-950/65 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-purple-950 via-purple-950/55 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-gold-500/45 to-transparent" />
      </div>

      <div className="shell relative">
        <div
          className={cn(
            plates
              ? "lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-center lg:gap-12 xl:gap-16"
              : undefined
          )}
        >
          <motion.div
            variants={staggerParent(reduce, STAGGER.loose)}
            initial="hidden"
            animate="visible"
            className={cn(
              "flex flex-col",
              plates ? WORDS_CLASS.withPlates : WORDS_CLASS.alone,
              plates ? PLATES_WORDS_ORDER[align] : undefined,
              COLUMN_CLASS[align]
            )}
          >
            {eyebrow ? (
              // `data-reveal` on every element `riseItem` drives, and the `<noscript>` rescue at the
              // foot of this column. The hidden variant is `opacity: 0` and framer writes it into the
              // prerendered markup as an inline style, so without this the whole content column — every
              // word except the headline, which rescues itself — is a blank screen for a reader whose
              // JavaScript never arrives. One attribute serves both mechanisms; see Reveal.tsx.
              <motion.p
                data-reveal=""
                variants={riseItem(reduce, 16)}
                className={EYEBROW_CLASS[align]}
              >
                <span aria-hidden="true" className={EYEBROW_RULE_CLASS[align]} />
                {/* `.eyebrow` is purple-700, which is invisible on this ground; gold is the hero's own
                    allowance and the only place on the public site it is spent (contract §1.1). The
                    tracking is opened from the recipe's 0.14em because these are 13px capitals over a
                    photograph, where letters set tight read as a smudge rather than as a line. No `!`
                    on either: a utility already beats a `@layer components` recipe whatever order the
                    class string puts them in (contract §5). */}
                <span className="eyebrow tracking-[0.2em] text-gold-300">{eyebrow}</span>
              </motion.p>
            ) : null}

            {/*
              The headline is its own component because the GSAP timeline and the per-word split are
              one mechanism with one set of reasons. (It used to own a third: an embroidered gold
              thread drawn under the accent phrase. That is gone — under an accent this long it read
              as an underline, which in a heading reads as a link. HeroHeadline's header carries the
              full argument.) It renders NOTHING when the headline is empty, which is the same answer
              `sectionsOwnPageTitle` gives in SectionRenderer.tsx — the two must agree or a page ends
              up with no `<h1>` at all.
            */}
            <HeroHeadline
              headline={data.headline}
              accent={data.headlineAccent}
              className={cn(
                data.headline.length > LONG_HEADLINE_CHARS
                  ? plates
                    ? HEADLINE_CLASS.withPlatesLong
                    : HEADLINE_CLASS.aloneLong
                  : plates
                    ? HEADLINE_CLASS.withPlates
                    : HEADLINE_CLASS.alone,
                eyebrow && "mt-5"
              )}
            />

            {data.body ? (
              // A `ch` measure rather than a `rem` one: the job is to stop a line running past the
              // length an eye can track back from, and that length is counted in characters. 54ch at
              // this size is roughly the 34rem the old `max-w-2xl` gave, and stays right if the type
              // scale or the larger-text preference moves it.
              <motion.p
                data-reveal=""
                variants={riseItem(reduce)}
                className="mt-6 max-w-[54ch] text-lg leading-relaxed text-white/80 sm:text-xl md:text-[1.3125rem]"
              >
                {data.body}
              </motion.p>
            ) : null}

            {primary || secondary ? (
              <motion.div
                data-reveal=""
                variants={riseItem(reduce)}
                className={cn("mt-10", ACTIONS_CLASS[align])}
              >
                {primary ? (
                  <LinkButton
                    href={primary.href}
                    icon={ArrowRight}
                    iconPosition="end"
                    // The purple fill has nothing to sit against on this ground, so the action inverts.
                    // `!` because `cn()` is a plain join and one utility cannot beat another on source
                    // order alone (contract §5).
                    className="!bg-white !text-purple-800 hover:!bg-gold-100 hover:!shadow-none"
                  >
                    {primary.label}
                  </LinkButton>
                ) : null}

                {secondary ? (
                  <LinkButton
                    href={secondary.href}
                    variant="secondary"
                    className="!border-white/40 !bg-transparent !text-white hover:!border-white hover:!bg-white/10"
                  >
                    {secondary.label}
                  </LinkButton>
                ) : null}
              </motion.div>
            ) : null}

            {data.showStory ? (
              /*
                The invitation to the cinematic story — a third, quieter tier below the decision
                row, in the hero's own gold (the ChartMate hero's "Watch the 60-second story"
                arrangement, which is this feature's acknowledged inspiration). The flag defaults
                to false in the schema, so only the hero an editor marked — normally the
                homepage's — carries it; the story's chunk itself is loaded by the button, not by
                this section (see StoryInvite).
              */
              <motion.div data-reveal="" variants={riseItem(reduce)} className="mt-6">
                <StoryInvite />
              </motion.div>
            ) : null}

            {visibleFigures.length > 0 ? (
              /*
                A list, because it is one: several figures of the same kind, read as a group.

                THE ZERO IS FILTERED TWICE, and both are needed. `HeroStat` prints nothing at all for a
                count of zero — see its header for why "0 crafts documented" is worse than silence — but
                a row of components that each render `null` would still leave this `<ul>`, its top rule
                and its margins on the page: a bordered band of empty space that reads as a broken
                layout. So the row asks the same question before it draws itself.

                ⚠ THE FIGURES DO NOT COUNT UP, AND THE ONLY ANIMATION ON THIS ROW IS ITS `riseItem` —
                THE SAME REVIEW FINDING AS THE `!canvasAllowed` CUT ABOVE, ARRIVING AT THE OTHER END OF
                THE HERO. `HeroStat` used to wrap its number in `components/motion/CountUp.tsx`, so this
                row rose, its hairlines arrived and its digits rolled all at once — and the count was the
                one animation in the whole hero applied to a FACT rather than to `aria-hidden`
                decoration. It is out. `HeroStat`'s header carries the full reasoning, including why
                `CountUp` itself is untouched: a stats BLOCK the reader has scrolled to and is looking at
                still counts, and should.
              */
              <motion.ul
                data-reveal=""
                variants={riseItem(reduce)}
                className={cn("mt-14 border-t border-white/15 pt-8", FIGURES_CLASS[align])}
              >
                {visibleFigures.map((figure, index) => (
                  // Two figures can legitimately share a label on a page that shows the same count for
                  // two regions, so the index is part of the key.
                  <li key={`${index}-${figure.label}`}>
                    <HeroStat
                      value={figure.value}
                      label={figure.label}
                      className={FIGURE_CLASS[align]}
                    />
                  </li>
                ))}
              </motion.ul>
            ) : null}

            {/*
              WHAT THE PICTURES ARE.

              Two plates of Indian craft with nothing naming them are decoration; the same two with
              their traditions and their districts written underneath are the front of an institution
              that documents them. It costs one line, it is real information rather than an invented
              statistic, and it is the honest use of the space the `figures` row leaves empty on every
              page built in the studio (see the prop's own note).

              It is hidden in step with the plates, on the same breakpoint, because a caption for
              pictures nobody can see is worse than no caption. Nothing is lost by it: every one of
              these traditions has a full record in the craft archive, which is where the reader is
              being sent anyway.
            */}
            {plates ? (
              <motion.p data-reveal="" variants={riseItem(reduce)} className="mt-12 hidden lg:block">
                {/*
                  Both colours are at FULL strength rather than the 70% and 60% that would have looked
                  right by eye. `gold-300/70` over `purple-950` composites to about 3.7:1 and
                  `white/60` to about 4.4:1, and both of these are small text, which owes 4.5:1
                  (WCAG 1.4.3). At full gold and 70% white they clear it at 6.4:1 and 5.9:1. Small,
                  quiet type is exactly where a dimmed alpha is most tempting and least affordable.
                */}
                <span className="eyebrow text-gold-300">Pictured</span>
                <span className="mt-2 block text-sm leading-relaxed text-white/70">
                  {/*
                    A category plate is named by itself — "Textile-based crafts" is already the whole
                    label. A SUBCATEGORY plate is named with its parent, because "Terracotta and
                    pottery" alone does not say which of the nine branches it belongs to, and placing
                    it is the entire reason the second plate is there.
                  */}
                  {[plates.principal, plates.inset]
                    .filter((sheet): sheet is CraftSheet => sheet !== null)
                    .map((sheet) =>
                      sheet.subcategoryId === null
                        ? sheet.title
                        : `${sheet.title} — ${sheet.category}`
                    )
                    .join(" · ")}
                </span>
              </motion.p>
            ) : null}
          </motion.div>

          {plates ? (
            <SheetPlates
              principal={plates.principal}
              inset={plates.inset}
              // The half the words are not using. `center` never reaches here (see `plates` above), so
              // only the two side alignments have to be answered.
              side={align === "right" ? "left" : "right"}
              reduce={reduce}
              className={PLATES_ORDER[align]}
            />
          ) : null}
        </div>

        {/*
          The rule that clears every `data-reveal` above when nothing is going to animate. It is here
          as well as inside each `Reveal` because a hero is the first screen and may well be the only
          block above the fold: there is no guarantee a reveal further down the page has already
          shipped the same four lines.

          ⚠ OUTSIDE THE GRID, not inside it. It renders a `<noscript>`, and an empty third grid item
          would claim a row of its own and pay the 3rem row gap for it — a mysterious band of space
          under the hero, in production only, from an element with no styles at all.
        */}
        <RevealNoScriptRescue />
      </div>

      {/*
        ⚠ NO ATTRIBUTION STRIP AT THE FOOT OF THIS HERO ANY MORE, AND ITS ABSENCE IS NOW CORRECT
        RATHER THAN AN OVERSIGHT. An empty wrapper stood here carrying a note that the ground
        photograph's CC BY credit had moved to /credits. Both the photograph and the obligation are
        gone with `CURATED.ground`: everything this hero renders is the Centre's own — the plates come
        from `lib/media/craft-sheets.ts`, which owes nobody an attribution — and an editor's uploaded
        backdrop is the Centre's own asset too. If a third-party photograph is ever put back into this
        section, its credit comes back with it; that is `ImageCredit`'s rule, not this file's.
      */}

      {data.showScrollCue ? <ScrollCue /> : null}
    </section>
  );
}

/**
 * Which edge of the window the vitrine sits against, and therefore which way it leans.
 *
 * The big plate always goes to the OUTER edge and the small one to the inner, so the mass of the group
 * is at the margin of the page and the eye travels inward towards the words rather than away from them.
 * That means the pair mirrors when the hero's words move to the right — and getting it wrong is not
 * subtle: the principal ends up shoulder to shoulder with the headline while the inset floats out in
 * the gutter, which looks like a layout that has come apart.
 *
 * Two complete literal utilities per side, joined by `cn()` with the rest of the class string. Joining
 * whole classes is not the trap in contract §5 — building a class NAME from a value is.
 */
const PRINCIPAL_PULL = { right: "ml-auto", left: "mr-auto" } as const;
const INSET_PULL = { right: "left-0", left: "right-0" } as const;

interface SheetPlatesProps {
  principal: CraftSheet;
  inset: CraftSheet | null;
  /** Which half of the frame the vitrine occupies — the half the words are not using. */
  side: keyof typeof PRINCIPAL_PULL;
  reduce: boolean;
  className?: string;
}

/**
 * One contact sheet, mounted.
 *
 * ⚠ INTRINSIC SIZING, NEVER `aspect` + `object-cover`, AND THIS IS THE WHOLE POINT OF THE COMPONENT.
 * A sheet is a mosaic of six to eight cells; cropping it to a shape the layout preferred would cut
 * cells in half and leave a row of severed photographs along one edge. `width`/`height` come from the
 * manifest and are of the stored file, so `h-auto w-full` reserves the exact box, nothing shifts when
 * the picture decodes, and not one pixel of the plate is lost. It also means a plate of a different
 * proportion — `misc-figurines-toys` is 3:2 where the rest are 16:9 — simply sits a little taller
 * rather than being cropped to match its neighbours.
 *
 * ⚠ A DARK MOUNT, NOT THE FROSTED PALE ONE THE PHOTOGRAPHIC PLATES USED. Those framed photographs
 * that were dark at the edges, and a pale mat separated them from the hero. A sheet is laid out on
 * CREAM, so the same pale mat would put a translucent white border around an almost-white rectangle
 * and the frame would disappear into its own picture. `purple-950/70` under a gold fillet is a dark
 * mount board, which is what a paper object is actually mounted on, and it makes the sheet read as
 * lit paper in a case rather than as a bright patch on the hero.
 */
function SheetPlate({
  sheet,
  sizes,
  className,
  fillet
}: {
  sheet: CraftSheet;
  sizes: string;
  className?: string;
  /** The gold hairline, for the plate the eye is meant to land on first. */
  fillet?: boolean;
}) {
  /*
   * ⚠ THE SECOND PLATE'S HAIRLINE IS TERRACOTTA, AND IT IS THE ONE PLACE THIS SECTION SPENDS THE
   * `earth` RAMP. It was `ring-white/15` — a neutral, which is what you reach for when the only job
   * is "separate this from the ground", and it made the pair read as one frame in gold and one frame
   * in nothing. earth-500 IS the mark's own terracotta (#CC785C; the ramp is built outwards from it,
   * see tailwind.config.ts), so the vitrine now holds two objects lit by two threads the Centre
   * actually owns — gold on the plate the eye lands on, the warmer and quieter one beside it. The
   * hierarchy is unchanged, and stated in colour rather than only in size.
   *
   * The alpha is what keeps it a fillet rather than a border: at 0.25 over `purple-950` it is a warm
   * edge you find when you look at the plate, not a rectangle drawn around it. Earth is literal oklch
   * like purple and gold, so this hairline is the same colour in both themes — correct here, because
   * the mount beneath it is `purple-950` in both as well.
   */
  return (
    <div
      className={cn(
        // The mount. `backdrop-blur-sm` is a genuine backdrop-filter over the tapestry beneath, and it
        // is inert for the half-second of the entrance while framer holds the wrapper below full
        // opacity (an ancestor with `opacity < 1` becomes the backdrop root — see `.glass-card` in
        // globals.css). A border that arrives unfrosted and settles frosted is not worth a branch.
        "rounded-lg bg-purple-950/70 p-2.5 shadow-cinema backdrop-blur-sm ring-1",
        fillet ? "ring-gold-500/30" : "ring-earth-500/25",
        className
      )}
    >
      {/*
        `rounded-sm` (8px) inside a `rounded-lg` (16px) mount with 10px of padding: concentric radii
        want the inner one to be the outer minus the gap, and a 16px curve repeated 10px in reads as
        two frames that missed each other. ⚠ Neither utility is what its name suggests — `rounded-sm`
        is 8px here and `rounded-2xl` would be identical to `lg` (contract §4).

        `bg-purple-900` is what shows for the instant before the blur placeholder paints, and it is a
        dark instant rather than the pale card `bg-surface-100` would have flashed on this hero.
      */}
      <div className="overflow-hidden rounded-sm bg-purple-900">
        <Image
          src={sheet.src}
          // Named as what it is. A sheet is a plate OF photographs, and calling it "Textile-based
          // crafts" alone would promise a screen-reader user one picture of one thing.
          alt={`A plate of photographs of ${sheet.title.toLowerCase()}`}
          width={sheet.width}
          height={sheet.height}
          sizes={sizes}
          placeholder="blur"
          blurDataURL={sheet.blurDataUrl}
          className="h-auto w-full"
        />
      </div>
    </div>
  );
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SHEET PLATES — two of the Centre's contact sheets, mounted the way a case mounts two objects.
 *
 * The half of the hero the words do not use was previously empty lattice, which is the flaw a reader
 * notices first and cannot name: a composition with nothing on one side of it. Two plates fix the
 * composition AND do the more valuable thing, which is to put the Centre's actual subject on the front
 * page instead of a description of it.
 *
 * WHAT CHANGED, AND WHY THE GEOMETRY HAD TO CHANGE WITH IT. This used to mount two Wikimedia
 * photographs — a portrait principal at `3 / 4` with a landscape inset at `4 / 3`, the inset lifted
 * ABOVE the principal's inner corner. Both are now the Centre's own contact sheets, and every sheet is
 * landscape at about 16:9. A tall portrait frame is simply not available any more, so the pair is
 * restacked rather than squeezed: a wide principal across the top, and a smaller sheet dropped ACROSS
 * ITS LOWER INNER CORNER, the way two prints overlap when they are laid down on a table. Two landscape
 * rectangles of the SAME size side by side is the shape of every template on the web; these are
 * deliberately unequal, deliberately overlapping, and the eye is given an order to read them in.
 *
 * ⚠ THE OVERLAP IS `pb-24` ON THE WRAPPER, NOT A NEGATIVE OFFSET ON THE INSET. The inset is pinned to
 * the wrapper's padding-box BOTTOM (`bottom-0`) and the padding is what holds the two apart, so the
 * whole group is still contained by its own box: nothing spills into a neighbouring grid cell, nothing
 * has to be clipped, and the grid never has to know the plates overlap at all. The two numbers —
 * `pb-24` here and the inset's own width — are one decision and must move together.
 *
 * ⚠ THE HEIGHT CAPS ARE SPELLED AS WIDTHS, AND THEY HAVE TO BE. A plate's height is derived from its
 * own proportion, so the only way to stop the vitrine growing past the fold on a short laptop is to cap
 * the width it is derived from. `min(30rem,58vh)` on a 16:9 principal is at most about 33vh of picture;
 * with the inset's overhang and the mounts, the group fits inside the 88vh section with its padding
 * paid on a 1280 × 800 screen, which is the commonest desktop there is.
 *
 * ⚠ NEITHER PLATE IS `priority`, AND THAT IS LOAD-BEARING RATHER THAN AN OVERSIGHT. `next/image`
 * defaults to `loading="lazy"`, and a lazy image inside a `display: none` container is never fetched at
 * all — so the whole vitrine costs a phone, where it is hidden below `lg`, exactly nothing.
 *
 * NO CREDIT CHIPS, AND NOTHING IS BEING SKIPPED. The plates that stood here carried `ImageCredit`
 * overlays because their photographs were licensed from Wikimedia Commons under CC BY. These are the
 * Centre's own pictures and owe nobody an attribution. What names them is the "Pictured" line in the
 * words column, which is a caption rather than a licence — the honest version of a museum label.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The entrance is its own `Reveal`-shaped animation rather than a child of the words' stagger: framer
 * propagates variants down through motion components only, and the plates live in a different grid cell
 * behind a plain wrapper. `data-reveal` is what the `<noscript>` rescue and the print stylesheet key
 * on, so the pictures are never trapped at `opacity: 0`.
 */
function SheetPlates({ principal, inset, side, reduce, className }: SheetPlatesProps) {
  return (
    <motion.div
      data-reveal=""
      variants={riseItem(reduce, 20)}
      initial="hidden"
      animate="visible"
      // `hidden lg:block`, so below the breakpoint there is neither a layout to squeeze nor a download
      // to pay for. `pb-24` is the overlap — see the header.
      className={cn("relative hidden lg:block", inset ? "pb-24" : undefined, className)}
    >
      <SheetPlate
        sheet={principal}
        fillet
        // 94% of a plate column that is itself about 40% of the viewport at `lg` and above.
        sizes="(min-width: 1024px) 38vw, 90vw"
        className={cn("w-[94%] max-w-[min(30rem,58vh)]", PRINCIPAL_PULL[side])}
      />

      {inset ? (
        <SheetPlate
          sheet={inset}
          sizes="(min-width: 1024px) 25vw, 60vw"
          // Dropped ACROSS the principal's lower inner corner. Capped in the same two ways and in the
          // same proportion (62/94 of the principal), so the pair keeps its relationship when the
          // viewport HEIGHT is what is doing the capping rather than the column width.
          className={cn(
            "absolute bottom-0 w-[62%] max-w-[min(19.8rem,38vh)]",
            INSET_PULL[side]
          )}
        />
      ) : null}
    </motion.div>
  );
}

/**
 * The first plate in a preference list that resolves and has not been used already.
 *
 * ⚠ IT MUTATES `taken`, which is why it is only ever called with a set the caller made this render.
 * The alternative — independent lookups per slot — is how the same plate ends up in two frames on one
 * screen, which reads as a mistake even to somebody who cannot say what is wrong.
 */
function takeFirst(slugs: readonly string[], taken: Set<string>): CraftSheet | null {
  for (const slug of slugs) {
    if (taken.has(slug)) continue;
    const sheet = craftSheet(slug);
    if (sheet) {
      taken.add(slug);
      return sheet;
    }
  }
  return null;
}

/**
 * Which background can actually be drawn.
 *
 * `backgroundKind` and `backgroundMediaId` are not cross-validated in the schema on purpose — picking
 * "Image" and then picking the image is two steps with an autosave between them — so the renderer is
 * where "Image with no image" is resolved, and it resolves to the drawn backdrop.
 */
function resolveBackdrop(kind: Backdrop, asset: MediaRow | undefined): Backdrop {
  if ((kind === "image" || kind === "video") && !asset) return "gradient";
  return kind;
}

/**
 * May this device run the pigment field?
 *
 * Five refusals, and each is a real failure mode rather than a precaution:
 *
 *  1. **Less motion, asked for either way.** Read HERE, from the attribute and from `matchMedia`,
 *     rather than taken from the caller: the caller's `reduce` is `false` on the render that mounts
 *     this component (see the note on the dynamic import at the head of this file), and a refusal
 *     that arrives one render late has already cost the download it was meant to prevent. The union
 *     is the same one globals.css and useReducedMotionPreference.ts make — the in-app toggle can only
 *     ever ADD reduction, never take the operating system's answer away.
 *  2. **No fine pointer.** A WebGL canvas painting sixty times a second is the fastest way to make a
 *     mid-range phone hot and empty its battery, and this is the FIRST THING a visitor sees on one.
 *     The field's parallax is also driven by a cursor that a touch device does not have, so more than
 *     half of what it contributes is unreachable there anyway.
 *  3. **Few cores.** Four or fewer, and the main thread is already the scarce resource.
 *  4. **Little memory.** Under about 4 GB reported. A device that reports NOTHING is taken at its word
 *     and allowed — `deviceMemory` is absent in Safari and Firefox, and refusing every browser that
 *     does not implement a Chrome extension would refuse most of the desktop web.
 *  5. **WebGL may simply be unavailable** — blocked by policy, blacklisted for the driver, or out of
 *     live contexts. Browsers hard-cap how many exist at once, so the probe hands its own context
 *     straight back rather than holding one open for the life of the page.
 *
 * It reads the DOM and `matchMedia`, so it may only ever be called from an effect — never during a
 * render, where it would answer differently on the server and the client.
 *
 * Every refusal falls back to the photographic ground and the tapestry, silently. Nothing here is
 * worth a console message on a reader's machine, and nothing about the result is a degraded design.
 */
function canRunParticleField(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;

  if (document.documentElement.getAttribute("data-reduced-motion") === "true") return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;

  const fine = window.matchMedia?.("(pointer: fine)").matches ?? false;
  if (!fine) return false;

  if ((navigator.hardwareConcurrency || 8) <= 4) return false;

  const capability = navigator as Navigator & { deviceMemory?: number };
  if ((capability.deviceMemory ?? 8) < 4) return false;

  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}
