"use client";

/**
 * KolamLattice — the South Indian threshold drawing, drawn as one line.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS. Before dawn, the ground in front of the door is swept and watered, a grid of dots
 * — `pulli` — is laid out in rice flour between finger and thumb, and then a single line is walked
 * around those dots in one continuous movement, without lifting the hand, until it closes on itself
 * where it began. It is done again tomorrow. Feeding the ants is part of the reason the medium is
 * rice flour.
 *
 * Two things about it are load-bearing here and neither is decorative:
 *
 *  1. **The dots come first and are visible.** They are the armature. They are also the STATIC half
 *     of this layer's signal: the line arrives as an animation, and a signal that exists only as
 *     motion is a signal a reduced-motion reader never gets (contract §1.4). Under reduced motion
 *     the dots and the finished line are simply there, and that resting state is the design —
 *     not a stopped animation.
 *  2. **It is ONE line.** `kolamFigure` in motifs.ts builds it as a mirror curve, which is the
 *     accepted formal description of a `sikku` kolam, and the number of separate closed loops is
 *     gcd(cols, rows). The default 7 × 5 is coprime, so the figure really is single-stroke, and the
 *     `<path>` really can be drawn from one end to the other like a hand.
 *
 * A pair with a common factor (6 × 4) genuinely cannot be drawn without lifting the hand. That is a
 * property of the form, not a bug, and the figure then holds several subpaths which the dash
 * animation draws one after another.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE DRAW. `pathLength="1000"` normalises the dash arithmetic to a thousandth of the figure
 * whatever its real length, so the keyframes in app/craft-tapestry.css are plain numbers and
 * nothing has to call `getTotalLength()` — which can only run on the client, after layout, and
 * would therefore be a flash on a prerendered page.
 *
 * Both halves of the reduced-motion contract are covered. The JS branch swaps the animating class
 * for the plain one, so nothing moves; and because the class in the server's markup is the
 * animating one, the CSS rules in globals.css collapse the animation to 0.01ms for the instant
 * before hydration, landing on the same finished line. The initial state is identical for every
 * reader, so there is no flash either way (contract §8).
 *
 * Colour comes from `currentColor` so the caller sets it once with a text utility and the dots and
 * the line stay in step.
 */

import "@/app/craft-tapestry.css";

import { useMemo } from "react";

import { kolamFigure } from "@/components/craft/motifs";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

export interface KolamLatticeProps {
  /** Sizing and colour — the SVG uses `currentColor`. Give it a width; the height follows. */
  className?: string;
  /** `pulli` across. Keep this coprime with `rows` for a true single-stroke kolam. */
  cols?: number;
  /** `pulli` down. */
  rows?: number;
  /** Draw the line as though by hand. Ignored under reduced motion. */
  animate?: boolean;
}

export function KolamLattice({ className, cols = 7, rows = 5, animate = true }: KolamLatticeProps) {
  const reduce = useReducedMotionPreference();
  const figure = useMemo(() => kolamFigure(cols, rows), [cols, rows]);

  const drawing = animate && !reduce;

  /**
   * Room for the outermost loops, which swing a full half-pitch beyond the dot field, plus a
   * little for the stroke's own width so it is not clipped at the corners.
   */
  const pad = 1.6;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`${-pad} ${-pad} ${figure.width + pad * 2} ${figure.height + pad * 2}`}
      className={cn("block", className)}
    >
      {/* The `pulli`, laid before the line as they are on the ground. */}
      <g fill="currentColor" opacity={0.55}>
        {figure.dots.map((dot) => (
          <circle key={`${dot.x}-${dot.y}`} cx={dot.x} cy={dot.y} r={0.34} />
        ))}
      </g>

      <path
        d={figure.d}
        // Normalises every dash length to a thousandth of the figure. See the header.
        pathLength={1000}
        stroke="currentColor"
        strokeWidth={0.42}
        className={cn("cxa-kolam-line", drawing && "cxa-kolam-line--draw")}
      />
    </svg>
  );
}
