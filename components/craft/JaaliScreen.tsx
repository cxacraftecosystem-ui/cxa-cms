"use client";

/**
 * JaaliScreen — the pierced stone lattice of Mughal architecture, used as a mask.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS. A `jaali` is a single slab of sandstone or marble cut right through into a
 * geometric lattice, set into a wall or a screen so that the room behind it is shaded, ventilated
 * and private while daylight comes through in a pattern that moves across the floor all day.
 * Fatehpur Sikri, Sidi Saiyyed in Ahmedabad, and the screens around the cenotaphs at the Taj are
 * the ones everybody has seen. The geometry here is the commonest Mughal one — hexagrams meeting
 * tip to tip on a triangular lattice with regular hexagons in the gaps between them; the proof
 * that those gaps are exactly regular hexagons is at `jaaliTile` in motifs.ts.
 *
 * **IT IS A MASK, NOT A PATTERN, AND THAT IS THE WHOLE POINT.** The lattice is not painted onto the
 * page. It is cut OUT of a gradient, so what the reader sees through the piercings is light, and
 * what they see of the stone is nothing at all. Drawing the same shapes as strokes on top would
 * give a pattern lying over the page — the opposite reading, and the reason this component exists
 * rather than a `<pattern>` fill somewhere.
 *
 * DO NOT flatten this into a repeating background image. A jaali is defined by what has been
 * removed from it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * HOW THE LAYERS SIT. One `<pattern>` holds a single repeat of the voids, so the browser instances
 * about twenty shapes across the whole screen instead of holding a copy per cell. A `<mask>` fills
 * itself with that pattern — the voids are painted white and everything else is left transparent,
 * because a luminance mask reads white as "show" and nothing as "hide". Two rects then live inside
 * the masked group: a fixed wash, and an oversized soft highlight that travels slowly, which is
 * the sun crossing a courtyard.
 *
 * MOTION. The travelling light is a CSS `transform` on one element, so it stays on the compositor,
 * and it is the only thing here that moves. Under reduced motion the class is not applied and the
 * light parks slightly right of and below centre — a composed resting position chosen to look
 * finished, not the first frame of an animation that has been stopped.
 *
 * ⚠ THE TRAVEL IS `infinite`, SO SOMEBODY HAS TO BE ABLE TO STOP IT. A 46-second loop on a backdrop
 * is a compositor animation and a promoted layer that last for the whole visit, most of which is
 * spent with this screen scrolled off the top of the page. `paused` is how the caller says "not
 * now" — `CraftTapestry` drives it from one `IntersectionObserver`, so the decision is made once for
 * the whole tapestry instead of four times over. It is an INLINE `animation-play-state` because the
 * keyframes live in a plain stylesheet that has no paused variant to switch to, and because an inline
 * declaration is the one thing that cannot lose to a utility under the plain-join `cn()`
 * (contract §5). Pausing preserves phase: the light resumes where it stopped rather than jumping.
 *
 * `aria-hidden`: it carries no information.
 */

import "@/app/craft-tapestry.css";

import { useId, useMemo } from "react";

import { jaaliTile, NATURAL_DYES } from "@/components/craft/motifs";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

/** A square drawing surface; `slice` covers whatever box the caller gives it. */
const VIEW = 480;

/**
 * How far past the surface the travelling highlight's rect reaches on every side, in user units.
 *
 * It only has to cover the surface wherever the shimmer carries it, and the farthest the keyframes
 * in app/craft-tapestry.css move it is 38 units (x) and 26 (y), so 48 always covers it. This used to
 * be a rect twice the surface in each direction — four times the area — and since the rect is its
 * own compositing layer while it moves, and `slice` scales the drawing up to cover the hero, that
 * one rect reached ~4500 CSS px square on a tablet. The highlight's geometry does not depend on
 * this number: the beam gradient is pinned in user space below, so it is the same light either way.
 */
const BEAM_REACH = 48;

export interface JaaliScreenProps {
  /** Sizing. The SVG has no size of its own — give it `h-full w-full`. */
  className?: string;
  /** Lattice pitch in SVG units. Bigger is a coarser screen and fewer nodes. */
  pitch?: number;
  /** How much of each void is given back to the stone, as a fraction. 0.2 is a delicate screen. */
  stoneShare?: number;
  /** Let the light travel across the screen. Ignored under reduced motion. */
  shimmer?: boolean;
  /**
   * Hold the travelling light still without unmounting it — for a screen that is off screen or in a
   * background tab. Phase-preserving, so it is safe to flip as often as visibility changes.
   */
  paused?: boolean;
}

export function JaaliScreen({
  className,
  pitch = 24,
  stoneShare = 0.2,
  shimmer = true,
  paused = false
}: JaaliScreenProps) {
  const reduce = useReducedMotionPreference();
  // Unique per instance: two screens on one page would otherwise share whichever `<mask>` the
  // document happened to define first.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const tile = useMemo(() => jaaliTile(pitch, stoneShare), [pitch, stoneShare]);

  const moving = shimmer && !reduce;

  const patternId = `${uid}-stone`;
  const maskId = `${uid}-pierce`;
  const washId = `${uid}-wash`;
  const beamId = `${uid}-beam`;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      preserveAspectRatio="xMidYMid slice"
      className={cn("block", className)}
    >
      <defs>
        <pattern
          id={patternId}
          width={tile.width}
          height={tile.height}
          patternUnits="userSpaceOnUse"
        >
          {/*
            White is a MECHANISM here, not a colour choice: a luminance mask shows what is white
            and hides what is not, so the voids must be pure white and the stone must be nothing at
            all. No neutral is being hardcoded — nothing white is ever painted on the page.
          */}
          {tile.stars.map((d, index) => (
            <path key={`star-${index}`} d={d} fill="#ffffff" />
          ))}
          {tile.hexes.map((d, index) => (
            <path key={`hex-${index}`} d={d} fill="#ffffff" />
          ))}
        </pattern>

        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={VIEW} height={VIEW}>
          <rect x="0" y="0" width={VIEW} height={VIEW} fill={`url(#${patternId})`} />
        </mask>

        {/*
          The light behind the screen: warm at its source, cooling to the indigo of the room it is
          coming into. Anchored up and to the right so the lit corner is away from where a hero's
          headline sits.
        */}
        <radialGradient id={washId} cx="0.74" cy="0.22" r="0.86">
          {/*
            The turmeric core is held to a quarter opacity over a fifth of the radius. Gold is
            allowed in a hero and nowhere else (contract §1.1), and "allowed" is not "generous".
          */}
          <stop offset="0%" stopColor={NATURAL_DYES.turmeric.color} stopOpacity="0.26" />
          <stop offset="22%" stopColor={NATURAL_DYES.lac.color} stopOpacity="0.42" />
          <stop offset="100%" stopColor={NATURAL_DYES.indigo.color} stopOpacity="0.7" />
        </radialGradient>

        {/*
          In USER SPACE, centred on the surface with a radius of one surface width — the exact circle
          the old 2×-sized rect drew with `objectBoundingBox` (centre 0.5, radius 0.5 of 960 units).
          Pinning it here is what lets the rect below shrink without moving or resizing the light;
          the rect's transform still carries the gradient with it, because user space includes it.
        */}
        <radialGradient
          id={beamId}
          gradientUnits="userSpaceOnUse"
          cx={VIEW / 2}
          cy={VIEW / 2}
          r={VIEW}
        >
          <stop offset="0%" stopColor={NATURAL_DYES.myrobalan.color} stopOpacity="0.5" />
          <stop offset="55%" stopColor={NATURAL_DYES.myrobalan.color} stopOpacity="0.14" />
          <stop offset="100%" stopColor={NATURAL_DYES.myrobalan.color} stopOpacity="0" />
        </radialGradient>
      </defs>

      <g mask={`url(#${maskId})`}>
        <rect x="0" y="0" width={VIEW} height={VIEW} fill={`url(#${washId})`} />
        {/*
          Larger than the surface by BEAM_REACH on every side, so wherever the shimmer carries it the
          rect's edge never enters the frame — and no larger, because its size is the size of a layer.
        */}
        <rect
          x={-BEAM_REACH}
          y={-BEAM_REACH}
          width={VIEW + BEAM_REACH * 2}
          height={VIEW + BEAM_REACH * 2}
          fill={`url(#${beamId})`}
          // Only set while it is actually holding something still: an unconditional `running` would be
          // a declaration on every jaali on every page saying nothing.
          style={moving && paused ? { animationPlayState: "paused" } : undefined}
          className={cn("cxa-jaali-light", moving && "cxa-jaali-light--shimmer")}
        />
      </g>
    </svg>
  );
}
