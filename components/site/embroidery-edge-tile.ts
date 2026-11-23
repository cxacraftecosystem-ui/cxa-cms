/**
 * The repeat of the stitched page edge, as SVG markup — the geometry half of components/site/EmbroideryEdge.tsx.
 *
 * ⚠ IT DOES NOT SHIP TO THE BROWSER. It is run once, by scripts/build-edge-thread.ts, to write
 * public/edge-thread.svg, which globals.css hands to both strips as their mask. Built from `BUTI_BY_ID`
 * in components/craft/motifs.ts, which is why it lives in TypeScript at all; drawing it in the browser
 * shipped that whole module (~14 KB compressed) to every page, and building it on the server sent the
 * 8.4 kB result inside every page's HTML and payload. As a static file it is downloaded once and cached.
 *
 * tests/site/edge-thread.test.ts fails if public/edge-thread.svg stops matching what this module
 * produces, so a change to the motifs or the tile cannot ship with a stale file; the failure says to run
 * `npx tsx scripts/build-edge-thread.ts`.
 */

import { BUTI_BOX, BUTI_BY_ID, hashRange, type ButiId } from "@/components/craft/motifs";

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
export function edgeTileSvg(): string {
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

