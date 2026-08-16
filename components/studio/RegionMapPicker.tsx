"use client";

/**
 * RegionMapPicker — the country, and the one pin you are placing on it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT EXISTS. Until this component the only way to put a craft region on the homepage map was to
 * type two decimal numbers into `RegionMapManager` — which is a fine interface for somebody holding a
 * gazetteer and a useless one for somebody who knows perfectly well where Kutch is and has no idea
 * that it is 23.7337 N, 69.8597 E. Both people now get an interface: this map writes the numbers, the
 * numbers move this map, and NEITHER is the only way in. That is the whole design, and it is the
 * reason the numeric fields beside it were not replaced.
 *
 * ⚠ IT DRAWS AT THE SAME `VIEW_BOX`, THROUGH THE SAME `project`, AS THE PUBLIC MAP. That is not a
 * tidiness point: an editor clicks here and checks the result on the homepage, and two maps that
 * disagree about where a coordinate lands would make every placement look wrong by a few pixels with
 * nothing on either screen to explain it. `components/map/projection.ts` is the only projection in
 * the app; the click path is its `unproject`, which is that file's own algebraic inverse.
 *
 * ⚠ A CLICK OUTSIDE THE BOX IS REFUSED, NEVER CLAMPED. The box below is the server's
 * (`app/api/studio/crafts/regions/[id]/route.ts`) and the numeric fields' — one set of constants for
 * all three now, so the three cannot drift. The refusal is not theoretical: the user space is
 * `INDIA_BOUNDS` plus 24 units of padding, which on the horizontal axis is 0.74 of a degree, so the
 * left edge of this picture is 67.47 E and the right edge 98.13 E — a thin strip down either side is
 * genuinely outside the box. (The top and bottom, 37.77 N and 6.07 N, are not.) Clamping such a click
 * would store a coordinate the editor never chose and could not be shown to have chosen; the refusal
 * names the point that was clicked and the bound it broke, and changes nothing.
 *
 * THE PICTURE IS `aria-hidden` AND THE PIN IS A REAL BUTTON — the same split `IndiaMap` makes, for
 * the same reason. An SVG full of tabbable circles is "button, button, button" with nothing to
 * compare; what a screen-reader user needs here is the pin's coordinates in words and a way to change
 * them, which is the button's label, the arrow keys, and the two number fields beside the map. The
 * faint pins for regions already placed have no textual twin because they already have one: they are
 * the rows of the very list this picker is opened from, each of which says "On the map."
 *
 * NO MOTION AT ALL, DELIBERATELY — so there is no `useReducedMotionPreference` here and none is
 * missing. A pin that slides to where you clicked is a pin that is briefly somewhere you did not
 * click, on a control whose entire job is to report a position truthfully; and an animated `left`/`top`
 * is a layout animation besides. It simply appears where it belongs.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { memo, useId, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent } from "react";

import { indiaOutlinePath, project, unproject, VIEW_BOX } from "@/components/map/projection";
import { HelpText } from "@/components/studio/HelpText";
import { cn } from "@/lib/utils";

/**
 * ⚠ THE ONE COPY OF THE BOX ON THE CLIENT. `RegionMapManager` imports these rather than declaring
 * its own, so the sentence under a number field, the refusal under this map and the 422 from
 * `app/api/studio/crafts/regions/[id]/route.ts` all name the same four numbers. The route's own
 * header explains where they come from: the whole-degree box enclosing `INDIA_BOUNDS` in
 * components/map/indiaGeometry.ts. Change them there and here together, or the studio starts
 * accepting pins the server refuses.
 */
export const LAT_MIN = 6;
export const LAT_MAX = 38;
export const LNG_MIN = 68;
export const LNG_MAX = 98;

/** A region that already has coordinates, drawn faintly so an editor can see the archive's shape. */
export interface PlacedRegion {
  id: string;
  latitude: number;
  longitude: number;
}

export interface RegionMapPickerProps {
  /** The wrapper's id, so the disclosure that opens this can point `aria-controls` at it. */
  id: string;
  /** Named in the pin's label — "Kutch’s pin" is worth more to a screen reader than "pin". */
  regionName: string;
  /** The region's CURRENT coordinates as the fields hold them; `null` when either box is empty. */
  latitude: number | null;
  longitude: number | null;
  /** Every OTHER placed region. The active one is drawn as the pin, not as one of these. */
  others: readonly PlacedRegion[];
  /** Both numbers, already inside the box — a refused click never reaches this. */
  onPick: (latitude: number, longitude: number) => void;
  className?: string;
}

/**
 * Four decimal places, which is about eleven metres.
 *
 * A click carries far more precision than it means — at this scale one pixel is roughly eight
 * kilometres — and storing `23.733712894736843` would state an accuracy nobody has. Four places is
 * also the shape of the numbers the fields already suggest (`26.9124`), so a clicked value and a
 * typed one look like the same kind of thing in the same box.
 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** "23.7337 N, 69.8597 E" — `String` rather than `toFixed`, so a typed 26.9 stays 26.9. */
function coordinates(latitude: number, longitude: number): string {
  return `${String(round(latitude))} N, ${String(round(longitude))} E`;
}

/**
 * How far one arrow key moves the pin, in degrees: about 11 km, and 1.1 km with Shift held.
 *
 * The coarse step is deliberately a step you can SEE at this size — a nudge smaller than a pixel is a
 * control that appears not to respond — and the fine one is there for the last correction, which is
 * the one somebody using the keyboard because they cannot use a mouse actually needs.
 */
const NUDGE = 0.1;
const FINE_NUDGE = 0.01;

/**
 * Built once from a path string that is itself built once — the same reasoning, and the same 18 KiB
 * of geometry, as `IndiaMap`'s coastline. This never has a reason to re-render, and it re-renders on
 * every keystroke in the latitude box if it is not held apart.
 */
const Coastline = memo(function Coastline() {
  return (
    <path
      d={indiaOutlinePath()}
      fillRule="evenodd"
      className="fill-purple-100/60 stroke-purple-300 dark:fill-purple-950/40"
      // A hairline is what keeps Lakshadweep on the picture at this size; see IndiaMap.tsx.
      strokeWidth={1.6}
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
});

export function RegionMapPicker({
  id,
  regionName,
  latitude,
  longitude,
  others,
  onPick,
  className
}: RegionMapPickerProps) {
  // What the last click or nudge was refused for, cleared by the next one that lands. Not an error
  // the form can be in — nothing was changed — so it is not a `Field` error.
  const [refusal, setRefusal] = useState<string | null>(null);
  const helpId = useId();

  /**
   * The pin's coordinate AND its place in the picture, resolved together or not at all.
   *
   * One object rather than three checks: `noUncheckedIndexedAccess` and strict null checks do not
   * narrow `latitude` for you inside a branch that tested a DIFFERENT variable, and the alternative
   * is three `as number` casts on the two numbers this whole component exists to be careful about.
   */
  const placed =
    latitude === null || longitude === null
      ? null
      : { latitude, longitude, ...project(longitude, latitude) };

  /**
   * The one place a coordinate becomes this region's coordinate — the click path and the arrow keys
   * both end here, so the box is checked once and the refusal is worded once.
   */
  const commit = (nextLatitude: number, nextLongitude: number) => {
    const broken: string[] = [];
    if (nextLatitude < LAT_MIN || nextLatitude > LAT_MAX) {
      broken.push(`a latitude on this map is between ${LAT_MIN} and ${LAT_MAX}`);
    }
    if (nextLongitude < LNG_MIN || nextLongitude > LNG_MAX) {
      broken.push(`a longitude is between ${LNG_MIN} and ${LNG_MAX}`);
    }

    if (broken.length > 0) {
      setRefusal(
        `${coordinates(nextLatitude, nextLongitude)} is off the map — ${broken.join(", and ")}. Nothing has been changed.`
      );
      return;
    }

    setRefusal(null);
    onPick(nextLatitude, nextLongitude);
  };

  /**
   * A click anywhere in the picture, in the picture's own coordinates.
   *
   * ⚠ `getScreenCTM()` RATHER THAN `getBoundingClientRect()`. The rect works only while the rendered
   * box has exactly the viewBox's aspect ratio, which today it does (`h-auto w-full`) and which any
   * later `preserveAspectRatio`, fixed height or CSS transform on an ancestor would quietly break —
   * and the failure is not a crash but pins landing a few degrees from where they were clicked. The
   * matrix asks the browser what it actually did. It is `null` for a detached or `display: none`
   * element, which a click cannot come from, so there is nothing to report in that branch.
   */
  const handleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM();
    if (matrix === null) return;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const place = unproject(point.x, point.y);
    commit(round(place.latitude), round(place.longitude));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (latitude === null || longitude === null) return;

    const step = event.shiftKey ? FINE_NUDGE : NUDGE;
    let nextLatitude = latitude;
    let nextLongitude = longitude;

    switch (event.key) {
      case "ArrowUp":
        nextLatitude += step;
        break;
      case "ArrowDown":
        nextLatitude -= step;
        break;
      case "ArrowLeft":
        nextLongitude -= step;
        break;
      case "ArrowRight":
        nextLongitude += step;
        break;
      default:
        return;
    }

    // Only once a key is known to be one of the four: otherwise Tab and Escape would be swallowed by
    // a control that had no use for them.
    event.preventDefault();
    // ⚠ Rounded BEFORE the box is checked, and both numbers every time. 26.9124 + 0.1 is
    // 27.012400000000003 in binary floating point, and a pin whose stored value grows a tail of
    // digits every time it is nudged is a pin nobody can read back out of the field beside it.
    commit(round(nextLatitude), round(nextLongitude));
  };

  return (
    <div id={id} className={cn("max-w-md", className)}>
      {/*
        The pin is an HTML button laid over the picture, so this box is its positioning context — and
        because the svg is `h-auto w-full`, this box IS the viewBox and a percentage of it is a
        percentage of the viewBox. (The same measuring stick `IndiaMap` gives its hover card.)

        ⚠ NEVER GIVE IT AN `overflow`. Latitude 38 is a legal value and sits about eight user-space
        units ABOVE the top of the outline's box — clipping here would hide the pin of a region that
        had just been placed perfectly legally, at the one moment the editor is looking for it.
      */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`}
          className="h-auto w-full cursor-crosshair rounded-md border border-line-200 bg-surface-50"
          /*
           * Decoration, exactly as on the public map: everything it says is said in words by the
           * status line below it, the pin's own label, and the two number fields beside it. The click
           * handler on an aria-hidden element is therefore pointer-only ON PURPOSE and not a gap —
           * see the header for the keyboard path.
           */
          role="presentation"
          aria-hidden="true"
          focusable="false"
          onClick={handleClick}
        >
          {/* Hit-testing in SVG follows painted shapes, so without this the sea between the islands
              is a hole a click falls through. Transparent, not `fill-none`, which paints nothing and
              catches nothing. */}
          <rect width={VIEW_BOX.width} height={VIEW_BOX.height} fill="transparent" />

          <Coastline />

          {/* Every region already on the map, faint: an editor placing Nirona can see that Bhuj and
              Ajrakhpur are already there, and roughly where. Deliberately small and pale — they are
              context, and the pin being placed is the subject. */}
          {others.map((other) => {
            const at = project(other.longitude, other.latitude);
            return <circle key={other.id} cx={at.x} cy={at.y} r={7} className="fill-purple-500/30" />;
          })}
        </svg>

        {placed === null ? null : (
          /*
           * THE PIN, AND WHY IT IS A `<button>` WHOSE CLICK DOES NOTHING.
           *
           * It has to be reachable and nudgeable from the keyboard, and contract §11 says an
           * interactive element is a real button. The alternative — `tabIndex` on an SVG `<g>` —
           * would put a tab stop inside an `aria-hidden` subtree, which is focusable but unreadable:
           * the worst of both, and the exact trap IndiaMap.tsx's header refuses.
           *
           * So it is a button, and its click is inert by design: a mouse user never needs to press
           * the pin, because pressing the MAP is how the pin moves. What the button is for is being
           * focused and then nudged — the shape of a drag handle, which in this codebase (the
           * dnd-kit handles in EntityPicker) is also a button whose click does nothing.
           *
           * `translate` is a static utility pair, not motion — it centres the dot on its coordinate.
           */
          <button
            type="button"
            onKeyDown={handleKeyDown}
            aria-label={`${regionName}’s pin, at ${coordinates(placed.latitude, placed.longitude)}`}
            aria-describedby={helpId}
            className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-purple-700 shadow-sm"
            style={{
              left: `${(placed.x / VIEW_BOX.width) * 100}%`,
              top: `${(placed.y / VIEW_BOX.height) * 100}%`
            }}
          />
        )}
      </div>

      {/*
        One live region for both answers, rather than a polite one and an assertive one competing.
        `status` and not `alert`: nothing here is an error state the form is stuck in — a refused
        click changed nothing — and an assertive interruption per stray click would make the map
        unusable with a screen reader running.
      */}
      <div role="status" aria-live="polite" className="mt-2">
        {refusal === null ? (
          <HelpText>
            {placed === null
              ? "No pin yet. Click the map, or type the two numbers beside it."
              : // Just the coordinate. NOT "not saved yet" — this component is not told what the
                // server last agreed to, and a status line that says "unsaved" over a saved pin is
                // worse than one that says nothing about saving at all. The row's Save button
                // already carries that: it is disabled until there is something to save.
                `Pin at ${coordinates(placed.latitude, placed.longitude)}.`}
          </HelpText>
        ) : (
          // `tone="error"` brings a glyph as well as the colour: colour never carries meaning alone
          // (contract §11).
          <HelpText tone="error">{refusal}</HelpText>
        )}
      </div>

      <HelpText id={helpId} className="mt-1">
        Click the map to place the pin. Once it is there it is a button: tab to it and move it with
        the arrow keys — about 11 km a press, or 1 km with Shift held. Faint dots are regions already
        on the map.
      </HelpText>
    </div>
  );
}
