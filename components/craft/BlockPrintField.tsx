"use client";

/**
 * BlockPrintField — Bagru and Sanganeri hand block printing, drawn in code.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, SO NOBODY LATER TURNS IT INTO WALLPAPER.
 *
 * In Bagru and Sanganeri, west of Jaipur, a length of cotton is printed by hand with carved
 * teakwood blocks. A field of small repeated motifs — `buti` — is laid down block by block: the
 * printer inks the `datta` block, sets it against the cloth, strikes it with the heel of the hand,
 * lifts, moves along by one repeat, and does it again several thousand times. A second, finer
 * `rekh` block then prints the outline over the top in a different colour.
 *
 * **THE MISREGISTRATION IS THE CRAFT.** No hand puts a block down twice in the same place. Every
 * impression sits a little off its neighbour, turns a fraction of a degree, and carries a little
 * more or less ink than the one before. A mathematically perfect grid of identical stamps is not a
 * cleaner version of this — it is a different object called wallpaper, and it says the Centre
 * studies machine printing. So:
 *
 *   • each impression is displaced by up to 2.6% of the repeat and turned by up to 1.4°;
 *   • the `rekh` outline gets its OWN, independent displacement, so the line sits a hair off its
 *     own fill exactly as it does on cloth — this is the single most recognisable tell of hand
 *     block printing and it is worth the second `<use>` per cell;
 *   • ink density varies per impression, and roughly one in nine prints faint because the block
 *     was running dry.
 *
 * Every one of those numbers comes from `stableHash` keyed on the cell and a channel name. NOT
 * `Math.random()`: the field is rendered on the server and again on the client, and a random one
 * would be a hydration mismatch; it would also re-roll on every re-render, so the cloth would
 * twitch whenever an unrelated piece of state changed. Same seed, same cloth, for ever.
 *
 * The layout is a HALF-DROP repeat — alternate rows offset by half a pitch — which is how a block
 * repeat is actually set out, and it alternates the field buti with a smaller filler buti, which is
 * how a `jaal` (net) design is built from two blocks rather than one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PERFORMANCE. The two blocks are defined ONCE in `<defs>` and every impression is a `<use>`, so
 * the browser instances the geometry instead of holding a copy of it per cell. At the default pitch
 * that is about 140 nodes, which is the largest single layer of the tapestry and is why the pitch
 * is a prop: `CraftTapestry`'s "quiet" intensity passes a bigger one and gets half the count.
 *
 * The whole thing is `aria-hidden` and carries no information; there is nothing here for a screen
 * reader to be told about. It has no motion of its own either — a printed cloth does not move —
 * so there is nothing here for `useReducedMotionPreference` to branch on. What parallax it has is
 * applied by `CraftTapestry` one level up, from a single scroll listener.
 */

import { Fragment, useId, useMemo } from "react";

import {
  BUTI_BOX,
  BUTI_BY_ID,
  hashRange,
  hashUnit,
  NATURAL_DYES,
  type ButiId
} from "@/components/craft/motifs";
import { cn } from "@/lib/utils";

/**
 * The drawing surface, in the SVG's own units, at roughly the proportions of a hero.
 *
 * `preserveAspectRatio="xMidYMid slice"` covers whatever box the caller gives it, so the buti
 * keeps very nearly the same size on a phone as on a desktop — which a percentage-based layout
 * would not do, and a wildly different motif size would read as two different cloths.
 */
const VIEW_WIDTH = 1180;
const VIEW_HEIGHT = 740;

/** The motif is drawn at `pitch / BUTI_PITCH_RATIO`, so the design is identical at every pitch. */
const BUTI_PITCH_RATIO = 44;

/** In buti units, so it scales with the motif — an outline block does not get finer on bigger cloth. */
const REKH_STROKE_WIDTH = 0.4;

export interface BlockPrintFieldProps {
  /** Sizing and colour. The SVG has no size of its own — give it `h-full w-full`. */
  className?: string;
  /** The repeat, in SVG units. Bigger is a sparser field and fewer nodes. */
  pitch?: number;
  /** The buti that carries the field. */
  fieldButi?: ButiId;
  /** The smaller buti that sits in the half-drop positions. */
  fillerButi?: ButiId;
  /** Changes every impression's drift without changing the design. Same seed, same cloth. */
  seed?: string;
}

interface Impression {
  key: string;
  buti: ButiId;
  /** Transform for the `datta` (fill) block. */
  fillTransform: string;
  /** Transform for the `rekh` (outline) block — deliberately not the same one. */
  lineTransform: string;
  fill: string;
  stroke: string;
  fillOpacity: number;
  lineOpacity: number;
}

export function BlockPrintField({
  className,
  pitch = 150,
  fieldButi = "ambi",
  fillerButi = "phool",
  seed = "bagru"
}: BlockPrintFieldProps) {
  // `<defs>` ids must be unique per instance: two tapestries on one page would otherwise both
  // point their `<use>` elements at whichever definition came first in the document.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  const impressions = useMemo(
    () => layOutField(pitch, fieldButi, fillerButi, seed),
    [pitch, fieldButi, fillerButi, seed]
  );

  // Only the two blocks in play are defined. Defining all four would put unreferenced geometry in
  // the document for no reason.
  const blocks = useMemo(
    () => Array.from(new Set<ButiId>([fieldButi, fillerButi])).map((id) => BUTI_BY_ID[id]),
    [fieldButi, fillerButi]
  );

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      className={cn("block", className)}
    >
      <defs>
        {blocks.map((buti) => (
          <Fragment key={buti.id}>
            {/*
              No `fill` or `stroke` on the definitions: paint properties inherit through `<use>`
              from the referencing element, so one definition serves every colourway and the
              per-impression ink density is a plain `opacity` on the `<use>`.
            */}
            <g id={`${uid}-${buti.id}-datta`}>
              {buti.solid.map((d, index) => (
                <path key={index} d={d} />
              ))}
            </g>
            <g id={`${uid}-${buti.id}-rekh`}>
              {buti.line.map((d, index) => (
                <path
                  key={index}
                  d={d}
                  fill="none"
                  strokeWidth={REKH_STROKE_WIDTH}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>
          </Fragment>
        ))}
      </defs>

      {impressions.map((impression) => (
        <Fragment key={impression.key}>
          <use
            href={`#${uid}-${impression.buti}-datta`}
            transform={impression.fillTransform}
            fill={impression.fill}
            opacity={impression.fillOpacity}
          />
          <use
            href={`#${uid}-${impression.buti}-rekh`}
            transform={impression.lineTransform}
            stroke={impression.stroke}
            opacity={impression.lineOpacity}
          />
        </Fragment>
      ))}
    </svg>
  );
}

/**
 * Every impression on the cloth: where it landed, how far it turned, and how wet the block was.
 *
 * The grid starts one pitch outside the viewBox on each side so no impression is cut in half by
 * the edge of the drawing surface — the caller's box then crops wherever it likes, which is what a
 * length of cloth looks like when you only see part of it.
 */
function layOutField(
  pitch: number,
  fieldButi: ButiId,
  fillerButi: ButiId,
  seed: string
): Impression[] {
  const scale = pitch / BUTI_PITCH_RATIO;
  const cols = Math.ceil(VIEW_WIDTH / pitch) + 2;
  const rows = Math.ceil(VIEW_HEIGHT / pitch) + 2;

  /** 2.6% of the repeat. On a 40mm block that is a millimetre — squarely within a hand's range. */
  const drift = pitch * 0.026;
  const turn = 1.4;

  /**
   * How far the outline block can sit off ITS OWN fill — a fifth of the impression's own drift.
   *
   * Small, and much smaller than `drift`, because the printer registers the `rekh` block against an
   * impression that is already on the cloth rather than against the grid. Two independent draws
   * from the full range would let an outline detach from its fill by a quarter of the motif, which
   * reads as a rendering fault and not as a hand.
   */
  const registration = drift * 0.2;

  const impressions: Impression[] = [];

  for (let row = 0; row < rows; row += 1) {
    // The half-drop: alternate rows step across by half a repeat. It is what stops the field
    // reading as columns, and it is how the printer keeps the join between two block widths from
    // running in a straight line down the cloth.
    const rowOffset = row % 2 === 1 ? pitch / 2 : 0;

    for (let col = 0; col < cols; col += 1) {
      const filler = (row + col) % 2 === 1;
      const buti = filler ? fillerButi : fieldButi;
      const cell = `${seed}:${col},${row}`;

      const baseX = -pitch + col * pitch + rowOffset;
      const baseY = -pitch + row * pitch;

      // Where the hand actually put the block this time.
      const fillX = baseX + hashRange(-drift, drift, cell, "fill-dx");
      const fillY = baseY + hashRange(-drift, drift, cell, "fill-dy");
      const fillTurn = hashRange(-turn, turn, cell, "fill-turn");
      // The block itself swells and shrinks a little with the damp; ±3% is what that looks like.
      const fillScale = scale * hashRange(0.97, 1.03, cell, "fill-scale");

      const fillTransform = impressionTransform(fillX, fillY, fillTurn, fillScale);

      // The outline block goes down in a SECOND PASS, lined up by eye against the fill that is
      // already on the cloth. So its error is measured from the fill and not from the grid — and it
      // is a separate hash channel, because the two passes are two separate acts of judgement.
      const lineTransform = impressionTransform(
        fillX + hashRange(-registration, registration, cell, "line-dx"),
        fillY + hashRange(-registration, registration, cell, "line-dy"),
        fillTurn + hashRange(-0.5, 0.5, cell, "line-turn"),
        // Both blocks are cut to one size; what differs between the passes is how far the ink
        // spread, which is a fraction of a percent.
        fillScale * hashRange(0.995, 1.008, cell, "line-scale")
      );

      // The block running dry. One impression in nine prints faint, which is what tells you a
      // person was re-charging the block from the tray rather than a machine metering ink.
      const dry = hashUnit(cell, "ink") < 0.11;
      const density = hashRange(0.72, 1, cell, "density");

      impressions.push({
        key: cell,
        buti,
        fillTransform,
        lineTransform,
        // Two blocks, two colours, which is what a Bagru colourway is: the field in indigo and the
        // filler in madder. A trace of turmeric stands in for the third block's pass.
        fill: filler
          ? hashUnit(cell, "dye") < 0.08
            ? NATURAL_DYES.turmeric.color
            : NATURAL_DYES.madder.color
          : NATURAL_DYES.indigo.color,
        stroke: NATURAL_DYES.indigoDeep.color,
        fillOpacity: round2(dry ? density * 0.38 : density),
        lineOpacity: round2((dry ? density * 0.34 : density) * 0.8)
      });
    }
  }

  return impressions;
}

/**
 * Place a buti.
 *
 * Read left to right as nested coordinate changes: move the origin to where the impression
 * landed, turn, scale, and only then shift the buti's own centre onto that origin. Doing the
 * centring last is what makes the rotation happen about the motif rather than about the corner of
 * its box.
 */
function impressionTransform(x: number, y: number, degrees: number, scale: number): string {
  const half = BUTI_BOX / 2;
  return [
    `translate(${round2(x)} ${round2(y)})`,
    `rotate(${round2(degrees)})`,
    `scale(${round2(scale)})`,
    `translate(${-half} ${-half})`
  ].join(" ");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
