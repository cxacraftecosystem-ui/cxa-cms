"use client";

/**
 * MapHoverCard — what is under the pointer, with a picture of the work.
 *
 * It replaces the SVG hover label this map used to draw. That label was a black lozenge holding the
 * place name and its ordinal; the card says the same two things and adds the piece of information the
 * whole section is about — a craft that is actually made there, and one of the Centre's own contact
 * sheets showing that kind of work. It is HTML rather than a `<foreignObject>` inside the picture,
 * because a plate is a `next/image` with a blur placeholder and a srcset and none of that survives
 * being drawn into an SVG.
 *
 * ⚠ IT IS NOT CLIPPED, AND THE THREE REASONS ARE WORTH KNOWING BEFORE MOVING IT. It is positioned
 * against `IndiaMap`'s own wrapper, which has no `overflow` of its own; the map's `<svg>` cannot clip
 * it because the card is a SIBLING of the svg rather than a child; and it deliberately does not live
 * in the column beside the map, which is a scroller (`lg:overflow-y-auto` in IndiaMapStage) and would
 * cut the card off at the first row. Adding `overflow-hidden` to the wrapper would undo all of this.
 *
 * ⚠ IT NEVER COVERS ITS OWN PIN. The card is placed on the pin's far side — below a pin in the top of
 * the map, above one in the rest of it — with the pin's own radius plus a gap of clear space between
 * the two. The reader can always see the mark they are pointing at, which is what stops the card
 * reading as a thing that ate the pin.
 *
 * ⚠ `aria-hidden`, AND NOT AS AN OVERSIGHT. Everything here is said as text by the row beside the map
 * (`MapPlaceList`) — place, count, and the same craft in an `sr-only` clause — and the row is what
 * actually holds focus when a keyboard reader lights a pin. Announcing the card too would say every
 * one of those things twice, in the same breath, to the one reader who cannot glance past it.
 *
 * ⚠ TOUCH HAS NO HOVER, and the answer is not "make it a tooltip on tap and hope". Tapping a pin
 * PINS the hover (`IndiaMapStage.onSelect`), which shows this card until the same pin is tapped
 * again; and below `lg` the list sits directly under the map, so a reader who never taps anything
 * still gets every place, every count and a link, which is the interface the picture is decorating.
 */

import Image from "next/image";
import { motion } from "framer-motion";

import type { PlacedPin } from "@/components/map/layout";
import { VIEW_BOX } from "@/components/map/projection";
import { scaleIn } from "@/components/motion/variants";

/**
 * The card's width in pixels, WRITTEN TWICE ON PURPOSE — as `w-96` in the class list below and as
 * this number in the arithmetic that keeps it inside the map. Tailwind purges any class it cannot
 * find spelled out in full (contract §5), so the class cannot be built from this constant, and the
 * `clamp()` cannot be written without it. They are one decision; move them together.
 *
 * 384px is not a taste: `lib/media/craft-sheets.ts` asks for a frame no narrower than about 380 CSS
 * px, because a sheet is a mosaic of six to eight photographs and at thumbnail size each cell is a
 * smudge. This is the smallest card that can honestly show one.
 */
const CARD_WIDTH = 384;

/** Clear space between the pin's edge and the card, in SVG user units. */
const CLEARANCE = 14;

/**
 * Above this fraction of the map's height, the card goes ABOVE the pin instead of below it.
 *
 * Not 0.5: a card is about a third of the map's height, so a pin at the exact middle with the card
 * below it would push the card past the bottom edge and over whatever follows the section. Flipping
 * a little earlier keeps almost every card within the picture it belongs to.
 */
const FLIP_AT = 0.42;

/** A user-space coordinate as a percentage of the wrapper, which is exactly the svg's own box. */
function percent(value: number, span: number): string {
  return `${((value / span) * 100).toFixed(3)}%`;
}

export interface MapHoverCardProps {
  pin: PlacedPin;
  /** The number this place carries in the list beside the map. See `IndiaMap`'s `ordinals`. */
  ordinal?: number;
  reduce: boolean;
}

export function MapHoverCard({ pin, ordinal, reduce }: MapHoverCardProps) {
  const { point } = pin;
  const above = pin.y > VIEW_BOX.height * FLIP_AT;

  /*
   * Placed with `top` or `bottom` rather than a `top` and a `translateY(-100%)`, and that is the
   * difference between working and silently not. framer writes this element's `transform` as an
   * inline style for the scale below, so a Tailwind `-translate-y-full` would be overwritten the
   * instant the card animates (the same trap Reveal.tsx documents for its children). Anchoring the
   * card's BOTTOM edge above the pin needs no transform at all and no knowledge of its height.
   */
  const vertical = above
    ? { bottom: percent(VIEW_BOX.height - (pin.y - pin.radius - CLEARANCE), VIEW_BOX.height) }
    : { top: percent(pin.y + pin.radius + CLEARANCE, VIEW_BOX.height) };

  /*
   * Centred on the pin, then clamped inside the wrapper so a pin near either coast does not push the
   * card out of the section. CSS `clamp()` resolves `max < min` to the MIN, which is exactly the
   * behaviour wanted on a narrow phone: the wrapper is then under 384px, `max-w-full` shrinks the
   * card to the wrapper, and this pins it to the left edge instead of hanging it off the right.
   */
  const left = `clamp(0px, calc(${percent(pin.x, VIEW_BOX.width)} - ${CARD_WIDTH / 2}px), calc(100% - ${CARD_WIDTH}px))`;

  const craft = point.craft;
  const sheet = craft?.sheet ?? null;

  return (
    <motion.div
      aria-hidden="true"
      variants={scaleIn(reduce)}
      initial="hidden"
      animate="visible"
      // `exit` reuses `hidden`: the card leaves the way it arrived, and there is no fourth variant to
      // keep in step with the other three.
      exit="hidden"
      style={{ left, ...vertical }}
      className={
        // `pointer-events-none` is load-bearing rather than tidy: the card overlaps other pins, and a
        // card that could take the pointer would steal the hover from the pin underneath it and then
        // vanish, which is an interface that flickers when you move diagonally.
        //
        // `z-10` is the in-page rung of the ladder (contract §6). NOT 70 — that rung is for popovers
        // portalled to `<body>`, and this one scrolls with the map and must pass UNDER the site
        // header at 50 rather than over it.
        "pointer-events-none absolute z-10 w-96 max-w-full rounded-lg bg-card p-3 shadow-panel ring-1 ring-line-200"
      }
    >
      {craft ? (
        <p className="font-display text-base font-bold leading-tight text-ink-900">{craft.name}</p>
      ) : null}

      {/* The ordinal leads, exactly as the old SVG label did, so "3 · Kachchh" still means one thing
          in the picture and in the list. */}
      <p className={craft ? "mt-1 text-xs text-ink-500" : "text-xs text-ink-500"}>
        {ordinal ? (
          <span className="font-display font-bold tabular-nums text-purple-700">{ordinal} · </span>
        ) : null}
        {point.name} ·{" "}
        <span className="tabular-nums">
          {point.total === 1 ? "1 craft" : `${point.total} crafts`}
        </span>
      </p>

      {sheet ? (
        <figure className="mt-2.5">
          {/*
            ⚠ INTRINSIC SIZING, NEVER `aspect` + `object-cover`. A sheet is a mosaic of six to eight
            cells on a cream ground; cropping it to a shape this card preferred would cut cells in
            half and leave a row of severed photographs down one edge. `width`/`height` are of the
            stored file, so `h-auto w-full` reserves the exact box and the card does not resize under
            the pointer when the picture decodes — which on a hover card would look like a twitch.

            LAZY, and deliberately so: this mounts on the first hover, so a map of twenty pins costs a
            reader who hovers nothing exactly nothing. The blur placeholder is inline in the manifest,
            under a kilobyte, so the frame is filled from the first frame of the animation rather than
            being an empty rectangle while the plate arrives.
          */}
          <div className="overflow-hidden rounded-sm bg-surface-100">
            <Image
              src={sheet.src}
              // Named as what it is — a plate OF photographs. `aria-hidden` above means no screen
              // reader will read this; it is here for the reader whose images fail to load.
              alt={`A plate of photographs of ${sheet.title.toLowerCase()}`}
              width={sheet.width}
              height={sheet.height}
              sizes="(max-width: 420px) 90vw, 360px"
              placeholder="blur"
              blurDataURL={sheet.blurDataUrl}
              className="h-auto w-full"
            />
          </div>
          {/*
            The caption names the PLATE's subject, not the craft above it, and that is what keeps the
            picture honest whether the plate was matched to this craft's technique or picked by the
            hash of its slug. See craftSheetFor.ts.
          */}
          <figcaption className="mt-1.5 text-[11px] leading-snug text-ink-500">
            Contact sheet: {sheet.title}
          </figcaption>
        </figure>
      ) : null}
    </motion.div>
  );
}
