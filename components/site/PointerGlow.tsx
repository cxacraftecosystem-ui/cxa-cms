"use client";

/**
 * PointerGlow — a panel whose light follows the reader's pointer.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A WRAPPER THAT TAKES CHILDREN, RATHER THAN A COMPONENT THAT RENDERS THE PANEL.
 *
 * `CtaSection` is a Server Component and is worth keeping that way — `LinkButton` renders an `<a>`,
 * so today the whole invitation ships no JavaScript at all. Making it a client component to add one
 * gradient would put its heading, body and both buttons into the bundle of every page that carries
 * a call to action, to move a light.
 *
 * Passing the panel's content through as `children` avoids that entirely: children of a client
 * component are rendered by the SERVER and arrive as an already-built React element, so the only
 * thing that crosses into the bundle is this file. The panel's markup, its copy and its links stay
 * exactly where they were.
 *
 * ⚠ THE HANDLERS MUST BE ON THE PANEL, NOT ON THE GLOW. The glow layer is `pointer-events-none` and
 * `inset-0`, so it can never receive a pointer event of its own — and it must not, or it would sit
 * between the reader and the buttons underneath it. The panel is what listens; the glow only draws.
 *
 * ⚠ AND THE GRADIENT IS A MOTION VALUE, NEVER REACT STATE. Writing the pointer into `useState` would
 * re-render this subtree on every pointermove — sixty times a second, through whatever the caller
 * passed as children. `useMotionValue` writes straight to the DOM node's style and never touches
 * React's render loop, which is the same rule `HeroSection`'s own pointer wash follows.
 *
 * Ported from the pointer-tracked band in the Centre's other property
 * (Portal_Development_Web/frontend/components/guide/GuideHero.tsx) so the two feel like one hand,
 * including its spring — stiffness 110, damping 24, mass 0.6, which is slow enough that the light
 * trails the cursor rather than sticking to it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { ReactNode } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";

import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

export interface PointerGlowProps {
  children: ReactNode;
  /** The panel's own classes. This element IS the panel — it is not an extra wrapper. */
  className?: string;
  /**
   * The gradient's colour, as an oklch string without its alpha. Defaults to the brand's purple-500.
   * A caller on a different ground passes its own rather than getting a purple wash on a gold panel.
   */
  tint?: string;
}

/**
 * Resting position: dead centre.
 *
 * NOT a corner and not "unset". Until a pointer arrives — which on a touch device is never — the
 * panel has to look deliberate, and a light centred on the panel reads as the design rather than as
 * a gradient waiting for something to happen.
 */
const REST = 50;

export function PointerGlow({ children, className, tint = "oklch(0.648 0.19 305" }: PointerGlowProps) {
  const reduce = useReducedMotionPreference();

  const pointerX = useMotionValue(REST);
  const pointerY = useMotionValue(REST);
  const smoothX = useSpring(pointerX, { stiffness: 110, damping: 24, mass: 0.6 });
  const smoothY = useSpring(pointerY, { stiffness: 110, damping: 24, mass: 0.6 });

  // Two motion values into one CSS string, recomputed off the React render loop.
  const glow = useTransform([smoothX, smoothY], (latest: number[]) => {
    const x = latest[0] ?? REST;
    const y = latest[1] ?? REST;
    return `radial-gradient(30rem 26rem at ${x}% ${y}%, ${tint} / 0.42), transparent 64%)`;
  });

  return (
    <div
      // ⚠ Handlers are withheld entirely under reduced motion rather than being made no-ops: an
      // element carrying `onPointerMove` is a listener the browser must dispatch to on every frame
      // of every pointer movement, whether or not the callback does anything.
      onPointerMove={
        reduce
          ? undefined
          : (event) => {
              const box = event.currentTarget.getBoundingClientRect();
              pointerX.set(((event.clientX - box.left) / box.width) * 100);
              pointerY.set(((event.clientY - box.top) / box.height) * 100);
            }
      }
      onPointerLeave={
        reduce
          ? undefined
          : () => {
              pointerX.set(REST);
              pointerY.set(REST);
            }
      }
      className={cn("relative isolate", className)}
    >
      {/*
        `isolate` on the panel above is what keeps this `-z-10` inside it. Without it the layer
        would be measured against the page's own stacking context and could slide behind the panel's
        background entirely — invisible, and for a reason nobody would find quickly.

        Not rendered at all under reduction: a static centred gradient would be a second, dimmer
        light over `grad-brand`, which is already a gradient. Nothing is lost by its absence.
      */}
      {reduce ? null : (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ backgroundImage: glow }}
        />
      )}
      {children}
    </div>
  );
}
