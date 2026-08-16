/**
 * CinematicScroll — the story of the Centre, told by the page itself as the reader descends.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS. The owner's sixteen-chapter script (chapter 01 lives in the hero above; chapter 14
 * is the audiences grid that follows on the page), staged as six MOVEMENTS on one continuous
 * night-purple canvas that begins where the hero's ground ends and "dawns" back into daylight when
 * the story lets go.
 *
 * THE PIECE HAS A MATERIAL WORLD, NOT JUST TYPE, and every element of it comes from the repo's own
 * craft vocabulary rather than from stock ornament:
 *
 *   • THE ATMOSPHERE is three vast orbs in the NATURAL_DYES palette (indigo vat, iron-mordanted
 *     lac, madder) breathing on a 22–27s cycle and drifting slowly with the scroll — the night the
 *     story is told in. CSS transforms only; paused when the story is offscreen.
 *   • THE SPINE THREAD is one gold line — myrobalan → turmeric → lac, the mordant-to-dye ladder —
 *     drawn down the whole piece by the reader's own scroll, with a soft under-glow stroke, and it
 *     arrives, at the end, at the kolam. The thread of knowledge, made literal.
 *   • THE BUTIS — the ambi (mango), the phool (jasmine rosette), the patti (leaf) from
 *     components/craft/motifs.ts, the real Bagru/Sanganeri printing blocks — float through the
 *     margins, swaying on the breeze and parallaxing at their own rates.
 *   • THE JAALI: movement II's constellation sits in light broken through the pierced-stone
 *     lattice, used exactly as its geometry file instructs — voids as a MASK over a wash.
 *   • THE KOLAM draws itself under the reader's hand at the centre of a sticky mandala that HOLDS
 *     while its chapter scrolls past (the StoryScroll sticky-figure pattern, which degrades to a
 *     complete page with no JavaScript at all), and leans gently toward the pointer.
 *   • THE PLATES: movement I mounts the Centre's OWN contact sheets in preference to any photograph,
 *     at their own proportion and cropped nowhere — see `CINE_PLATES` for where the two slugs come
 *     from (the section's own row first, then that list) and why no photograph is hard-coded into
 *     this file any more.
 *   • THE STATEMENTS rise word by word out of masks (`CineLine`) — entrances are framer's half of
 *     the contract; every scrub is GSAP's, in `CinematicScrollStage`. Two of them are their own
 *     client halves: `CineFlipDeck` turns movement III's three questions over in one seat as the
 *     reader scrolls, and `CineBubbles` springs the word chips into place with a sweep of light.
 *
 * THE ARCHITECTURE IS StoryScrollSection's, DELIBERATELY: a SERVER COMPONENT holding every word in
 * the HTML, wrapped by a thin client stage that adds only scroll-scrubbed motion over a layout that
 * is already complete. Everything GSAP touches rests in its final designed state — thread and kolam
 * drawn, chips seated, verbs readable — so no JavaScript, a failed chunk and reduced motion all
 * leave a composed, readable story (contract §8's invariant).
 *
 * ⚠ THE WORDS ARE CODE, NOT CMS FIELDS, on purpose — the choreography and the copy are one
 * composition. The block is still placed, ordered and hidden through the CMS (`presentation:
 * "cinematic"` on a STORY_SCROLL block). The copy is the owner's script VERBATIM; capitals are
 * type treatments.
 *
 * ⚠ TWO LISTS STILL NEED AN INSTITUTIONAL DECISION before launch, per the script's own notes: the
 * research themes (trim to the APPROVED scope) and — on the page section that follows — the six
 * audience commitments. Each is one array; each cut is one line.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import "@/app/cinematic-story.css";

import Image from "next/image";
import type { PageSection } from "@prisma/client";

import { KolamMark } from "@/components/craft/KolamMark";
import { BUTI_BOX, BUTI_BY_ID, jaaliTile, NATURAL_DYES, type ButiId } from "@/components/craft/motifs";
import { STAGGER } from "@/components/motion/constants";
import { Reveal } from "@/components/motion/Reveal";
import { AiOrb } from "@/components/sections/story/AiOrb";
import { CineBubbles } from "@/components/sections/story/CineBubbles";
import { CineFlipDeck } from "@/components/sections/story/CineFlipDeck";
import { CineLine } from "@/components/sections/story/CineLine";
import { CinematicScrollStage } from "@/components/sections/story/CinematicScrollStage";
import { PointerDrift } from "@/components/sections/story/PointerDrift";
import { CraftPhoto } from "@/components/site/CraftPhoto";
import { craftImage, type CraftImage } from "@/lib/media/craft-imagery";
import { craftSheet, type CraftSheet } from "@/lib/media/craft-sheets";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// The shared type treatments — one hand across all six movements.
// ─────────────────────────────────────────────────────────────────────────────

const BIG =
  "font-display text-3xl font-extrabold uppercase leading-[1.14] tracking-[0.02em] text-white sm:text-4xl lg:text-5xl";

const HUGE =
  "font-display text-4xl font-extrabold uppercase leading-[1.1] tracking-[0.02em] text-white sm:text-5xl lg:text-6xl";

const SUPPORT = "text-base leading-relaxed text-white/70 sm:text-lg";

const KICKER = "text-xs font-semibold uppercase tracking-[0.24em] text-gold-300";

const CHIP =
  "inline-flex items-center rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-white/85";

// ─────────────────────────────────────────────────────────────────────────────
// The material world.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One printing block, drawn as the trade draws it: the `datta` (solid face) filled, the `rekh`
 * (fine outline block) stroked over it. `currentColor` throughout, so a buti is coloured by the
 * text utility on its wrapper like every other mark on the site.
 */
function ButiMark({ id, className }: { id: ButiId; className?: string }) {
  const buti = BUTI_BY_ID[id];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${BUTI_BOX} ${BUTI_BOX}`}
      className={cn("block", className)}
    >
      {buti.solid.map((d, index) => (
        <path key={`solid-${index}`} d={d} fill="currentColor" opacity={0.28} />
      ))}
      {buti.line.map((d, index) => (
        <path
          key={`line-${index}`}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.55}
          opacity={0.85}
        />
      ))}
    </svg>
  );
}

/**
 * A buti adrift in a movement's margins: swaying on the CSS breeze, parallaxing at `rate` under
 * the scrub, hidden from both small screens (the margins it lives in do not exist there) and the
 * accessibility tree (it is weather).
 *
 * Two nested wrappers, one transform system each: the OUTER carries the seat and the GSAP drift,
 * the INNER carries the CSS sway — GSAP writes the whole inline transform and would erase a sway
 * on the same element (contract §8).
 */
function DriftingButi({
  id,
  rate,
  seat,
  className
}: {
  id: ButiId;
  rate: number;
  seat: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-cine-drift={rate}
      className={cn("pointer-events-none absolute hidden lg:block", seat)}
    >
      <span className="cxa-cine-buti block">
        <ButiMark id={id} className={className ?? "w-14 text-gold-300/40"} />
      </span>
    </span>
  );
}

/**
 * The pierced screen. One `<pattern>` repeat of the star-and-hexagon lattice, used as the mask
 * over a soft wash (`.cxa-cine-jaali` fades the whole panel out radially) — light through stone,
 * never paint on top of the page.
 */
function JaaliLight({ className }: { className?: string }) {
  const tile = jaaliTile(26, 0.24);
  return (
    <div aria-hidden="true" className={cn("cxa-cine-jaali pointer-events-none absolute", className)}>
      <svg className="h-full w-full" role="presentation">
        <defs>
          <pattern
            id="cine-jaali"
            width={tile.width}
            height={tile.height}
            patternUnits="userSpaceOnUse"
          >
            {tile.stars.map((d, index) => (
              <path key={`star-${index}`} d={d} fill="oklch(0.85 0.11 86 / 0.07)" />
            ))}
            {tile.hexes.map((d, index) => (
              <path key={`hex-${index}`} d={d} fill="oklch(0.85 0.11 86 / 0.045)" />
            ))}
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#cine-jaali)" />
      </svg>
    </div>
  );
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * CINE_PLATES — WHERE MOVEMENT I'S PICTURES COME FROM, AND WHY NO PHOTOGRAPH IS TYPED INTO THIS FILE.
 *
 * What used to stand at the top of the component was `craftImage("patola")` and
 * `craftImage("zardozi")`: two Wikimedia Commons photographs nailed into a component, on the one
 * page whose whole argument is that the Centre keeps its OWN record. Pictures are now resolved, in
 * this order:
 *
 *   1. THE SECTION'S OWN ROW. A STORY_SCROLL block carries chapters and each chapter names a picture
 *      by slug. The cinematic presentation ignores the chapter PROSE — the words are the owner's
 *      script and the schema says so on the `presentation` field — but it has no business ignoring
 *      the pictures an editor chose. `craftImageSlug` in schema.ts is a SHAPE test rather than a
 *      check against a manifest, so a chapter slug that names one of the Centre's contact sheets
 *      ("textile-block-printing") resolves to that sheet exactly as one naming a Commons photograph
 *      ("patola") resolves to that photograph.
 *   2. THIS LIST, in order, for whatever the row did not supply.
 *   3. Nothing at all. One plate is a finished composition and none is a finished composition too —
 *      the words simply take the width, which is what every screen below `lg` already gets.
 *
 * ⚠ THE LIST IS SHEET SLUGS ONLY, AND THAT IS THE PREFERENCE THE OWNER ASKED FOR. A sheet is the
 * Centre's own picture and owes nobody an attribution; a `craftImage` is licensed from Commons and
 * discharges its CC BY on /credits. So `pickPlates` sorts every resolved candidate SHEETS FIRST
 * whatever order it met them in, and the only photographs that can reach this column are ones the
 * row itself names — a floor under the composition, never a preference.
 *
 * ⚠ THE ORDER IS FOUR CATEGORIES WITH ONE SUBCATEGORY SECOND, NOT FIVE OF ANYTHING. Movement I says
 * craft is "a technique, a material, a pattern, a story", so the pair the reader normally meets is a
 * whole branch of the taxonomy (`wood`) beside one trade from a DIFFERENT branch
 * (`textile-block-printing`) — two materials, two levels, and the claim that each of nine categories
 * is itself a dozen living traditions, made in two pictures instead of a sentence. It is the hero's
 * own device (`CURATED` in HeroSection.tsx), and it deliberately avoids the hero's own first two
 * choices, `textile` and `mud-terracotta`: those plates are on screen one scroll above this one, and
 * the same picture twice on a page reads as a mistake to a reader who cannot say why.
 *
 * ⚠ `craftSheet()` AND `craftImage()` BOTH RETURN NULL. Both manifests are generated and a slug can
 * be retired by a later run, so an unresolvable first choice falls to the second rather than leaving
 * a hole where a picture was.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const CINE_PLATES = [
  "wood",
  "textile-block-printing",
  "mud",
  "metal",
  "natural-fibre"
] as const;

/** A resolved picture, tagged with which manifest it came out of — the two are mounted differently. */
type CinePlate =
  | { kind: "sheet"; slug: string; sheet: CraftSheet }
  | { kind: "photo"; slug: string; photo: CraftImage };

/**
 * Every picture slug the section's own row names, in chapter order.
 *
 * ⚠ THIS READS THE RAW `Json` COLUMN AND MUST THEREFORE TRUST NOTHING. The component is handed the
 * `PageSection` row rather than the parsed payload (StoryScrollSection passes `section`, and the
 * cinematic branch takes no `data`), so every hop is checked: a row written by an older schema, an
 * import, or a hand-edited database can put anything at all in `data.chapters`. A bad shape yields
 * an empty list and the constant list below carries the movement, which is the same outcome as a
 * row with no chapters in it.
 */
function chapterPlateSlugs(section: PageSection): string[] {
  const data = section.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  const chapters = (data as { chapters?: unknown }).chapters;
  if (!Array.isArray(chapters)) return [];
  // `Array.isArray` narrows an `unknown` to `any[]`, and `any` spreads through everything it
  // touches. Naming the list `unknown[]` stops it at the door, so each hop below has to earn its
  // type the way the rest of the file does.
  const list: unknown[] = chapters;

  const slugs: string[] = [];
  for (const chapter of list) {
    if (typeof chapter !== "object" || chapter === null) continue;
    const slug = (chapter as { craftImage?: unknown }).craftImage;
    if (typeof slug === "string" && slug.length > 0) slugs.push(slug);
  }
  return slugs;
}

/**
 * The first `count` pictures, sheets before photographs.
 *
 * The two buckets are filled in one pass and concatenated at the end, so a sheet named by the LAST
 * chapter of a row still outranks a photograph named by the first — "prefer the Centre's own
 * imagery" is a rule about the KIND of picture, not about where in the row it was mentioned. Within
 * a kind, order is preserved: the row speaks before the constant list does.
 *
 * A `Set` of slugs rather than of resolved objects, so a slug repeated between the row and the list
 * cannot put the same plate in both frames — the flaw a reader notices at once and cannot name.
 */
function pickPlates(section: PageSection, count: number): CinePlate[] {
  const seen = new Set<string>();
  const sheets: CinePlate[] = [];
  const photos: CinePlate[] = [];

  for (const slug of [...chapterPlateSlugs(section), ...CINE_PLATES]) {
    if (seen.has(slug)) continue;
    seen.add(slug);

    const sheet = craftSheet(slug);
    if (sheet) {
      sheets.push({ kind: "sheet", slug, sheet });
      continue;
    }
    const photo = craftImage(slug);
    if (photo) photos.push({ kind: "photo", slug, photo });
  }

  return [...sheets, ...photos].slice(0, count);
}

/**
 * The two seats in movement I's column, as complete literal class strings in a lookup rather than
 * assembled at the call site — `cn()` is a plain join and could not settle `opacity-80` against an
 * `opacity-*` arriving from anywhere else (contract §5).
 *
 * `drift` is the px-rate the stage's `data-cine-drift` scrub multiplies by two; `speed` is the
 * `data-cine-photo` band. Which of the two is used depends on what the plate turns out to BE — see
 * `CinePlateMount`.
 */
const PLATE_SEATS = {
  /** The plate the eye lands on: nearest, so it travels most, and a gold fillet says so. */
  principal: { tilt: "-rotate-1", mount: "ring-gold-500/25", drift: 12, speed: "fast" },
  /** The second, set behind it: tilted the other way, quieter, travelling less. */
  second: { tilt: "rotate-2", mount: "opacity-80 ring-white/15", drift: -8, speed: "slow" }
} as const;

/**
 * One of the Centre's contact sheets, mounted.
 *
 * ⚠ INTRINSIC SIZING, NEVER `aspect` + `object-cover`, AND THAT IS THE ENTIRE REASON THIS EXISTS
 * BESIDE `CraftPhoto` RATHER THAN INSIDE IT. A sheet is a mosaic of six to eight photographs on a
 * cream ground; cropping it to a shape the layout preferred would slice through the middle of its
 * cells and leave a row of severed pictures along one edge. `width`/`height` come from the manifest
 * and are of the stored file, so `h-auto w-full` reserves the exact box, nothing shifts when the
 * picture decodes, and not one pixel of the plate is lost — the rule craft-sheets.ts states in its
 * own header and HeroSection's `SheetPlate` follows for the same reason.
 *
 * ⚠ A DARK MOUNT, BECAUSE THE PICTURE IS PALE. A sheet is laid out on cream, so the frosted white
 * mat the photographic plates carry would put a translucent white border around an almost-white
 * rectangle. `purple-950/70` is a dark mount board — the night canvas's own ground — and it makes
 * the sheet read as lit paper in a case rather than as a bright patch burnt into the story.
 *
 * NO CREDIT OVERLAY, AND NOTHING IS BEING SKIPPED: these are the Centre's own pictures and owe no
 * attribution. `craftSheet` carries no licence fields to render even if one wanted to.
 */
function CineSheetPlate({ sheet, className }: { sheet: CraftSheet; className?: string }) {
  return (
    <div className={cn("rounded-lg bg-purple-950/70 p-2.5 shadow-2xl ring-1", className)}>
      {/* `rounded-sm` (8px) inside `rounded-lg` (16px) with 10px of padding: concentric radii want
          the inner one to be the outer minus the gap. ⚠ Neither utility is what its name suggests
          (contract §4). `bg-purple-900` is what shows for the instant before the blur paints. */}
      <div className="overflow-hidden rounded-sm bg-purple-900">
        <Image
          src={sheet.src}
          // Named as what it is. A sheet is a plate OF photographs, and calling it "Wood crafts"
          // alone would promise a screen-reader user one picture of one thing.
          alt={`A plate of photographs of ${sheet.title.toLowerCase()}`}
          width={sheet.width}
          height={sheet.height}
          // The column is 0.9fr of a 84rem shell: about 40vw from `lg` up, and never rendered below
          // it. Not `priority` — this is the second screen of the page, and a lazy image inside a
          // `display: none` container is never fetched at all, so phones pay nothing for the vitrine.
          sizes="(min-width: 1024px) 42vw, 90vw"
          placeholder="blur"
          blurDataURL={sheet.blurDataUrl}
          className="h-auto w-full"
        />
      </div>
    </div>
  );
}

/**
 * A plate in movement I's column, mounted according to what it IS.
 *
 * ⚠ TWO DEPTH MECHANISMS, AND WHICH ONE IS USED IS FORCED BY THE PICTURE RATHER THAN CHOSEN. A
 * `craftImage` is CROPPED to a shape, so it can be parallaxed INSIDE its own frame — that is what
 * `data-cine-photo` drives, and CraftPhoto's 1.18 overscan is what stops the travel uncovering an
 * edge. A sheet is cropped nowhere and therefore has no spare picture to travel across, so the only
 * honest depth cue left is to move the whole mounted OBJECT: `data-cine-drift`, the same per-element
 * rate the butis drift on. A plate that slid inside its mount would be the cropping this component
 * exists to refuse, one frame at a time.
 *
 * ⚠ SO THE TILT SITS ON AN INNER ELEMENT IN THE SHEET BRANCH. GSAP writes the whole inline transform
 * of whatever it drives, and a `rotate-*` utility on the same element is erased the first time the
 * scrub fires (contract §8) — the two-wrapper rule `DriftingButi` sets out, restated for an object a
 * hundred times its size. The photograph branch needs no such wrapper: there GSAP drives the `<img>`
 * inside the frame, so the frame's own rotation is nobody else's channel.
 */
function CinePlateMount({
  plate,
  seat
}: {
  plate: CinePlate;
  seat: (typeof PLATE_SEATS)[keyof typeof PLATE_SEATS];
}) {
  if (plate.kind === "sheet") {
    return (
      <div data-cine-drift={seat.drift}>
        <div className={seat.tilt}>
          <CineSheetPlate sheet={plate.sheet} className={seat.mount} />
        </div>
      </div>
    );
  }

  return (
    <div data-cine-photo={seat.speed} className={seat.tilt}>
      {/* No `caption`: CraftPhoto's figcaption is themed ink, unreadable on this permanently-dark
          canvas. The licence attribution rides the overlay, and /credits carries it in full. */}
      <CraftPhoto
        image={plate.photo}
        aspect="4 / 3"
        sizes="(min-width: 1024px) 42vw, 90vw"
        parallax
        showRegion={false}
        creditOnCreditsPage
        creditOverlay
        frameClassName={cn("rounded-lg ring-1", seat.mount)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The copy, from the script.
// ─────────────────────────────────────────────────────────────────────────────

const KNOWING = ["A technique.", "A material.", "A pattern.", "A story.", "A way of knowing."];
const TRANSMISSION = ["Learned.", "Practised.", "Adapted.", "Preserved."];
const CHAIN = ["Artisan", "Craft", "Knowledge"];
const APART = [
  { word: "Research", rate: 26, seat: "left-[6%] top-[8%]" },
  { word: "Design", rate: -20, seat: "right-[8%] top-[16%]" },
  { word: "Technology", rate: 32, seat: "left-[12%] bottom-[12%]" },
  { word: "Community", rate: -28, seat: "right-[10%] bottom-[8%]" }
] as const;
const WHAT_IFS = [
  "What if traditional knowledge could be documented without losing the context in which it lives?",
  "What if researchers could discover and work with this knowledge in new ways?",
  "What if technology could help carry it forward rather than simply preserve it?"
];
const POSITIONING = [
  "Not replacing traditional knowledge.",
  "Not replacing the maker.",
  "Extending what is already there."
];
const ECOSYSTEM = [
  "Artisans",
  "Communities",
  "Researchers",
  "Designers",
  "Students",
  "Institutions",
  "Technology",
  "AI",
  "Craft knowledge",
  "Cultural heritage"
];
const ENABLES = [
  {
    verb: "Preserve",
    buti: "ambi" as const,
    line: "Document and digitally preserve knowledge embedded in craft traditions."
  },
  {
    verb: "Understand",
    buti: "phool" as const,
    line: "Bring structure and context to materials, techniques, processes, patterns and cultural knowledge."
  },
  {
    verb: "Discover",
    buti: "patti" as const,
    line: "Make craft knowledge easier to explore, search and connect across disciplines and communities."
  },
  {
    verb: "Create",
    buti: "bindi" as const,
    line: "Enable new forms of creative exploration through technology and AI."
  },
  {
    verb: "Connect",
    buti: "ambi" as const,
    line: "Bring together artisans, researchers, designers, institutions and communities through a shared ecosystem."
  }
];
const PRINCIPLES = [
  { name: "Human-centred", line: "People and communities remain central to the ecosystem." },
  { name: "Knowledge-driven", line: "Technology builds upon knowledge rather than obscuring it." },
  { name: "Future-ready", line: "Traditional knowledge can evolve into new forms and new possibilities." }
];
/** ⚠ Trim to the approved research scope before launch — see the file header. */
const RESEARCH_THEMES = [
  "Artificial intelligence",
  "Generative AI",
  "Computer vision",
  "Multimodal knowledge",
  "Digital preservation",
  "Knowledge systems",
  "Computational design",
  "Human–AI collaboration"
];
const IMPACT_CHAIN = ["Knowledge", "Research", "Technology", "Collaboration", "Impact"];
const CONVERGING = [
  { word: "Craft", seat: "left-[16%] top-[12%]", dx: "-14vw", dy: "-10vh", rot: -10 },
  { word: "Knowledge", seat: "left-[44%] top-[6%]", dx: "0vw", dy: "-14vh", rot: 6 },
  { word: "People", seat: "right-[16%] top-[12%]", dx: "14vw", dy: "-10vh", rot: 10 },
  { word: "Research", seat: "left-[8%] top-[42%]", dx: "-18vw", dy: "0vh", rot: -8 },
  { word: "Culture", seat: "right-[8%] top-[42%]", dx: "18vw", dy: "0vh", rot: 8 },
  { word: "Design", seat: "left-[14%] bottom-[14%]", dx: "-14vw", dy: "10vh", rot: -7 },
  { word: "Technology", seat: "left-[42%] bottom-[7%]", dx: "0vw", dy: "14vh", rot: 5 },
  { word: "AI", seat: "right-[24%] bottom-[16%]", dx: "10vw", dy: "12vh", rot: 9 },
  { word: "Community", seat: "right-[10%] bottom-[10%]", dx: "16vw", dy: "8vh", rot: -6 }
] as const;

// ─────────────────────────────────────────────────────────────────────────────

export interface CinematicScrollProps {
  section: PageSection;
}

export function CinematicScroll({ section }: CinematicScrollProps) {
  /*
   * Movement I's vitrine. Two plates, resolved from the row and then from `CINE_PLATES` — see that
   * constant's header for the order and for why nothing here is a slug typed into a component.
   * `?? null` rather than a bare index because `noUncheckedIndexedAccess` is on and a row with one
   * resolvable picture is a real case: the frame that has no plate is simply not rendered.
   */
  const plates = pickPlates(section, 2);
  const principal = plates[0] ?? null;
  const second = plates[1] ?? null;

  return (
    <section
      id={`s-${section.id}`}
      data-anchor=""
      // The splash cursor stands down over the night canvas — the story has its own weather.
      data-splash-off=""
      aria-label="The story of the Centre"
      className="relative isolate overflow-hidden bg-purple-950 text-white"
    >
      {/*
        THE NO-JAVASCRIPT RESCUE FOR EVERY MASKED WORD, EVERY CHIP AND THE DECK. Framer serialises
        each element's `initial` into the SSR markup as an inline style, so with scripts off the
        statements, the word bubbles and two of the three questions would be `opacity: 0` for ever —
        the one hole in "readable with JavaScript switched off", and the review found it.
        `!important` is REQUIRED here, unlike HeroHeadline's noscript (which overrides a stylesheet
        start state): an inline style cannot be beaten any other way. Inside `<noscript>`, so a
        scripted reader never loads a rule that could fight framer.

        ⚠ THE DECK NEEDS `position` AS WELL AS THE TWO USUAL PROPERTIES. Its three panels are
        absolutely seated on top of one another inside an 8rem box, so clearing the opacity alone
        would print all three questions over each other in it. `static` returns them to ordinary
        flow, the sibling margin puts a reading gap back between them, and the progress dots go —
        with the deck un-stacked there is no "current" seat for them to be honest about. `position`
        comes from a class rather than an inline style and would fall to source order alone, but it
        is spelled `!important` beside its neighbours so the rule cannot quietly stop working
        because a utility moved in the stylesheet.

        ⚠ AND `[data-cine-sheen]` IS DELIBERATELY NOT LISTED. The bubbles' sweep of light is a child
        of the chip, not the chip, so the selector below leaves it at its own inline `opacity: 0` —
        clearing it would paint a bright gradient bar across every chip on precisely the pages this
        rescue exists to save. If CineBubbles or CineFlipDeck renames an attribute, it is renamed
        here; that is the whole contract between the three files.
      */}
      <noscript>
        <style>{`[data-cine-word],[data-cine-bubble]{opacity:1!important;transform:none!important}[data-cine-flip]{position:static!important;opacity:1!important;transform:none!important}[data-cine-flip]+[data-cine-flip]{margin-top:2rem}[data-cine-flip-dots]{display:none!important}`}</style>
      </noscript>

      <CinematicScrollStage>
        {/* ── The atmosphere: three dye vats breathing over the night ─────────
            Seats and colours are the design; the scrub drifts each at its own rate down the
            piece and the CSS breath keeps them alive while the reader rests. -z-20: beneath
            even the thread. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-20">
          <span
            data-cine-orb="-9"
            className="absolute -left-[18%] top-[2%] h-[58vmax] w-[58vmax]"
          >
            <span
              className="cxa-cine-orb block h-full w-full rounded-full"
              style={{
                background: `radial-gradient(closest-side, ${NATURAL_DYES.indigo.color.replace(")", " / 0.32)")}, transparent 70%)`
              }}
            />
          </span>
          <span
            data-cine-orb="14"
            className="absolute -right-[22%] top-[30%] h-[64vmax] w-[64vmax]"
          >
            <span
              className="cxa-cine-orb--counter block h-full w-full rounded-full"
              style={{
                background: `radial-gradient(closest-side, ${NATURAL_DYES.lac.color.replace(")", " / 0.26)")}, transparent 72%)`
              }}
            />
          </span>
          <span
            data-cine-orb="-6"
            className="absolute -left-[12%] bottom-[4%] h-[52vmax] w-[52vmax]"
          >
            <span
              className="cxa-cine-orb block h-full w-full rounded-full"
              style={{
                background: `radial-gradient(closest-side, ${NATURAL_DYES.madder.color.replace(")", " / 0.16)")}, transparent 70%)`
              }}
            />
          </span>
          {/* Fine grain so the big soft gradients never band. */}
          <div className="absolute inset-0 opacity-[0.05] [background-image:radial-gradient(rgba(255,255,255,0.9)_0.5px,transparent_0.5px)] [background-size:22px_22px]" />
        </div>

        {/* ── The spine thread: mordant to dye, drawn by the reader ─────────── */}
        <svg
          aria-hidden="true"
          viewBox="0 0 100 1000"
          preserveAspectRatio="none"
          // `translateZ(0)`: the thread on its own compositing layer, so the per-frame dash
          // repaint dirties a mostly-empty tile instead of re-rasterising the text and photos
          // painted over it (the review measured the alternative as the piece's dominant frame
          // cost). This is NOT the banned blanket `will-change` on photographs — the layer is a
          // hairline on transparency, and its backing store is correspondingly cheap.
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full [transform:translateZ(0)]"
        >
          <defs>
            <linearGradient id="cine-thread-gold" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={NATURAL_DYES.myrobalan.color} stopOpacity="0.6" />
              <stop offset="0.55" stopColor={NATURAL_DYES.turmeric.color} stopOpacity="0.8" />
              <stop offset="1" stopColor={NATURAL_DYES.lac.color} stopOpacity="0.7" />
            </linearGradient>
          </defs>
          {/* The under-glow: the same path, wide and faint — lamplight on the thread, without an
              SVG filter repainting a full-height layer every frame. */}
          <path
            data-cine-thread-glow
            d="M 50 0
               C 50 40, 24 70, 24 110
               S 76 190, 76 240
               S 30 330, 30 390
               S 70 470, 70 520
               S 26 610, 26 660
               S 74 740, 74 790
               S 50 900, 50 940
               L 50 1000"
            pathLength={1000}
            fill="none"
            stroke="oklch(0.85 0.11 86 / 0.16)"
            strokeWidth={7}
            style={{ vectorEffect: "non-scaling-stroke" }}
          />
          <path
            data-cine-thread
            d="M 50 0
               C 50 40, 24 70, 24 110
               S 76 190, 76 240
               S 30 330, 30 390
               S 70 470, 70 520
               S 26 610, 26 660
               S 74 740, 74 790
               S 50 900, 50 940
               L 50 1000"
            pathLength={1000}
            fill="none"
            stroke="url(#cine-thread-gold)"
            strokeWidth={1.6}
            style={{ vectorEffect: "non-scaling-stroke" }}
          />
        </svg>

        {/*
          THE SHUTTLE — a bead of lamplight that RIDES the thread as the reader scrolls, the way a
          weaver's shuttle carries the weft. The stage maps scroll progress to a point along the
          path (getPointAtLength, scaled out of the viewBox) and moves this bead there by
          transform. Its RESTING seat is the thread's own start (left 50%, top 0) via layout
          properties, not transform — so CSS and GSAP never share a channel, and with no
          JavaScript the bead simply waits, threaded, at the top: a journey not yet begun.
        */}
        <div
          aria-hidden="true"
          data-cine-shuttle=""
          className="pointer-events-none absolute -z-10 h-3 w-3 -ml-1.5 -mt-1.5 rounded-full"
          style={{
            left: "50%",
            top: 0,
            background: "radial-gradient(closest-side, oklch(0.9 0.08 88), oklch(0.85 0.11 86 / 0.4) 55%, transparent)",
            boxShadow: "0 0 18px 4px oklch(0.85 0.11 86 / 0.35)"
          }}
        />

        {/* A memory of the hero's weave, fading as the story begins. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/25 to-transparent"
        />

        {/* ════════════════════ MOVEMENT I — More than what we make ════════════════════ */}
        <div data-cine-movement="craft" className="relative">
          <DriftingButi id="ambi" rate={18} seat="left-[3%] top-[14%]" className="w-16 text-gold-300/35" />
          <DriftingButi id="phool" rate={-14} seat="left-[8%] bottom-[10%]" className="w-12 text-gold-300/30" />

          <div className="shell grid items-center gap-12 py-20 md:py-28 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
            <div>
              <Reveal>
                <p className={KICKER}>The story of the Centre</p>
              </Reveal>
              <CineLine
                as="h2"
                text="Craft is more than what we make."
                className={cn(BIG, "mt-5 max-w-[16ch]")}
              />
              <Reveal delay={0.1}>
                <p className={cn(SUPPORT, "mt-6 max-w-[44ch]")}>
                  It carries knowledge, memory, identity and generations of human experience.
                </p>
              </Reveal>

              {/* The five ways of knowing, strung on their own short thread: the mini-rail draws
                  under the scrub while each bead's line arrives with its word. */}
              <div data-cine-knowing="" className="relative mt-12">
                {/*
                  ⚠ THE RAIL AND THE BEADS SHARE ONE AXIS AT x = 4px, AND THEY DID NOT BEFORE.
                  The rail was `left-[3px] w-px` — one pixel spanning 3→4, so its centre fell on
                  3.5. Each bead is 8px wide at `-left-[25px]` inside an `<ol>` with `pl-6`, which
                  puts its left edge at 24 − 25 = −1 and its centre on 3. Half a pixel apart, on
                  every bead, all the way down: the thread visibly misses the middle of each dot
                  instead of running through it.
                  Both are now integers about the same axis: a 2px rail at `left-[3px]` (3→5,
                  centre 4) and a bead at `-left-6` (24 − 24 = 0, 0→8, centre 4).
                */}
                <div
                  aria-hidden="true"
                  className="absolute bottom-2 left-[3px] top-2 w-0.5 bg-gold-300/15"
                >
                  <div
                    data-cine-knowing-rail
                    className="h-full w-full origin-top bg-gradient-to-b from-gold-300/70 to-gold-300/20"
                  />
                </div>
                <ol className="space-y-4 pl-6">
                  {KNOWING.map((line, index) => {
                    const last = index === KNOWING.length - 1;
                    return (
                      <li key={line} className="relative">
                        <Reveal delay={0.06 * index} className="flex items-center gap-4">
                          {/*
                            EVERY bead is full gold in the markup and the scrub is what dims the ones
                            the thread has not reached yet — see `data-cine-knowing-bead` in
                            CinematicScrollStage.tsx. Writing the dim state into the class instead
                            would leave a reader with no JavaScript looking at four grey dots and one
                            gold one, as though the list had failed halfway; lit is the honest
                            resting state, and the animation only withholds it.
                          */}
                          <span
                            data-cine-knowing-bead=""
                            aria-hidden="true"
                            className={cn(
                              "absolute -left-6 h-2 w-2 shrink-0 rounded-full bg-gold-300",
                              last ? "ring-2 ring-gold-300/30" : undefined
                            )}
                          />
                          <span
                            className={cn(
                              "font-display text-xl font-semibold sm:text-2xl",
                              last ? "text-gold-300" : "text-white/85"
                            )}
                          >
                            {line}
                          </span>
                        </Reveal>
                      </li>
                    );
                  })}
                </ol>
              </div>

              <CineLine
                text="A living body of knowledge."
                accent="A living body of knowledge."
                className={cn(HUGE, "mt-12")}
              />
            </div>

            {/*
              THE VITRINE — two plates at two depths, the double weave the copy is describing,
              leaning toward the pointer as one group.

              ⚠ STACKED AND FULL-COLUMN-WIDTH, WHERE THIS USED TO BE A `w-4/5` PLATE WITH A `w-3/5`
              ONE OVERLAPPING ITS CORNER — and the geometry had to change because the pictures did.
              craft-sheets.ts sets a floor of about 380 CSS px on any frame a contact sheet is
              mounted in, below which its six-to-eight cells stop being separable. This column is
              `0.9fr` of an 84rem shell: 403px at the `lg` breakpoint itself and about 547px at
              1536, so a plate at the FULL column clears the floor everywhere the column exists —
              while the old inset's 60% would have been 242px at `lg`, which is a thumbnail of a
              mosaic and unreadable as either. The two plates are told apart by tilt, depth and
              mount instead of by size (see `PLATE_SEATS`), and the group is `hidden lg:block`, so
              no narrow screen pays for a picture it was never going to be shown.
            */}
            {principal ? (
              <PointerDrift depth={12} className="relative hidden lg:block">
                <div className="flex flex-col gap-10">
                  <CinePlateMount plate={principal} seat={PLATE_SEATS.principal} />
                  {second ? <CinePlateMount plate={second} seat={PLATE_SEATS.second} /> : null}
                </div>
              </PointerDrift>
            ) : null}
          </div>
        </div>

        {/* ════════════════════ MOVEMENT II — Dispersed ════════════════════ */}
        <div data-cine-movement="dispersed" className="relative">
          <div className="shell py-20 text-center md:py-24">
            <Reveal className="mx-auto max-w-3xl">
              <CineLine as="h3" text="Behind every craft is knowledge." className={BIG} />
              <p className={cn(SUPPORT, "mx-auto mt-6 max-w-[48ch]")}>
                Passed from one generation to another, craft knowledge lives in the hands, minds and
                communities of its makers.
              </p>
            </Reveal>

            {/* The four verbs are SET DOWN one after another rather than revealed as a block: each
                springs into its seat with a sweep of light across it, and scrolling back up picks
                the row up again from the end (CineBubbles owns both directions and the
                reduced-motion fade). `loose`, because four short statements with full stops want
                the beat between them — the stagger is the punctuation. */}
            <CineBubbles
              words={TRANSMISSION}
              chipClassName={CHIP}
              stagger={STAGGER.loose}
              className="mt-8"
            />

            {/* The constellation, in light broken through the jaali: the one chain that exists,
                and the four fields adrift around it at their own drift rates. The names repeat in
                the paragraph below for every reader the picture cannot reach. */}
            <div
              className="relative mx-auto mt-20 hidden h-[26rem] max-w-4xl sm:block"
              aria-hidden="true"
            >
              <JaaliLight className="inset-0" />
              <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
                {CHAIN.map((word, index) => (
                  <div key={word} className="flex flex-col items-center">
                    {index > 0 ? (
                      <span className="my-1.5 block h-6 w-px bg-gradient-to-b from-gold-300/70 to-gold-300/20" />
                    ) : null}
                    <span className={cn(CHIP, "!border-gold-300/40 !text-gold-200")}>{word}</span>
                  </div>
                ))}
              </div>
              {APART.map((field) => (
                <span key={field.word} data-cine-drift={field.rate} className={cn("absolute", field.seat)}>
                  <span className={cn(CHIP, "!border-white/10 !text-white/55")}>{field.word}</span>
                </span>
              ))}
            </div>

            {/* The constellation, said in words — the picture above is aria-hidden and absent on
                phones, and the support copy does not happen to name all four drifting fields. */}
            <p className="sr-only">
              Research, design, technology and community — all initially disconnected.
            </p>

            <Reveal className="mx-auto mt-16 max-w-3xl">
              <CineLine as="h3" text="Knowledge should not be fragmented." className={HUGE} />
              <p className={cn(SUPPORT, "mx-auto mt-6 max-w-[52ch]")}>
                Craft knowledge exists across artisans, communities, researchers, designers,
                institutions and cultural traditions. Much of it remains difficult to document,
                connect, discover and carry forward into new contexts.
              </p>
              <p className={cn(SUPPORT, "mx-auto mt-4 max-w-[52ch] text-white/50")}>
                Yet much of this knowledge remains dispersed across people, places, practices and
                generations.
              </p>
            </Reveal>
          </div>
        </div>

        {/* ════════════════════ MOVEMENT III — The question ════════════════════ */}
        <div data-cine-movement="question" className="relative">
          <DriftingButi id="patti" rate={-16} seat="right-[5%] top-[18%]" className="w-12 text-gold-300/30" />

          <div className="shell flex flex-col items-center gap-14 py-20 text-center md:gap-20 md:py-28">
            <CineLine as="h3" text="What if we could connect it?" className={HUGE} />

            {/* ONE SEAT, THREE QUESTIONS, TURNED OVER BY THE READER'S OWN SCROLL. Printed as three
                stacked paragraphs with this movement's `gap-14 md:gap-20` between them they cost
                about 400 vertical pixels to say one thought, which is the note the owner made.
                CineFlipDeck holds all three in the DOM at all times — the accessibility answer, not
                an oversight — and falls back to exactly the stacked layout this replaced under
                reduced motion. See its header. */}
            <CineFlipDeck lines={WHAT_IFS} />

            <div className="relative">
              {/* The bloom: the light rising behind the question where AI enters — scrubbed up
                  as the line arrives. Rest state is the lit design. */}
              <div
                aria-hidden="true"
                data-cine-bloom=""
                className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-[130%] w-[140%] -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  background: `radial-gradient(closest-side, ${NATURAL_DYES.turmeric.color.replace(")", " / 0.14)")}, transparent 72%)`
                }}
              />
              <CineLine
                as="h3"
                text="What if AI could help build that connection?"
                accent="What if AI could help build that connection?"
                className={HUGE}
              />
              <svg aria-hidden="true" viewBox="0 0 400 14" className="mx-auto mt-6 h-3.5 w-64 sm:w-96">
                <path
                  data-cine-underline
                  d="M 4 9 C 60 3, 120 13, 200 8 S 340 4, 396 8"
                  pathLength={1000}
                  fill="none"
                  stroke="oklch(0.85 0.11 86 / 0.8)"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>
        </div>

        {/* ════════════════════ MOVEMENT IV — The Centre appears ════════════════════
            The mandala HOLDS — position: sticky, the StoryScroll pattern — while the chapter's
            four stanzas scroll past it; the kolam draws and the ring assembles under the same
            scroll that carries the words. With no JavaScript it is a complete two-column page. */}
        <div data-cine-movement="centre" className="relative">
          <div className="shell grid gap-12 py-20 md:py-24 lg:grid-cols-2 lg:gap-16">
            {/* The mandala. First in the source so phones meet the image before the argument;
                sticky on wide screens so it keeps the reader company through all four stanzas. */}
            <div className="lg:order-2">
              <div className="lg:sticky lg:top-[calc(var(--nav-clearance)+2rem)]">
                <PointerDrift depth={14} className="relative mx-auto flex h-[24rem] max-w-xl items-center justify-center sm:h-[30rem]">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute left-1/2 top-1/2 h-[120%] w-[120%] -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{
                      background: `radial-gradient(closest-side, ${NATURAL_DYES.lac.color.replace(")", " / 0.12)")}, transparent 70%)`
                    }}
                  />
                  <div data-cine-kolam className="w-56 text-gold-300/70 sm:w-72">
                    <KolamMark cols={7} rows={5} className="w-full" />
                  </div>
                  <div data-cine-ringwheel="" aria-hidden="true" className="absolute inset-0 hidden sm:block">
                    {ECOSYSTEM.map((member, index) => {
                      const angle = (index / ECOSYSTEM.length) * Math.PI * 2 - Math.PI / 2;
                      const x = 50 + Math.cos(angle) * 46;
                      const y = 50 + Math.sin(angle) * 43;
                      return (
                        <span
                          key={member}
                          className="absolute -translate-x-1/2 -translate-y-1/2"
                          style={{ left: `${x.toFixed(1)}%`, top: `${y.toFixed(1)}%` }}
                        >
                          <span data-cine-orbit={index} className="block">
                            <span className={CHIP}>{member}</span>
                          </span>
                        </span>
                      );
                    })}
                  </div>
                </PointerDrift>
              </div>
            </div>

            {/* The four stanzas that scroll past the held mandala. */}
            <div className="flex flex-col gap-20 text-left lg:order-1 lg:gap-28 lg:py-10">
              <div>
                <Reveal>
                  <p className={KICKER}>The Centre appears</p>
                </Reveal>
                <CineLine
                  as="h3"
                  text="This is where the Centre of Excellence begins."
                  className={cn(BIG, "mt-5")}
                />
                <Reveal delay={0.08}>
                  <p className={cn(SUPPORT, "mt-6 max-w-[48ch]")}>
                    A platform bringing together craft, cultural knowledge, research, design and
                    artificial intelligence to create new ways of preserving, understanding and
                    engaging with craft.
                  </p>
                </Reveal>
              </div>

              <div className="space-y-3">
                {POSITIONING.map((line, index) => {
                  const last = index === POSITIONING.length - 1;
                  return (
                    <Reveal key={line} delay={0.08 * index}>
                      <p
                        className={cn(
                          "font-display font-semibold",
                          last ? "text-2xl text-gold-300 sm:text-3xl" : "text-xl text-white/65 sm:text-2xl"
                        )}
                      >
                        {line}
                      </p>
                    </Reveal>
                  );
                })}
              </div>

              <div>
                <CineLine as="h3" text="Connect what exists." className={BIG} />
                <CineLine
                  as="p"
                  text="Discover what is possible."
                  accent="Discover what is possible."
                  className={cn(BIG, "mt-1")}
                />
                <Reveal delay={0.08}>
                  <p className={cn(SUPPORT, "mt-6 max-w-[48ch]")}>
                    The Centre seeks to create an integrated ecosystem in which knowledge can move
                    between people, disciplines and technologies — enabling craft to be documented,
                    understood, explored and carried forward.
                  </p>
                </Reveal>
              </div>

              <Reveal>
                <p className="font-display text-lg font-semibold text-white sm:text-xl">
                  Artisans, communities, researchers, designers, students, institutions, technology,
                  AI, craft knowledge and cultural heritage.{" "}
                  <span className="text-gold-gradient">Many perspectives. One connected ecosystem.</span>
                </p>
              </Reveal>
            </div>
          </div>
        </div>

        {/* ════════════════════ MOVEMENT V — What the Centre enables ════════════════════ */}
        <div data-cine-movement="enables" className="relative">
          <DriftingButi id="phool" rate={20} seat="right-[4%] top-[6%]" className="w-16 text-gold-300/35" />
          <DriftingButi id="ambi" rate={-12} seat="right-[9%] bottom-[24%]" className="w-12 text-gold-300/25" />

          <div className="shell py-20 md:py-24">
            <div className="mx-auto max-w-3xl">
              {/* The five verbs on their own rail — each row carries its printing block, inked as
                  the rail's fill passes it. At rest everything is readable; `is-lit` only adds
                  the gold. */}
              <div data-cine-ladder="" className="relative pl-10 sm:pl-14">
                <div aria-hidden="true" className="absolute bottom-4 left-[7px] top-4 w-px bg-gold-300/25 sm:left-[9px]">
                  <div
                    data-cine-rail
                    className="h-full w-full origin-top bg-gradient-to-b from-gold-300 to-gold-500"
                  />
                </div>

                <ol>
                  {ENABLES.map((entry, index) => (
                    <Reveal key={entry.verb} as="li" delay={0.05 * index} className={cn("relative", index > 0 && "mt-12")}>
                      <div data-cine-verb="" className="group">
                        <span
                          aria-hidden="true"
                          className="absolute -left-10 top-2 h-[15px] w-[15px] rounded-full border-2 border-gold-300/40 bg-purple-950 transition-colors duration-300 ease-out [.is-lit_&]:border-gold-300 [.is-lit_&]:bg-gold-300 sm:-left-14"
                        />
                        <div className="flex items-center gap-4">
                          <p className="font-display text-2xl font-extrabold uppercase tracking-[0.04em] text-white/85 transition-colors duration-300 ease-out [.is-lit_&]:text-gold-300 sm:text-3xl">
                            {entry.verb}
                          </p>
                          <span
                            aria-hidden="true"
                            className="opacity-25 transition-opacity duration-300 ease-out [.is-lit_&]:opacity-100"
                          >
                            <ButiMark id={entry.buti} className="w-8 text-gold-300" />
                          </span>
                        </div>
                        <p className={cn(SUPPORT, "mt-1.5 max-w-[52ch]")}>{entry.line}</p>
                      </div>
                    </Reveal>
                  ))}
                </ol>
              </div>

              <div className="mt-24 text-center">
                {/* The intelligence, embodied: the shader orb turns above the chapter that names
                    it, and listens only when invited (AiOrb owns the microphone ethics and the
                    frame economy — see its header). */}
                <Reveal>
                  <AiOrb className="mx-auto" />
                </Reveal>
                <Reveal delay={0.06}>
                  <p className={cn(KICKER, "mt-8")}>Craft × AI</p>
                </Reveal>
                <CineLine as="h3" text="When craft meets intelligence." className={cn(BIG, "mt-5")} />
                <Reveal delay={0.08}>
                  <p className={cn(SUPPORT, "mx-auto mt-6 max-w-[48ch]")}>
                    Artificial intelligence can help us work with complex forms of knowledge —
                    across images, language, patterns, processes and cultural context.
                  </p>
                </Reveal>
                <Reveal delay={0.12}>
                  <p className="mt-6 text-base text-white/55 sm:text-lg">
                    The opportunity is not simply to digitise craft.
                  </p>
                </Reveal>
                <CineLine
                  as="p"
                  text="It is to make knowledge more connected."
                  accent="It is to make knowledge more connected."
                  className={cn(BIG, "mt-4")}
                />
              </div>

              <div className="mt-20 text-center">
                <CineLine as="h3" text="Technology serves the maker." className={BIG} />
                <Reveal delay={0.08}>
                  <p className={cn(SUPPORT, "mx-auto mt-6 max-w-[52ch]")}>
                    The Centre places human knowledge at the heart of technological innovation,
                    using AI and digital systems to support discovery, documentation, learning and
                    creative exploration.
                  </p>
                </Reveal>
              </div>
              <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {PRINCIPLES.map((principle, index) => (
                  <Reveal key={principle.name} delay={0.07 * index}>
                    <div className="h-full rounded-xl border border-white/10 bg-white/5 px-5 py-4 text-left transition-colors duration-300 hover:border-gold-300/30">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-300">
                        {principle.name}
                      </p>
                      <p className="mt-2 text-sm leading-relaxed text-white/70">{principle.line}</p>
                    </div>
                  </Reveal>
                ))}
              </div>

              <div className="mt-20 text-center">
                <CineLine as="h3" text="Where craft becomes a field of research." className={BIG} />
                <Reveal delay={0.08}>
                  <p className={cn(SUPPORT, "mx-auto mt-6 max-w-[52ch]")}>
                    The Centre brings together interdisciplinary research across artificial
                    intelligence, digital technologies, craft, design, cultural knowledge and human
                    creativity.
                  </p>
                </Reveal>
                {/* The same arrival as the transmission verbs, at `tight`: eight chips on the same
                    0.08 beat would leave the last theme more than half a second behind the first,
                    and this row is a field of study rather than four separate statements — it
                    should read as one gesture. */}
                <CineBubbles
                  words={RESEARCH_THEMES}
                  chipClassName={cn(
                    CHIP,
                    "transition-colors duration-300 hover:border-gold-300/40 hover:text-gold-200"
                  )}
                  stagger={STAGGER.tight}
                  className="mt-8"
                />
              </div>
            </div>
          </div>
        </div>

        {/* ════════════════════ MOVEMENT VI — One connected future ════════════════════ */}
        <div data-cine-movement="future" className="relative">
          <div className="shell py-20 text-center md:py-24">
            <CineLine as="h3" text="From knowledge to possibility." className={cn(BIG, "mx-auto max-w-3xl")} />
            {/* An `<ol>` — the chain is a sequence, and "list, five items" is the point of it. */}
            <Reveal
              as="ol"
              delay={0.08}
              className="mx-auto mt-10 flex max-w-4xl flex-wrap items-center justify-center gap-y-3"
            >
              {IMPACT_CHAIN.map((word, index) => {
                const last = index === IMPACT_CHAIN.length - 1;
                return (
                  <li key={word} className="flex items-center">
                    {index > 0 ? (
                      <span
                        aria-hidden="true"
                        className="mx-2 block h-px w-6 bg-gradient-to-r from-gold-300/60 to-gold-300/15 sm:w-10"
                      />
                    ) : null}
                    <span
                      data-cine-link=""
                      className={cn(
                        CHIP,
                        "transition-colors duration-300 ease-out",
                        last
                          ? "!border-gold-300/50 !text-gold-200"
                          : "[&.is-lit]:border-gold-300/40 [&.is-lit]:text-gold-200"
                      )}
                    >
                      {word}
                    </span>
                  </li>
                );
              })}
            </Reveal>
            <Reveal className="mx-auto mt-8 max-w-3xl">
              <p className={cn(SUPPORT, "mx-auto max-w-[52ch]")}>
                By connecting disciplines and communities, the Centre aims to create new
                possibilities for how craft knowledge is preserved, studied, experienced and carried
                forward.
              </p>
            </Reveal>

            {/* The convergence: nine words REST on their ring and the scrub carries them in from
                far outside it, tilting home — the reader's own descent gathers the ecosystem. */}
            {/* `sm:` on the min-height, deliberately: the ring the height exists FOR is hidden on
                phones, and 34rem of empty night around two statements read as a broken band there
                (the review measured it). Phones get ordinary padding instead. */}
            {/* `md:`, not `sm:`, for both the ring and its height: at sm widths the mid-row seats
                sit level with the centre statement and collide with it at rest (the review placed
                the boxes). The ring needs the room a tablet has. */}
            <div
              data-cine-ring=""
              className="relative mx-auto mt-24 flex max-w-5xl flex-col items-center justify-center py-14 md:min-h-[40rem] md:py-0"
            >
              <div
                aria-hidden="true"
                data-cine-bloom=""
                className="pointer-events-none absolute left-1/2 top-1/2 h-[80%] w-[90%] -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  background: `radial-gradient(closest-side, ${NATURAL_DYES.lac.color.replace(")", " / 0.16)")}, transparent 70%)`
                }}
              />
              <div aria-hidden="true" className="absolute inset-0 hidden md:block">
                {CONVERGING.map((entry) => (
                  <span
                    key={entry.word}
                    data-cine-converge=""
                    data-dx={entry.dx}
                    data-dy={entry.dy}
                    data-rot={entry.rot}
                    className={cn("absolute", entry.seat)}
                  >
                    <span className={cn(CHIP, "!border-white/10 !text-white/60")}>{entry.word}</span>
                  </span>
                ))}
              </div>

              <div className="relative">
                <CineLine as="h3" text="One ecosystem." className={HUGE} />
                <CineLine
                  as="p"
                  text="One connected future."
                  accent="One connected future."
                  className={cn(HUGE, "mt-2")}
                />
              </div>
            </div>

            {/* The identity lock — everything stripped back, the mark complete, the thread home. */}
            <Reveal className="mx-auto mt-24 max-w-3xl">
              <KolamMark cols={5} rows={3} className="mx-auto w-24 text-gold-300/70 sm:w-28" />
              <p className={cn(KICKER, "mt-8")}>IIT Kharagpur</p>
              <CineLine as="p" text="Centre of Excellence" className={cn(HUGE, "mt-4")} />
              <p className="mt-4 font-display text-base font-semibold uppercase leading-relaxed tracking-[0.14em] text-white/75 sm:text-lg">
                For unified AI-enabled
                <br />
                craft ecosystem platform
              </p>
              <p className="mt-7 font-display text-lg italic text-gold-300 sm:text-xl">
                Where heritage meets intelligence.
              </p>
            </Reveal>
          </div>

          {/* The dawn — the story hands the page back to daylight. */}
          <div
            aria-hidden="true"
            className="h-40 w-full"
            style={{ background: "linear-gradient(to bottom, transparent, var(--bg-0))" }}
          />
        </div>
      </CinematicScrollStage>
    </section>
  );
}
