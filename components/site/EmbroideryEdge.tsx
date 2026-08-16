"use client";

/**
 * EmbroideryEdge — a worked selvedge down the left and right of the page's paper.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS. A length of hand-printed cotton is finished at both selvedges with a narrow worked
 * border: a running stitch down each side and a column of small `buti` between them, at a fraction
 * of the size of the ones in the field. It is the last thing a printer adds and the first thing you
 * see when the cloth is folded. That is what this draws, at the edge of the light part of the page —
 * a decorated margin, not a border. If it is the first thing a reader notices, it is too strong.
 *
 * THE GEOMETRY IS NOT NEW. Every path comes from `BUTI_BY_ID` in components/craft/motifs.ts — the
 * same four blocks `BlockPrintField` prints across the hero, drawn here at roughly half size in a
 * 20 × 56 unit tile. Nothing about the ornament is invented at this edge; only the arrangement is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ ONE `mask-image`, NOT A HUNDRED ELEMENTS AND NOT A COLOURED PICTURE. The tile is built once at
 * module load into an SVG data URI and handed to CSS as a mask, exactly the reading `JaaliScreen`
 * argues for: the strip is a plain rectangle of a TOKEN colour with the stitches cut out of it. So
 * the thread follows `--ink-300` into the dark theme like everything else on the site, and there is
 * one element per edge rather than one per stitch. A background IMAGE would have had to bake a
 * neutral into the URI and then carry a second, dark copy of it — a literal colour that could not
 * invert, which is precisely what contract §1.2 exists to stop.
 *
 * ⚠ IT IS `position: fixed`, WHICH IS THE ONLY PLACEMENT THAT WORKS ON THIS SITE. Three were tried
 * on paper before this one was written:
 *
 *   • A strip BEHIND the content, showing through the gap between the page canvas and the sections.
 *     There is no such gap — `components/site/SplashCursor.tsx`'s header records the same discovery
 *     for the fluid canvas: "this site's sections carry full-width opaque grounds of their own", so
 *     anything under them is under everything, always.
 *   • A background painted onto each of `<main>`'s children. That means writing `background-image`
 *     over whatever ground a section already has — `.grad-mesh` and `.ambient-light` are two of the
 *     three sanctioned gradient recipes and both are backgrounds — and it means the ornament's shape
 *     depends on a page structure the CMS decides, not this file.
 *   • An absolute overlay the full height of the frame, with the purple bands raised above it. That
 *     one works and is still wrong: raising `[data-splash-off]` to a rung above the fluid cursor is
 *     a real change to how the hero, the story and the footer paint, made from a stylesheet, in the
 *     name of a decorative margin. The blast radius is three of the biggest surfaces on the site.
 *
 * Fixed costs one `IntersectionObserver` and nothing else: no stacking contract is touched, no
 * section's background is overwritten, and it works identically on a page the studio built this
 * morning. It also cannot lengthen the document — a fixed box contributes nothing to scrollable
 * overflow — so there is no width at which this produces a horizontal scrollbar.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHY IT READS `data-splash-off` RATHER THAN AN ATTRIBUTE OF ITS OWN
 *
 * The edge must not appear over the three dark purple bands — the hero, the cinematic story and the
 * closing footer. All three already carry `data-splash-off`, and the decision went this way:
 *
 *   • A NEW attribute (`data-edge-off`, say) would have to be added to `HeroSection`,
 *     `CinematicScroll` and `SiteFooter` — and then remembered by whoever writes the fourth purple
 *     band. An opt-out nobody remembers to set fails SILENTLY and in the ugliest possible direction:
 *     pale lavender stitching down both sides of a night-dark hero.
 *   • Reusing `data-splash-off` risks the other trap — one attribute meaning two things, so a later
 *     hand removing the fluid cursor takes the attribute with it and breaks something unrelated.
 *
 * What settles it is that `data-splash-off` HAS NO READER TODAY. Grep it: three files set it, none
 * consumes it. It is not the fluid cursor's private switch; it is a claim the three bands make about
 * themselves, and the comment beside each one says so in nearly the same words — "the splash cursor
 * stands down over the hero's own weather", "the story has its own weather". The set it names is
 * exactly "this band is a dark ground carrying its own atmosphere; site-wide ornament stands down
 * here", which is the question this component has to ask. Reusing it also means the answer is right
 * on every page from the moment this mounts, including CMS-built pages nobody has looked at.
 *
 * ⚠ SO THE ATTRIBUTE IS NOW LOAD-BEARING IN TWO PLACES AND MUST NOT BE CLEANED UP WITH THE CURSOR.
 * If `SplashCursor` is ever removed, `data-splash-off` stays. If a fourth dark band is added, it
 * carries the attribute. Those two sentences are the whole maintenance cost of this decision, and
 * they are cheaper than a second attribute with the same failure mode and none of the reach.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * FIRST PAINT. `showing` starts FALSE on the server and on the first client render, and only an
 * effect can ever turn it on (contract §8). That is not caution about hydration alone — the server
 * cannot know where the reader is on the page, and the homepage opens ON a dark band, so "visible
 * until proven otherwise" would stamp the stitching across the hero for one frame of every cold
 * load. Hidden is both the safe answer and the correct one for the commonest entry point.
 *
 * MOTION. The only thing that moves is `opacity`, as a CSS transition on a class this file adds or
 * withholds — the same shape as `KolamLattice`: the server markup carries the transitioning class,
 * so the reduced-motion rules in globals.css flatten it for the instant before hydration, and
 * `useReducedMotionPreference()` withholds it afterwards. A reader who asked for less motion gets
 * the edge appearing and disappearing instantly, which is a resting state rather than a stopped
 * animation. No framer here and no spring: this is one compositor property on a decoration, and
 * `components/motion/constants` exists so that a JS animation reaches the house curve — a CSS rule
 * can write that curve directly, which globals.css does.
 *
 * PLACEMENT. ONCE, in `app/(site)/layout.tsx`, inside the frame `<div>` that already holds the
 * header, `<main>` and the footer — beside `<SplashCursorMount />` is the natural spot, since the two
 * are the same kind of thing: a site-wide ornament that belongs to the frame rather than to a page.
 * It needs no `relative` parent and takes no space (the strips are fixed and the carrier is
 * `display: contents`), so nothing about that div has to change. It must NOT be mounted per page or
 * per section: the observer would then be one per instance, and two instances would ship the tile
 * twice.
 *
 * `aria-hidden` and `pointer-events: none`: it carries no information and must never take a press.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";

import { BUTI_BOX, BUTI_BY_ID, hashRange, type ButiId } from "@/components/craft/motifs";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

// ── The tile ──────────────────────────────────────────────────────────────────────────────────

/**
 * The repeat, in SVG user units. The width is `BUTI_BOX` so a buti at scale 1 would exactly fill it
 * and every scale below is legible as a fraction of the field's own motif.
 *
 * ⚠ 56 IS DIVISIBLE BY BOTH STITCH PERIODS (5.6 and 7.0) AND BY THE MOTIF PITCH (14), AND THAT IS
 * THE WHOLE REASON IT IS 56 RATHER THAN A ROUNDER NUMBER. `mask-repeat: repeat-y` butts one copy of
 * this tile against the next, so every rhythm in it has to come back into phase at the foot. See
 * `RAILS` below for the rest of that argument.
 */
const TILE_WIDTH = BUTI_BOX;
const TILE_HEIGHT = 56;

const RAIL_STROKE = 0.85;

interface Rail {
  /** Across the tile. The motifs run in the 13.2 units between the two. */
  readonly x: number;
  /** Thread, then ground. */
  readonly dash: number;
  readonly gap: number;
  /** Where the path starts, above the tile. See the ⚠ below — this is not a spare-room number. */
  readonly start: number;
  /** How much thread. An alpha in the mask, not a colour — the tile's header explains why. */
  readonly ink: number;
}

/**
 * The two rails of running stitch.
 *
 * ⚠ TWO CONSTRAINTS DECIDE THE DASH, THE GAP AND THE START ON BOTH RAILS, AND NEITHER IS COSMETIC.
 *
 *   1. **The period must divide 56.** `mask-repeat: repeat-y` butts one copy of the tile against the
 *      next, so a dash pattern that does not come back into phase at the tile's foot stutters once
 *      every repeat, all the way down a page — the one artefact that would give away that this is a
 *      tiled image. 2.4 + 3.2 = 5.6 goes ten times; 2.6 + 4.4 = 7.0 goes eight.
 *   2. **The seam must fall in the middle of a GAP.** The tile clips at y = 0 and y = 56, so a seam
 *      through a stitch cuts its round cap off square, on every repeat, on both rails. Each rail's
 *      `start` is therefore chosen to put a gap centre exactly on the boundary: -4.0 is 4.0 into a
 *      5.6 pattern whose gap runs from 2.4, and -4.8 is 4.8 into a 7.0 whose gap runs from 2.6.
 *
 * ⚠ AND THE TWO PATTERNS ARE DIFFERENT ON PURPOSE. One pattern on both rails means every stitch on
 * the left is level with a stitch on the right for the whole length of the page, which is the look of
 * a machine and not of two rows worked by hand at slightly different tensions. 10 against 8 never
 * repeats its relationship within the tile. Offsetting one copy of a single pattern instead was tried
 * on paper and cannot be done: a half-period offset puts constraint 2's gap centre under a stitch.
 */
const RAILS: readonly Rail[] = [
  { x: 3.4, dash: 2.4, gap: 3.2, start: -4, ink: 0.62 },
  { x: TILE_WIDTH - 3.4, dash: 2.6, gap: 4.4, start: -4.8, ink: 0.55 }
];

/**
 * The `rekh` outline weight, in buti units — deliberately about three times `BlockPrintField`'s 0.4.
 *
 * These motifs are drawn at roughly half size in a tile that renders about one user unit per device
 * pixel, so the field's own line weight would land at a fifth of a pixel: below the point where
 * anti-aliasing has anything to work with, and the outline would simply not be there.
 */
const REKH_STROKE = 1.15;

interface EdgeSlot {
  readonly buti: ButiId;
  /** Centre of the motif down the tile. Four slots at a pitch of 14. */
  readonly y: number;
  /** Fraction of `BUTI_BOX`. Chosen per motif so none of them touches the rails. */
  readonly scale: number;
}

/**
 * The border's own repeat: the mango, a dot, the jasmine, a dot.
 *
 * `bindi` between the two larger blocks is not filler chosen for rhythm — it is what its own entry
 * in motifs.ts says it is: "the dot filler that sits between the field butis in a jaal". A border
 * worked as ambi-phool-ambi-phool would be twice as loud and half as true.
 */
const SLOTS: readonly EdgeSlot[] = [
  { buti: "ambi", y: 7, scale: 0.52 },
  { buti: "bindi", y: 21, scale: 0.58 },
  { buti: "phool", y: 35, scale: 0.5 },
  { buti: "bindi", y: 49, scale: 0.58 }
];

/** Two decimal places, for the same reason motifs.ts rounds: the third decimal is smaller than a pixel. */
function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The tile, as an SVG document.
 *
 * ⚠ EVERYTHING IS PAINTED `black` AND NONE OF IT IS A COLOUR DECISION. This document is only ever
 * used as a `mask-image`, where an SVG source contributes its ALPHA channel and its hues are thrown
 * away. So the `opacity` on each group is not "how pale is this stitch" but "how much thread is
 * here" — the mask lets that much of the strip's token-coloured ground through, and the strip is
 * what carries the colour. Nothing white or black is ever painted on the page.
 *
 * The irregularity is `hashRange` keyed on the slot and a channel name, never `Math.random()` — the
 * same rule as every other drawn ornament in this repository, and here it is stronger than a
 * hydration argument: this string is built once and repeated down the whole page, so a random draw
 * would not merely differ between server and client, it would be a different border on every load.
 *
 * ⚠ AND THE JITTER LIVES INSIDE THE REPEAT, WHICH IS HONEST RATHER THAN A LIMITATION. A block-printed
 * border IS one carved block struck over and over: the wobble belongs to the block and repeats with
 * it. `BlockPrintField` can vary every impression because it draws every impression; a tiled mask
 * has exactly one, and pretending otherwise would need the hundred elements this avoids.
 */
function edgeTile(): string {
  const parts: string[] = [];

  for (const rail of RAILS) {
    // The path runs past both ends of the tile so the pattern is already in its stride at the seam;
    // the tile's own clip is what makes the ends invisible.
    parts.push(
      `<path d="M ${rail.x} ${rail.start} V ${TILE_HEIGHT - rail.start}" fill="none" stroke="black"` +
        ` stroke-width="${RAIL_STROKE}" stroke-dasharray="${rail.dash} ${rail.gap}"` +
        ` stroke-linecap="round" opacity="${rail.ink}"/>`
    );
  }

  SLOTS.forEach((slot, index) => {
    const buti = BUTI_BY_ID[slot.buti];

    /*
     * Read left to right as nested coordinate changes, identically to `impressionTransform` in
     * BlockPrintField: move to where the block landed, turn, scale, and centre the buti's own box on
     * that origin LAST — which is what makes the rotation happen about the motif rather than about
     * the corner of its box.
     */
    const x = r2(TILE_WIDTH / 2 + hashRange(-0.34, 0.34, "edge", index, "dx"));
    const y = r2(slot.y + hashRange(-0.5, 0.5, "edge", index, "dy"));
    const turn = r2(hashRange(-4, 4, "edge", index, "turn"));
    const place = [
      `translate(${x} ${y})`,
      `rotate(${turn})`,
      `scale(${slot.scale})`,
      `translate(${-BUTI_BOX / 2} ${-BUTI_BOX / 2})`
    ].join(" ");

    const solid = buti.solid.map((d) => `<path d="${d}"/>`).join("");
    const line = buti.line
      .map(
        (d) =>
          `<path d="${d}" fill="none" stroke="black" stroke-width="${REKH_STROKE}"` +
          ` stroke-linecap="round" stroke-linejoin="round"/>`
      )
      .join("");

    parts.push(
      `<g transform="${place}" fill="black">`,
      // The two passes of the cloth, in the order the printer works them: the solid `datta` block
      // laid thin, and the finer `rekh` outline struck over it with a fuller hand.
      `<g opacity="${r2(hashRange(0.46, 0.66, "edge", index, "datta"))}">${solid}</g>`,
      `<g opacity="${r2(hashRange(0.74, 0.96, "edge", index, "rekh"))}">${line}</g>`,
      `</g>`
    );
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_WIDTH}" height="${TILE_HEIGHT}"` +
    ` viewBox="0 0 ${TILE_WIDTH} ${TILE_HEIGHT}">${parts.join("")}</svg>`
  );
}

/**
 * Built ONCE per bundle, at module load, not per render and not in a `useMemo`.
 *
 * It depends on nothing — no prop, no theme, no measurement — so a hook would only be a promise to
 * recompute something that cannot change. `encodeURIComponent` rather than hand-escaping: it takes
 * the double quotes inside the markup to `%22`, which is the one thing that would otherwise close
 * the CSS `url("…")` early and silently leave both strips unmasked, i.e. two solid bars.
 */
const EDGE_MASK = `url("data:image/svg+xml,${encodeURIComponent(edgeTile())}")`;

/**
 * ⚠ THE URI IS HANDED OVER AS A CUSTOM PROPERTY ON A WRAPPER, AND IT SHIPS ONCE — WHICH IS THE WHOLE
 * REASON THERE IS A WRAPPER AT ALL.
 *
 * The encoded tile is about 8.4kB. Written as a `mask-image` on each strip it would be 8.4kB of
 * markup twice over, in the HTML and again in the RSC payload, on every public page of the site —
 * for an ornament. Declared once on a parent, both strips read it through inheritance and the string
 * appears exactly once. (Custom properties inherit down the DOM tree, so `display: contents` on the
 * wrapper is free: it generates no box, occupies no layout, and passes the value through regardless.)
 *
 * The division of labour is the same one `CraftTapestry` makes for its own mask: the URI is data this
 * file computes and can come from nowhere else, while the repeat, the size, the widths per breakpoint
 * and the paper edition are rules no Tailwind utility can express and live in globals.css. The
 * `-webkit-` spelling is written there too, beside the standard one.
 *
 * The cast is the house pattern for a custom property in a style object — `PartnerLogosSection` and
 * `PigmentDrift` write theirs the same way, because `CSSProperties` has no index signature and React
 * itself documents this as how a `--var` is passed.
 */
const EDGE_THREAD_STYLE = { "--cxa-edge-thread": EDGE_MASK } as CSSProperties;

/**
 * Complete literal class strings, looked up rather than assembled (contract §5). Nothing here is
 * built by concatenation, so every class in this file is greppable and Tailwind-scannable as written.
 */
const EDGE_CLASS = {
  set: "cxa-edge-set",
  left: "cxa-edge cxa-edge--left",
  right: "cxa-edge cxa-edge--right",
  lit: "cxa-edge--lit",
  fade: "cxa-edge--fade"
} as const;

/** The attribute the three dark bands already wear. See the header for why this and not a new one. */
const DARK_BAND_SELECTOR = "[data-splash-off]";

export function EmbroideryEdge() {
  const reduce = useReducedMotionPreference();
  const pathname = usePathname();
  const [showing, setShowing] = useState(false);

  /**
   * Is any dark band on screen right now?
   *
   * `threshold: 0` because the question is only ever "is any part of this in the viewport" — the
   * bands are full-width and taller than the screen, so a ratio would never reach a larger threshold
   * anyway. The strips are hidden while ANY band intersects, which means the edge stands down as the
   * story's first pixel arrives rather than when it has taken the screen: the alternative is
   * stitching that survives a few hundred pixels into a night-dark section, and an ornament that
   * overstays is worse than one that leaves early.
   *
   * ⚠ RE-QUERIED ON EVERY NAVIGATION, AND THAT IS NOT DEFENSIVE — IT IS THE BUG THIS COMPONENT WOULD
   * OTHERWISE HAVE. This mounts in the site frame, so it does NOT remount when the reader moves from
   * one public page to another: without `pathname` in the dependencies the observer would still be
   * holding the previous page's detached elements, which report nothing at all, and the edge would be
   * frozen at whatever the last page decided. Disconnecting and re-observing is the whole fix.
   *
   * ⚠ AND IT DROPS TO HIDDEN FIRST. The effect runs after the new page has been committed, so for the
   * frame in between, the previous page's answer is still on screen — which on a light-to-homepage
   * navigation is stitching over the top of the hero. Falling back to hidden and letting the observer
   * earn its way back is the same rule the first paint follows.
   */
  useEffect(() => {
    const bands = document.querySelectorAll<HTMLElement>(DARK_BAND_SELECTOR);

    /*
     * ⚠ THIS BRANCH DOES NOT FIRE IN THE PUBLIC FRAME, AND IT IS NOT DEAD CODE. `SiteFooter` wears
     * the attribute on every page of the site, so there is always at least one band to observe. It is
     * here because the component must not depend on that staying true: an observer with nothing to
     * observe never calls back, so "wait until the observer says it is safe" would leave the edge
     * hidden for ever on any surface that happens to have no dark band on it. The safe default at
     * first paint is hidden; the safe answer when there is provably nothing to hide from is shown.
     */
    if (bands.length === 0) {
      setShowing(true);
      return;
    }

    setShowing(false);

    // The set, rather than a count: an observer delivers one entry per target and re-delivers the
    // same target whenever it crosses, so counting would drift the first time two bands are on
    // screen together (the hero leaving while the story arrives, on a page that has both).
    const covered = new Set<Element>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) covered.add(entry.target);
          else covered.delete(entry.target);
        }
        setShowing(covered.size === 0);
      },
      { threshold: 0 }
    );

    for (const band of bands) observer.observe(band);
    return () => observer.disconnect();
  }, [pathname]);

  return (
    <div aria-hidden="true" style={EDGE_THREAD_STYLE} className={EDGE_CLASS.set}>
      <div className={cn(EDGE_CLASS.left, showing && EDGE_CLASS.lit, !reduce && EDGE_CLASS.fade)} />
      {/* The right-hand strip is the same tile MIRRORED, in globals.css — a border is worked
          inwards from each selvedge, so the mango leans towards the text on both sides. */}
      <div className={cn(EDGE_CLASS.right, showing && EDGE_CLASS.lit, !reduce && EDGE_CLASS.fade)} />
    </div>
  );
}
