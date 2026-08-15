/**
 * The tapestry's geometry — four real craft traditions, written down as numbers.
 *
 * Nothing here renders. This module holds the shapes, the dye palette and the deterministic
 * jitter that `CraftTapestry` and its four layers draw, so the geometry can be read, checked and
 * argued about on its own terms. If a shape looks wrong on screen, it is wrong HERE.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THESE ARE LIVING TRADITIONS, NOT DECORATION. DO NOT "SIMPLIFY" THEM.
 *
 * Every construction below is the real one, and each is documented at its function so that a
 * later hand can see what would be lost:
 *
 *   • The `buti` — the small repeated motif of Bagru and Sanganeri hand block printing. Four of
 *     them: `ambi` (the mango), `phool` (the eight-petal jasmine), `patti` (the leaf) and
 *     `bindi` (the dot filler). Each is defined TWICE, as the `datta` block that lays the solid
 *     colour and the `rekh` block that prints the outline over it, because that is how the cloth
 *     is actually made and because the gap between the two passes is what the eye reads as
 *     hand-work.
 *   • The `pulli` grid and its single unbroken line — the South Indian threshold kolam. The line
 *     is a MIRROR CURVE, which is the established mathematical description of a `sikku` kolam
 *     (the same family as Celtic knotwork and Tchokwe `sona`): a 45° path that reflects off the
 *     boundary of the dot field and weaves between the dots. See `kolamFigure`.
 *   • The star-and-hexagon unit cell of a Mughal `jaali` — the pierced stone screen. Hexagrams
 *     on a triangular lattice, tip to tip, with the regular hexagons that necessarily fall
 *     between them. The proof that those gaps are regular hexagons is in `jaaliTile`.
 *   • The natural-dye palette: indigo, lac, madder, turmeric, myrobalan — the dyestuffs a Bagru
 *     printer actually keeps, expressed in the project's own OKLCH vocabulary.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NO `Math.random()` ANYWHERE IN THIS FILE OR ITS CALLERS. Every irregularity comes from
 * `stableHash` in lib/utils.ts, keyed on the index of the thing being placed. A random field
 * would differ between the server render and the client render — a hydration mismatch on the one
 * view where time to first paint matters most — and would re-roll on every re-render, so the
 * cloth would twitch whenever an unrelated piece of state changed. Same seed, same cloth, for
 * ever.
 */

import { stableHash } from "@/lib/utils";

// ── Shared ────────────────────────────────────────────────────────────────────────────────────

export interface Point {
  x: number;
  y: number;
}

/**
 * Two decimal places. These `d` strings ship inside the HTML of the busiest page on the site, and
 * the third decimal of a curve drawn at roughly one user unit per screen pixel is below the size
 * of a pixel — it costs bytes and buys nothing.
 */
function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

// ── Deterministic irregularity ────────────────────────────────────────────────────────────────

/** `stableHash` returns an unsigned 32-bit integer; this is its exclusive upper bound. */
const HASH_CEILING = 4294967296;

/**
 * A stable number in [0, 1) for a named thing.
 *
 * The parts are joined with a separator that cannot appear in an index, so `(1, 23)` and
 * `(12, 3)` are different keys. Pass a CHANNEL name as one of the parts — "dx", "rotate", "ink" —
 * so the horizontal drift of an impression is independent of its rotation. Deriving both from one
 * hash correlates them, and a field where everything that leans left also prints faint reads as a
 * mistake rather than as a hand.
 */
export function hashUnit(...parts: readonly (string | number)[]): number {
  return stableHash(parts.join("|")) / HASH_CEILING;
}

/** The same, mapped onto a range. */
export function hashRange(
  min: number,
  max: number,
  ...parts: readonly (string | number)[]
): number {
  return min + hashUnit(...parts) * (max - min);
}

// ── The natural-dye palette ───────────────────────────────────────────────────────────────────

export interface NaturalDye {
  /** The dyestuff, by the name the trade uses and by its source. */
  readonly label: string;
  /** OKLCH, in the same notation as tailwind.config.ts. */
  readonly color: string;
}

/**
 * The dye pots, anchored to the brand ramp so the tapestry belongs to the design system rather
 * than sitting beside it.
 *
 * The mapping is deliberate, and each entry is either a brand rung exactly or a documented
 * departure from one:
 *
 *   indigo      = purple-800. True vat indigo reads bluer than this (nearer hue 265); it is
 *                 pulled onto the brand hue of 305 so the backdrop cannot read as a second
 *                 palette next to the purple the rest of the site is built from.
 *   indigoDeep  = purple-950, the second and third dip in the vat.
 *   lac         = purple-600. Lac (the resin of *Kerria lacca*) gives crimson with an alum
 *                 mordant and a true purple with iron — this is the iron version, which is why
 *                 it can sit on the brand hue honestly.
 *   madder      = the brand `logo.terracotta` (#CC785C) restated in OKLCH. The one warm red in
 *                 the system, and the closest thing the palette has to *Rubia cordifolia*.
 *   turmeric    = gold-500 exactly. Gold is marketing-only (contract §1.1) and appears here only
 *                 as a trace, at single-figure opacity, inside an ornament.
 *   myrobalan   = gold-300 — `harda`, the pale tannin ground the cloth is prepared with before
 *                 any colour touches it. Used as the light coming through the jaali.
 *
 * ⚠ THESE ARE A COPY OF THE RAMP AND WILL NOT FOLLOW A CHANGE TO IT. `ParticleField.tsx` carries
 * the same warning for the same reason: an SVG paint attribute cannot hold a Tailwind class. If
 * tailwind.config.ts moves, move these with it.
 */
export const NATURAL_DYES = {
  indigo: {
    label: "Indigo — Indigofera tinctoria, the neel vat",
    color: "oklch(0.4 0.18 305)"
  },
  indigoDeep: {
    label: "Indigo, second and third dip",
    color: "oklch(0.255 0.108 305)"
  },
  lac: {
    label: "Lac — Kerria lacca, iron-mordanted to purple",
    color: "oklch(0.56 0.205 305)"
  },
  madder: {
    label: "Madder — Rubia cordifolia, manjistha root",
    color: "oklch(0.653 0.101 40)"
  },
  turmeric: {
    label: "Turmeric — Curcuma longa, haldi",
    color: "oklch(0.7 0.145 80)"
  },
  myrobalan: {
    label: "Myrobalan — Terminalia chebula, the harda ground",
    color: "oklch(0.85 0.11 86)"
  }
} as const satisfies Record<string, NaturalDye>;

export type DyeName = keyof typeof NATURAL_DYES;

// ── Path primitives ───────────────────────────────────────────────────────────────────────────

/** A closed polygon through the given vertices. */
function polylinePath(vertices: readonly Point[]): string {
  const first = vertices[0];
  if (!first) return "";
  const rest = vertices.slice(1).map((point) => `L ${n(point.x)} ${n(point.y)}`);
  return `M ${n(first.x)} ${n(first.y)} ${rest.join(" ")} Z`;
}

/**
 * A closed smooth curve through every one of the given points.
 *
 * Catmull-Rom converted to cubic Béziers — the control points are the neighbours' difference over
 * six, which is the standard uniform form. It INTERPOLATES rather than approximates, so the
 * sampled outline of a mango is exactly the outline of a mango and not a slack version of it.
 */
function closedCurve(points: readonly Point[]): string {
  const count = points.length;
  const first = points[0];
  if (!first || count < 3) return "";

  const at = (index: number): Point => points[((index % count) + count) % count] ?? first;

  const segments: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const before = at(index - 1);
    const start = at(index);
    const end = at(index + 1);
    const after = at(index + 2);

    const c1 = { x: start.x + (end.x - before.x) / 6, y: start.y + (end.y - before.y) / 6 };
    const c2 = { x: end.x - (after.x - start.x) / 6, y: end.y - (after.y - start.y) / 6 };
    segments.push(
      `C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(end.x)} ${n(end.y)}`
    );
  }

  return `M ${n(first.x)} ${n(first.y)} ${segments.join(" ")} Z`;
}

/** A regular polygon. `rotation` is in radians and turns the first vertex away from due east. */
function polygonPath(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotation = 0
): string {
  const vertices: Point[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (index / sides) * Math.PI * 2;
    vertices.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  }
  return polylinePath(vertices);
}

/**
 * A star polygon: `points` tips at `outer`, the same number of valleys at `inner`.
 *
 * For the jaali this is a hexagram — six tips, and `inner = outer / √3`, which is what makes the
 * figure the union of two equilateral triangles rather than a six-pointed spike.
 */
function starPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  points = 6,
  rotation = 0
): string {
  const vertices: Point[] = [];
  const steps = points * 2;
  for (let index = 0; index < steps; index += 1) {
    const angle = rotation + (index / steps) * Math.PI * 2;
    const radius = index % 2 === 0 ? outer : inner;
    vertices.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  }
  return polylinePath(vertices);
}

/** A circle, as a path, so it can live in the same `d`-string list as everything else. */
function discPath(cx: number, cy: number, radius: number): string {
  const r = n(radius);
  return [
    `M ${n(cx - radius)} ${n(cy)}`,
    `A ${r} ${r} 0 1 0 ${n(cx + radius)} ${n(cy)}`,
    `A ${r} ${r} 0 1 0 ${n(cx - radius)} ${n(cy)}`,
    "Z"
  ].join(" ");
}

/**
 * A lens — two circular arcs meeting at points top and bottom. The leaf shape, exactly, with no
 * sampling: for a lens of half-height `h` and half-width `w` the arc radius is (h² + w²) / 2w.
 */
function lensPath(cx: number, cy: number, halfWidth: number, halfHeight: number): string {
  const radius = (halfHeight * halfHeight + halfWidth * halfWidth) / (2 * halfWidth);
  const r = n(radius);
  const top = n(cy - halfHeight);
  const bottom = n(cy + halfHeight);
  return `M ${n(cx)} ${top} A ${r} ${r} 0 0 1 ${n(cx)} ${bottom} A ${r} ${r} 0 0 1 ${n(cx)} ${top} Z`;
}

// ── The buti: Bagru and Sanganeri hand block printing ─────────────────────────────────────────

/** Every buti is drawn inside this square, centred on it, so one `<use>` transform fits them all. */
export const BUTI_BOX = 20;

export type ButiId = "ambi" | "phool" | "patti" | "bindi";

export interface Buti {
  readonly id: ButiId;
  /** What it is, in the trade's own words. */
  readonly name: string;
  /**
   * The `datta` block: the raised face that lays solid colour. Rendered filled.
   */
  readonly solid: readonly string[];
  /**
   * The `rekh` block: the finer outline block, printed over the fill in a second pass with a
   * second colour. Rendered stroked, with `fill: none`.
   */
  readonly line: readonly string[];
}

/**
 * The `ambi` (also `keri`) — the mango, and the motif every Rajasthani printed field is built
 * around. It is the ancestor of what Europe later called paisley.
 *
 * Constructed from the teardrop curve — x = cos t, y = sin t · sin²(t/2) — which has its cusp at
 * one end and its greatest width nearer the other, exactly like the fruit. The hooked tip is a
 * cubic bias applied only to the pointed half, so the shape LEANS as it narrows instead of being
 * a symmetrical drop with a bend welded on.
 *
 * `sink` drops the whole figure down the cell, which is how the smaller inner contour is made to
 * nestle in the belly of the outer one rather than float in the middle of it.
 */
function ambiOutline(scale: number, sink: number): string {
  const SAMPLES = 40;
  /** max of sin t · sin²(t/2), at t ≈ 2.09 rad. Divided out so `across` reaches exactly ±1. */
  const WIDEST = 0.6495;

  const halfWidth = 5.2 * scale;
  const halfLength = 7.6 * scale;
  const curl = 3.2 * scale;
  const cx = BUTI_BOX / 2;
  const cy = BUTI_BOX / 2 + sink;

  const points: Point[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const t = (index / SAMPLES) * Math.PI * 2;
    const along = Math.cos(t);
    const across = (Math.sin(t) * Math.sin(t / 2) ** 2) / WIDEST;
    points.push({
      x: cx + across * halfWidth + (along > 0 ? along ** 3 * curl : 0),
      y: cy - along * halfLength
    });
  }
  return closedCurve(points);
}

/**
 * The `phool` — the flat eight-petal jasmine rosette of a Sanganeri field.
 *
 * Sixteen sampled radii, alternating between the petal tip and the valley between two petals,
 * carried through by the Catmull-Rom above. Alternating radii is what makes a rosette rather than
 * a cog: the curve passes THROUGH the valleys, so the petals are separated by a soft notch of the
 * kind a wooden block actually cuts.
 */
function rosette(petals: number, outer: number, inner: number, cx: number, cy: number): string {
  const points: Point[] = [];
  const steps = petals * 2;
  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2 - Math.PI / 2;
    const radius = index % 2 === 0 ? outer : inner;
    points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  }
  return closedCurve(points);
}

const centre = BUTI_BOX / 2;

/**
 * The four blocks, by name. A record rather than a bare array so a caller naming a buti cannot
 * end up holding `undefined` and does not need to say what it would do about it.
 */
export const BUTI_BY_ID: Record<ButiId, Buti> = {
  ambi: {
    id: "ambi",
    name: "Ambi / keri — the mango; the field buti of Bagru and Sanganeri",
    solid: [ambiOutline(1, 0.2)],
    // The inner contour is the second block's whole job on this motif: it reads as the seed of
    // the fruit. The stalk is one short curve, which is all the block carries.
    line: [ambiOutline(0.5, 1.6), "M 10 17.9 C 10 18.7 9.5 19.2 8.8 19.4"]
  },
  phool: {
    id: "phool",
    name: "Phool / chameli — the eight-petal jasmine rosette",
    solid: [rosette(8, 7.4, 3.1, centre, centre), discPath(centre, centre, 1.7)],
    line: [rosette(8, 4.6, 2, centre, centre)]
  },
  patti: {
    id: "patti",
    name: "Patti — the leaf, cut as two arcs meeting at a point",
    solid: [lensPath(centre, centre, 3, 6.9)],
    // Midrib and two pairs of veins, as one multi-subpath `d`: a stroked path may hold several
    // subpaths, and one element is one element.
    line: ["M 10 3.4 L 10 16.6 M 10 7.4 L 12.2 6 M 10 7.4 L 7.8 6 M 10 11 L 12.4 9.6 M 10 11 L 7.6 9.6"]
  },
  bindi: {
    id: "bindi",
    name: "Bindi — the dot filler that sits between the field butis in a jaal",
    solid: [discPath(centre, centre, 2.5)],
    line: [discPath(centre, centre, 5.2)]
  }
};

// ── The kolam: the South Indian threshold drawing ──────────────────────────────────────────────

interface Walker {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/**
 * One closed orbit of the 45° reflected walk, as its list of turning points.
 *
 * The walk lives on a HALF-PITCH integer lattice: the dot field is `2·cols` by `2·rows`, the
 * `pulli` sit on the odd-odd points, and the line's turning points are the odd-parity points of
 * the boundary. Parity is what makes this safe — a diagonal step changes x + y by 0 or ±2, so the
 * walk can never reach a corner (all four corners have even x + y) and therefore never has to
 * reverse into itself. `run` is consequently always at least 1 and the loop always terminates.
 */
function traceOrbit(start: Walker, width: number, height: number, limit: number): Point[] {
  const vertices: Point[] = [];
  let x = start.x;
  let y = start.y;
  let dx = start.dx;
  let dy = start.dy;

  for (let step = 0; step < limit; step += 1) {
    vertices.push({ x, y });

    const toX = dx > 0 ? width - x : x;
    const toY = dy > 0 ? height - y : y;
    const run = Math.min(toX, toY);

    x += dx * run;
    y += dy * run;
    if (toX === run) dx = -dx;
    if (toY === run) dy = -dy;

    if (x === start.x && y === start.y && dx === start.dx && dy === start.dy) break;
  }

  return vertices;
}

/**
 * A closed loop through the given turning points with every corner rounded.
 *
 * The straight 45° runs are left straight and only the turns are curved, because that is what a
 * `sikku` kolam looks like: long diagonal strokes, and a loop where the line comes back on itself
 * at the edge of the dot field. The corner radius is clamped to under half of the shorter of the
 * two adjoining runs, so a one-step run between two turns cannot make the two curves overlap and
 * produce a kink where there should be a loop.
 */
function roundedLoop(vertices: readonly Point[], maxRadius: number): string {
  const count = vertices.length;
  const first = vertices[0];
  if (!first || count < 3) return "";

  const at = (index: number): Point => vertices[((index % count) + count) % count] ?? first;
  const sign = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0);

  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const before = at(index - 1);
    const here = at(index);
    const next = at(index + 1);

    const inX = sign(here.x - before.x);
    const inY = sign(here.y - before.y);
    const outX = sign(next.x - here.x);
    const outY = sign(next.y - here.y);

    const radius = Math.min(
      maxRadius,
      Math.abs(here.x - before.x) * 0.45,
      Math.abs(next.x - here.x) * 0.45
    );

    const approach = { x: here.x - inX * radius, y: here.y - inY * radius };
    const depart = { x: here.x + outX * radius, y: here.y + outY * radius };

    parts.push(
      index === 0
        ? `M ${n(approach.x)} ${n(approach.y)}`
        : `L ${n(approach.x)} ${n(approach.y)}`
    );
    parts.push(`Q ${n(here.x)} ${n(here.y)} ${n(depart.x)} ${n(depart.y)}`);
  }
  // Z draws the last straight run, from the final departure point back to the first approach.
  parts.push("Z");
  return parts.join(" ");
}

export interface KolamFigure {
  /** The whole line, ready for a single `<path d>`. */
  readonly d: string;
  /** The `pulli` — the dot grid the line is drawn around. */
  readonly dots: readonly Point[];
  /** The figure's extent in half-pitch units; the caller turns this into a viewBox. */
  readonly width: number;
  readonly height: number;
  /**
   * How many separate closed lines the figure needed. **1 is a true single-stroke kolam** — the
   * whole point of the form, and what a coprime `cols`/`rows` guarantees. A pair with a common
   * factor (6 × 4, say) genuinely cannot be drawn without lifting the finger, and the extra loops
   * are emitted as further subpaths of the same `d` rather than silently dropped, which would
   * leave holes in the weave.
   */
  readonly loops: number;
}

/**
 * The kolam: a `pulli` dot grid with one continuous line looped around it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS. A woman draws a kolam in rice flour on the swept threshold at dawn. The `pulli`
 * are laid first, then the line is walked around them in one movement without lifting the hand;
 * finishing where you began is the skill and the point.
 *
 * The construction is a MIRROR CURVE, which is the accepted formal description of a `sikku`
 * kolam: a path at 45° to the dot lattice that reflects off the boundary of the field. With no
 * internal mirrors the number of closed components is gcd(cols, rows) — so **7 × 5 is one
 * unbroken line and 6 × 4 is two**, which is why the callers here pass coprime pairs. The dots
 * fall on the odd-odd points of a half-pitch lattice and every one of them ends up encircled.
 *
 * DO NOT replace this with a hand-drawn lattice of arcs. The single-stroke property is the
 * tradition, it is provable here, and a decorative approximation of it is just a pattern.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function kolamFigure(cols: number, rows: number, cornerRadius = 1.15): KolamFigure {
  const across = Math.max(1, Math.round(cols));
  const down = Math.max(1, Math.round(rows));
  const width = across * 2;
  const height = down * 2;

  const dots: Point[] = [];
  for (let row = 0; row < down; row += 1) {
    for (let col = 0; col < across; col += 1) {
      dots.push({ x: col * 2 + 1, y: row * 2 + 1 });
    }
  }

  // Every odd-parity point of the boundary. Each is exactly one turn of exactly one loop, so a
  // point already seen belongs to a loop already drawn and is skipped.
  const starts: Walker[] = [];
  for (let x = 1; x < width; x += 2) {
    starts.push({ x, y: 0, dx: 1, dy: 1 });
    starts.push({ x, y: height, dx: 1, dy: -1 });
  }
  for (let y = 1; y < height; y += 2) {
    starts.push({ x: 0, y, dx: 1, dy: 1 });
    starts.push({ x: width, y, dx: -1, dy: 1 });
  }

  const seen = new Set<string>();
  const subpaths: string[] = [];
  // Total turns across all loops is exactly 2·cols + 2·rows; the margin is insurance, not need.
  const limit = (width + height) * 2 + 8;

  for (const start of starts) {
    if (seen.has(`${start.x},${start.y}`)) continue;
    const vertices = traceOrbit(start, width, height, limit);
    for (const vertex of vertices) seen.add(`${vertex.x},${vertex.y}`);
    const subpath = roundedLoop(vertices, cornerRadius);
    if (subpath) subpaths.push(subpath);
  }

  return { d: subpaths.join(" "), dots, width, height, loops: subpaths.length };
}

// ── The jaali: the pierced stone screen ───────────────────────────────────────────────────────

export interface JaaliTile {
  /** The repeat, for `<pattern width height patternUnits="userSpaceOnUse">`. */
  readonly width: number;
  readonly height: number;
  /** The hexagram voids. */
  readonly stars: readonly string[];
  /** The hexagonal voids that fall between them. */
  readonly hexes: readonly string[];
}

/**
 * One repeat of the star-and-hexagon `jaali` lattice.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS. A `jaali` is a single slab of sandstone or marble pierced right through, so the
 * room behind it is cooled and screened while daylight is broken into a lattice on the floor —
 * Fatehpur Sikri, Sidi Saiyyed, the screens around Mumtaz Mahal's cenotaph. The pattern below is
 * the commonest Mughal geometry: hexagrams meeting tip to tip on a triangular lattice, with
 * regular hexagons in the gaps.
 *
 * THE GEOMETRY IS EXACT, NOT APPROXIMATE, and here is why the gaps really are regular hexagons.
 * Put hexagrams of tip radius R = pitch/2 on a triangular lattice of side `pitch`; their six tips
 * point along the six lattice directions, so neighbouring stars touch. A hexagram's valley radius
 * is R/√3. Take one lattice triangle: its centroid is R/√3 from each of the three nearest star
 * valleys AND R/√3 from each of the three nearest star tips. Six vertices, one radius, alternating
 * sources — a regular hexagon, rotated 30° from the stars.
 *
 * The shapes returned are the VOIDS, each pulled back from its neighbours by `stoneShare` so that
 * what is left between them is the stone. That is the right way round: the caller uses these as a
 * MASK over a gradient, so light appears to come through the screen instead of the pattern being
 * painted on top of the page.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function jaaliTile(pitch = 24, stoneShare = 0.2): JaaliTile {
  const width = pitch;
  // Two lattice rows: the vertical repeat of a triangular lattice of side `pitch`.
  const height = pitch * Math.sqrt(3);

  const starOuter = pitch / 2;
  const starInner = starOuter / Math.sqrt(3);
  /** Proved above to equal the star's valley radius. */
  const hexRadius = starInner;

  // Rows of the two sublattices, as (y within the repeat, x offset of that row).
  const starRows: readonly Point[] = [
    { x: 0, y: 0 },
    { x: pitch / 2, y: height / 2 }
  ];
  const hexRows: readonly Point[] = [
    { x: pitch / 2, y: height / 6 },
    { x: 0, y: height / 3 },
    { x: 0, y: (2 * height) / 3 },
    { x: pitch / 2, y: (5 * height) / 6 }
  ];

  /**
   * Every centre whose shape can touch the tile, including the neighbours just outside it.
   *
   * `<pattern>` clips to the tile, so a shape that straddles an edge must be drawn on BOTH sides
   * or the repeat shows a seam. The filter uses the shape's full radius rather than its shrunken
   * one, which errs towards drawing one shape too many — cheap, and the alternative is a visible
   * grid of lines across the screen.
   */
  const spread = (rows: readonly Point[], radius: number): Point[] => {
    const centres: Point[] = [];
    for (const row of rows) {
      for (let stepY = -1; stepY <= 1; stepY += 1) {
        const y = row.y + stepY * height;
        if (y < -radius || y > height + radius) continue;
        for (let stepX = -1; stepX <= 1; stepX += 1) {
          const x = row.x + stepX * width;
          if (x < -radius || x > width + radius) continue;
          centres.push({ x, y });
        }
      }
    }
    return centres;
  };

  const starScale = 1 - stoneShare;
  // The hexagons are the smaller feature, so an equal proportional pull-back would leave a
  // thinner strap on their side. 1.4 evens the two out by eye.
  const hexScale = 1 - stoneShare * 1.4;

  const stars = spread(starRows, starOuter).map((centreOf) =>
    starPath(centreOf.x, centreOf.y, starOuter * starScale, starInner * starScale, 6, 0)
  );
  const hexes = spread(hexRows, hexRadius).map((centreOf) =>
    polygonPath(centreOf.x, centreOf.y, hexRadius * hexScale, 6, Math.PI / 6)
  );

  return { width, height, stars, hexes };
}
