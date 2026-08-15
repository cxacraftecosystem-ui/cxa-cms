"use client";

/**
 * PigmentDrift — natural dye held in suspension.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT.
 *
 * Ground indigo, madder root, turmeric and lac sitting in water: heavy particles, few of them,
 * moving slowly downward and sideways, coming to rest. **This is not a starfield.** Nothing
 * twinkles, nothing streams past, nothing flickers, and there are deliberately only a dozen or so
 * grains. The moment a field of dots gets fast, numerous or bright it stops reading as pigment and
 * starts reading as a screensaver — and the Centre studies the pigment.
 *
 * The grains are weighted towards the lower part of the frame, because that is where suspended
 * matter ends up. The resting arrangement is composed to look settled on its own, which is what a
 * reduced-motion reader gets: nothing moves, and what is left is the design rather than an
 * animation someone has paused.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY PLAIN HTML AND NOT SVG. Each grain is a `<span>` with a radial-gradient background, so the
 * soft edge costs nothing — no blur filter, no mask, no per-grain filter region for the compositor
 * to rasterise. The only animated property is `translate3d`, which stays on the compositor, and
 * the amplitudes and timings arrive as inline custom properties consumed by ONE keyframe rule in
 * app/craft-tapestry.css. Inline styles rather than Tailwind arbitrary values because a class built
 * by concatenation is purged (contract §5) and fourteen literal classes would be fourteen
 * literals to keep in step.
 *
 * Positions, sizes, colours and timings all come from `stableHash`, never `Math.random()`: this
 * renders on the server and again on the client, and a random field would be a hydration mismatch
 * that re-rolled on every re-render.
 *
 * `aria-hidden` and `pointer-events-none`: it carries no information and must never take a click
 * away from whatever is sitting over it.
 */

import "@/app/craft-tapestry.css";

import { useMemo, type CSSProperties } from "react";

import { hashRange, hashUnit, NATURAL_DYES, type DyeName } from "@/components/craft/motifs";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

/**
 * The pots, in the proportion a dye house would actually have them: mostly indigo, some madder,
 * a little lac, and turmeric as a trace.
 *
 * Walked by index rather than by hash, so the proportions are exactly these however many grains a
 * caller asks for, and gold stays where it was put. It is the LAST entry deliberately: gold is
 * marketing-only (contract §1.1), so at the default sixteen grains there is one of it, and at the
 * nine of `CraftTapestry`'s quiet intensity there is none at all.
 */
const GRAIN_DYES: readonly DyeName[] = [
  "indigo",
  "indigoDeep",
  "indigo",
  "madder",
  "indigo",
  "lac",
  "indigo",
  "indigoDeep",
  "indigo",
  "madder",
  "indigo",
  "turmeric"
];

export interface PigmentDriftProps {
  /** Sizing and position. Grains are placed as percentages inside this box. */
  className?: string;
  /** How many grains. Keep it low: this reads as suspension because there are few of them. */
  count?: number;
  /** Same seed, same suspension, every render and every request. */
  seed?: string;
  /** Let the grains drift. Ignored under reduced motion. */
  drift?: boolean;
  /**
   * Hold every grain still without unmounting it — for a field that is off screen or in a background
   * tab. Phase-preserving, so it is safe to flip as often as visibility changes.
   *
   * ⚠ THIS MATTERS MORE HERE THAN ANYWHERE ELSE IN THE TAPESTRY. Each grain carries its own infinite
   * `alternate` animation, so at the default count that is sixteen never-ending compositor animations
   * and sixteen promoted layers, on a backdrop that spends most of a visit scrolled off the top of the
   * page. `CraftTapestry` drives this from one `IntersectionObserver` for the whole tapestry.
   */
  paused?: boolean;
}

interface Grain {
  key: string;
  style: CSSProperties;
}

export function PigmentDrift({
  className,
  count = 16,
  seed = "pigment",
  drift = true,
  paused = false
}: PigmentDriftProps) {
  const reduce = useReducedMotionPreference();
  const grains = useMemo(() => suspendGrains(count, seed), [count, seed]);

  const moving = drift && !reduce;
  /**
   * Spread onto each grain rather than folded into `suspendGrains`, so pausing does not invalidate the
   * memo and re-derive every position from the hash for a change that touches one declaration. It is
   * built once per render instead of once per grain.
   */
  const hold: CSSProperties | null = moving && paused ? { animationPlayState: "paused" } : null;

  return (
    <div aria-hidden="true" className={cn("pointer-events-none", className)}>
      {grains.map((grain) => (
        <span
          key={grain.key}
          style={hold ? { ...grain.style, ...hold } : grain.style}
          className={cn(
            "absolute block rounded-full",
            moving && "cxa-pigment-grain--drift"
          )}
        />
      ))}
    </div>
  );
}

/**
 * Where each grain hangs, how big it is, what it is made of, and how slowly it settles.
 *
 * `top` is biased downward by raising a uniform value to a power below one — matter in suspension
 * collects towards the bottom, and an even scatter is the thing that looks like a night sky.
 * `size` is biased the other way, by cubing, so most grains are small and only one or two are the
 * large soft ones that give the field its depth.
 *
 * The delay is NEGATIVE, which starts each grain part-way through its own cycle. Without it every
 * grain sets off together on load and the whole field pulses in unison, which is the single
 * fastest way to make fourteen independent particles look like one animation.
 */
function suspendGrains(count: number, seed: string): Grain[] {
  const total = Math.max(0, Math.min(40, Math.round(count)));
  const grains: Grain[] = [];

  for (let index = 0; index < total; index += 1) {
    const key = `${seed}:${index}`;

    const size = Math.round(9 + hashUnit(key, "size") ** 3 * 34);
    const dyeName = GRAIN_DYES[index % GRAIN_DYES.length] ?? "indigo";
    const dye = NATURAL_DYES[dyeName].color;

    // Settling, so the travel is mostly downward with a little sideways wander.
    const duration = Math.round(hashRange(56, 112, key, "duration"));

    grains.push({
      key,
      style: {
        left: `${round2(hashRange(2, 96, key, "left"))}%`,
        top: `${round2(14 + hashUnit(key, "top") ** 0.72 * 80)}%`,
        width: `${size}px`,
        height: `${size}px`,
        opacity: round2(hashRange(0.28, 0.72, key, "opacity")),
        backgroundImage: `radial-gradient(circle at 42% 36%, ${dye} 0%, ${dye} 22%, transparent 72%)`,
        // Consumed by `cxa-pigment-settle` in app/craft-tapestry.css.
        "--cxa-drift-x": `${round2(hashRange(-16, 16, key, "drift-x"))}px`,
        "--cxa-drift-y": `${round2(hashRange(10, 48, key, "drift-y"))}px`,
        "--cxa-drift-duration": `${duration}s`,
        "--cxa-drift-delay": `-${Math.round(hashUnit(key, "phase") * duration)}s`
        // Custom properties are not part of `CSSProperties`, and this is the pattern React itself
        // documents for setting them from JS.
      } as CSSProperties
    });
  }

  return grains;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
