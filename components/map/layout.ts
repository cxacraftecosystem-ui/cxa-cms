/**
 * Turning points into pins that can actually be told apart.
 *
 * THE PROBLEM. One workshop with sixteen artisans is sixteen records on one coordinate, and a pile
 * of identical circles reads as a single record — the map understates itself by an order of
 * magnitude and gives no hint that it is doing so. There are two different collisions here and they
 * need two different answers:
 *
 *   IDENTICAL coordinates are folded on the SERVER, into one pin that carries `total`, `fixes` and
 *   `spreadMetres`. Sixteen artisans at the venue become one pin labelled sixteen. That is the only
 *   honest reduction: they really are one place.
 *
 *   NEARBY BUT DISTINCT places are handled HERE, by displacement rather than by folding. Bagru and
 *   Sanganer are 25 km apart — eight pixels at the scale a whole country is drawn at — but they are
 *   two towns with two different craft traditions, and merging them would erase a real distinction.
 *   So the smaller pin is pushed clear of the larger one and a hairline leader ties it back to its
 *   true coordinate, which is the standard cartographic answer and the only one that neither hides
 *   a place nor lies about where it is.
 *
 * The pass is deterministic — same points in, same pins out — so nothing moves between renders, and
 * it runs once per data change rather than per frame.
 */

import { project, VIEW_BOX } from "@/components/map/projection";
import type { CraftSheet } from "@/lib/media/craft-sheets";

/**
 * ONE craft, standing for the work at a pin, with the plate that shows what that work looks like.
 *
 * ⚠ THE PLATE IS RESOLVED ON THE SERVER AND TRAVELS WITH THE POINT, which is a deliberate trade and
 * not an accident of where the code was written. `lib/media/craft-sheets.ts` is forty-three entries
 * each carrying a base64 blur placeholder; importing it into the client map to look one slug up would
 * put the whole manifest in the bundle. A resolved sheet is about 300 bytes of RSC payload per pin,
 * so a twenty-pin map pays six kilobytes and a phone downloads no manifest at all.
 *
 * `sheet` is nullable because `craftSheetFor` cannot invent a plate from an empty manifest, and the
 * hover card is built to show the craft's name with no picture rather than to disappear.
 */
export interface MapPointCraft {
  name: string;
  sheet: CraftSheet | null;
}

/**
 * The lean point this port needs. The source app read a richer MapPoint from its own API
 * (precision ladders, capture layers); the landing map draws craft REGIONS, which have exactly
 * these fields. Keys are region slugs; count is published crafts in the region.
 */
export interface MapPoint {
  key: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Folded record count at this coordinate — sizes the pin and is printed inside it. */
  total: number;
  /**
   * Optional because the counted map stands on its own: this is the picture the hover card adds, and
   * a caller that has only regions and counts — which is all `layoutPins` and the SVG ever read —
   * sets nothing. Absent means the card shows the place and its count with no frame, rather than an
   * empty frame.
   */
  craft?: MapPointCraft;
}

/**
 * Pin radii in SVG user space. Area grows with the count, so twice the pin is four times the work.
 *
 * The floor is set by the COUNT THAT HAS TO FIT INSIDE IT, not by taste. Pins below about this size
 * were drawn bare, and a bare pin is the exact failure this file exists to prevent — it reads as one
 * record whether it stands for one or for nine.
 */
const MIN_RADIUS = 12.5;
const MAX_RADIUS = 26;

/** Clear space between two pin edges, so neighbours read as two marks rather than a figure of eight. */
const GAP = 3;

/** Displacement is capped: past this a leader line is longer than the distance it explains. */
const MAX_SHIFT = 46;

const MAX_PASSES = 60;

export type PlacedPin = {
  point: MapPoint;
  /** Where the pin is drawn. */
  x: number;
  y: number;
  /** Where the point actually is. Differs from x/y only when the pin had to be pushed clear. */
  anchorX: number;
  anchorY: number;
  radius: number;
  displaced: boolean;
  /**
   * Radius of the "this could be anywhere in here" halo, in user space, or 0 when the point is
   * precise enough that drawing one would overstate the uncertainty in the other direction.
   */
  uncertainty: number;
};

/**
 * How far from the drawn point the record could really be, in kilometres.
 *
 * These are the precision tiers made visible. A STATE-precision pin is drawn at a seat and could be
 * anywhere in the state, which at this scale is a halo the size of Rajasthan — and it should look like
 * that, because the alternative is a confident dot on Jaipur for a record that only ever said
 * "Rajasthan".
 *
 * The two zeroes are the two MEASUREMENTS: a device fix and a pin somebody dropped on the subject's
 * own place. Drawing a halo around either would overstate the uncertainty in the other direction.
 *
 * NATION is zero for a different reason. That pin means "every placed record in the country" and is
 * positioned at their weighted mean, so a halo would be claiming the records might be somewhere else
 * — but there is nowhere else; the point IS the aggregate. The level label carries the meaning.
 */
// The source app drew uncertainty halos from a six-rung precision ladder (GPS fix vs district
// stand-in). Every point on THIS map is a region seat from the corpus gazetteer — one kind of
// coordinate — so the ladder collapses and no halo is drawn.
const UNCERTAINTY_KM = 0;

export function pinRadius(total: number, busiest: number): number {
  if (busiest <= 0) return MIN_RADIUS;
  // Square root, so the AREA of a pin is proportional to its count. Scaling the radius directly
  // would draw the venue's 317 records as a blob covering half the country.
  const share = Math.sqrt(total) / Math.sqrt(busiest);
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * share;
}

export function layoutPins(points: MapPoint[], unitsPerKilometre: number): PlacedPin[] {
  const busiest = points.reduce((most, point) => Math.max(most, point.total), 0);

  // Busiest first: the pin carrying the most records keeps its true position, and the ones pushed
  // aside are the ones whose displacement matters least.
  const ordered = [...points].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));

  const placed: PlacedPin[] = [];
  for (const point of ordered) {
    const { x: anchorX, y: anchorY } = project(point.longitude, point.latitude);
    const radius = pinRadius(point.total, busiest);
    let x = anchorX;
    let y = anchorY;

    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const clash = placed.find((other) => {
        const needed = other.radius + radius + GAP;
        return Math.hypot(other.x - x, other.y - y) < needed;
      });
      if (!clash) break;

      const needed = clash.radius + radius + GAP;
      let dx = x - clash.x;
      let dy = y - clash.y;
      let distance = Math.hypot(dx, dy);
      if (distance < 0.001) {
        // Exactly on top of one another. Step off along a direction derived from the key rather
        // than at random, so the same data always produces the same picture.
        const angle = (hash(point.key) % 360) * (Math.PI / 180);
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }
      const push = (needed - distance) / distance;
      x += dx * push;
      y += dy * push;

      // Never let a pin wander further from the truth than a leader line can usefully explain.
      const drift = Math.hypot(x - anchorX, y - anchorY);
      if (drift > MAX_SHIFT) {
        x = anchorX + ((x - anchorX) / drift) * MAX_SHIFT;
        y = anchorY + ((y - anchorY) / drift) * MAX_SHIFT;
        break;
      }
    }

    x = clamp(x, radius, VIEW_BOX.width - radius);
    y = clamp(y, radius, VIEW_BOX.height - radius);

    placed.push({
      point,
      x,
      y,
      anchorX,
      anchorY,
      radius,
      displaced: Math.hypot(x - anchorX, y - anchorY) > 0.75,
      uncertainty: UNCERTAINTY_KM * unitsPerKilometre
    });
  }

  // Back into a stable render order — LARGEST FIRST, which in an svg means largest at the BOTTOM of
  // the stack: there is no z-index here, painting is document order, so a 26-unit pin emitted first
  // can never cover a 12.5-unit one emitted after it. ⚠ Reversing this comparator buries the smallest
  // pins under the biggest, which is the one arrangement in which a place disappears entirely. The
  // sort in the loop above is about who WINS a collision; this one is about who is on top.
  return placed.sort((a, b) => b.radius - a.radius);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) >>> 0;
  }
  return value;
}
