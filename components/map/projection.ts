/**
 * Longitude/latitude to the SVG user space the outline and every pin share.
 *
 * WHY EQUIRECTANGULAR AND NOT MERCATOR. India spans 6.8N to 37.1N. Web Mercator stretches the top
 * of that range about 25% more than the bottom, so Kashmir would be visibly too large next to
 * Kerala on a map whose whole job is comparing how much work came from where. A plate carrée with
 * the horizontal axis scaled by cos(centre latitude) keeps the country's proportions honest at this
 * one scale, costs two multiplications, and inverts exactly — which the accessible list needs when
 * it turns a pin back into a place.
 *
 * The ONLY projection in the app. The outline path and the pin positions must be produced by the
 * same function or the pins drift off the coast; nothing here may be inlined at a call site.
 */

import { INDIA_BOUNDS, indiaRings, type Polygon } from "@/components/map/indiaGeometry";

/** Width of the SVG user space. Height follows from the country's true aspect ratio. */
const VIEW_WIDTH = 1000;

/** Breathing room around the coastline, in user-space units, so a coastal pin is not half cut off. */
const PADDING = 24;

const MID_LATITUDE = (INDIA_BOUNDS.minLatitude + INDIA_BOUNDS.maxLatitude) / 2;
const LONGITUDE_SCALE = Math.cos((MID_LATITUDE * Math.PI) / 180);

const SPAN_X = (INDIA_BOUNDS.maxLongitude - INDIA_BOUNDS.minLongitude) * LONGITUDE_SCALE;
const SPAN_Y = INDIA_BOUNDS.maxLatitude - INDIA_BOUNDS.minLatitude;

const UNITS_PER_DEGREE = (VIEW_WIDTH - PADDING * 2) / SPAN_X;
const VIEW_HEIGHT = SPAN_Y * UNITS_PER_DEGREE + PADDING * 2;

export const VIEW_BOX = { width: VIEW_WIDTH, height: VIEW_HEIGHT } as const;

/** Where a coordinate lands in the SVG user space. Latitude grows north; SVG y grows down. */
export function project(longitude: number, latitude: number): { x: number; y: number } {
  return {
    x: PADDING + (longitude - INDIA_BOUNDS.minLongitude) * LONGITUDE_SCALE * UNITS_PER_DEGREE,
    y: PADDING + (INDIA_BOUNDS.maxLatitude - latitude) * UNITS_PER_DEGREE
  };
}

/**
 * The exact algebraic inverse of `project`: a point in the SVG user space, back to a coordinate.
 *
 * ⚠ THESE TWO FUNCTIONS ARE ONE THING AND MUST ALWAYS BE CHANGED TOGETHER. The header's claim that
 * this projection "inverts exactly" is only true while the arithmetic below is `project`'s arithmetic
 * rearranged and nothing else — same constants, same order, no rounding, no clamping. Add a term to
 * one and the other silently starts answering a different question: `RegionMapPicker` would write a
 * latitude that `project` then draws somewhere the editor did not click, and the pin would be wrong
 * by exactly the size of the change, which is the hardest kind of wrong to notice.
 *
 * ⚠ IT DOES NOT CLAMP, AND MUST NOT. The user space is `INDIA_BOUNDS` plus `PADDING`, so it answers
 * outside the geometry's own bounds by design: x = 0 is 67.47 E and x = 1000 is 98.13 E, either side
 * of the studio's 68–98 box. (The vertical padding is worth 0.68 of a degree and lands at 37.77 N and
 * 6.07 N, which stay inside 6–38 — so it is the LEFT AND RIGHT EDGES that produce refusable values,
 * not the top and bottom.) Clamping here would turn a click off the edge into a coordinate nobody
 * typed and nobody could be shown to have chosen; refusing it is the caller's job
 * (`components/studio/RegionMapPicker.tsx`), and the caller can only refuse a value it has been told
 * the truth about.
 */
export function unproject(x: number, y: number): { longitude: number; latitude: number } {
  return {
    longitude: INDIA_BOUNDS.minLongitude + (x - PADDING) / (LONGITUDE_SCALE * UNITS_PER_DEGREE),
    latitude: INDIA_BOUNDS.maxLatitude - (y - PADDING) / UNITS_PER_DEGREE
  };
}

/** How many user-space units a distance in kilometres covers. Used to size the scale bar. */
export function unitsPerKilometre(): number {
  return UNITS_PER_DEGREE / 111.32;
}

/**
 * Border polylines as ONE path string, through the same `project` the outline and the pins use.
 *
 * One element rather than a thousand, for the reason `indiaOutlinePath` gives: React would otherwise
 * reconcile 972 nodes on every render of a shape that cannot change.
 *
 * OPEN SUBPATHS — there is no `Z`. A border is a run between two junctions, not a ring, and closing
 * one would draw a straight segment joining its ends: the Rajasthan/Gujarat border would grow a line
 * across the country back to where it started.
 *
 * A run that decimates to a single point is dropped rather than emitted as a lone `M`, which paints
 * nothing but still costs a subpath.
 */
export function bordersToPath(lines: Array<Array<[number, number]>>): string {
  const parts: string[] = [];
  for (const line of lines) {
    let out = "";
    let previousX = Number.NaN;
    let previousY = Number.NaN;
    let emitted = 0;
    for (const [longitude, latitude] of line) {
      const { x, y } = project(longitude, latitude);
      const rx = Math.round(x * 10) / 10;
      const ry = Math.round(y * 10) / 10;
      // A point a tenth of a unit from the last one is below what this scale can show, and at 19,470
      // points the saving is most of the string.
      if (emitted > 0 && rx === previousX && ry === previousY) continue;
      out += `${emitted === 0 ? "M" : "L"}${rx} ${ry}`;
      previousX = rx;
      previousY = ry;
      emitted += 1;
    }
    if (emitted >= 2) parts.push(out);
  }
  return parts.join("");
}

let outline: string | null = null;

/**
 * The whole country as ONE path string — 307 polygons and the single hole as sub-paths of one `d`.
 *
 * One element rather than 307. React would otherwise reconcile three hundred nodes on every render
 * of a shape that cannot change, and the browser would composite three hundred layers on every
 * repaint. Built once and kept, for the same reason the rings are decoded once.
 *
 * Coordinates are rounded to one decimal place: at this scale that is a tenth of a pixel, and it
 * takes about a third off the string.
 */
export function indiaOutlinePath(): string {
  if (outline) return outline;
  const parts: string[] = [];
  for (const polygon of indiaRings() as Polygon[]) {
    for (const ring of polygon) {
      let command = "M";
      for (const [longitude, latitude] of ring) {
        const { x, y } = project(longitude, latitude);
        parts.push(`${command}${x.toFixed(1)} ${y.toFixed(1)}`);
        command = "L";
      }
      parts.push("Z");
    }
  }
  outline = parts.join("");
  return outline;
}
