"use client";

/**
 * PointerDrift — a layer that leans gently toward the reader's pointer.
 *
 * The depth cue the ChartMate hero carries on its floating chips, in this repo's own dialect: two
 * springs on `SPRING_POINTER` (the hero pointer-wash spring — contract §8's table, never a local
 * number) fed from the element's OWN pointermove, so the cost is zero until the pointer is
 * actually over the piece and the springs settle home on leave.
 *
 * ⚠ THE THINGS THAT KEEP IT CHEAP AND CORRECT:
 *   • Element-local listener, not `window` — a story movement listens only while hovered, where
 *     the ChartMate hero pays for every mouse move on the page.
 *   • The offsets come from the event's position within the element (`offsetX`-style arithmetic
 *     from `getBoundingClientRect` ONCE per enter, not per move — a per-move rect read is a
 *     forced layout on every mouse move, the exact sin the ChartMate aurora comment warns about).
 *   • Coarse pointers never attach anything: a phone cannot hover, and the listener would only
 *     fire on taps, which reads as the layout twitching.
 *   • Reduced motion renders children in a plain div — framer never mounts, nothing can move.
 *   • GSAP never touches THIS element — scrubbed children animate their own nodes, so the two
 *     systems never share a transform (contract §8).
 */

import { motion, useSpring } from "framer-motion";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

import { SPRING_POINTER } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

export interface PointerDriftProps {
  /** Maximum travel from centre, in px, at the element's far edge. */
  depth?: number;
  className?: string;
  children: ReactNode;
}

export function PointerDrift({ depth = 10, className, children }: PointerDriftProps) {
  const reduce = useReducedMotionPreference();
  const x = useSpring(0, SPRING_POINTER);
  const y = useSpring(0, SPRING_POINTER);

  const rectRef = useRef<DOMRect | null>(null);

  // A live media query rather than a one-off read — the hero does the same for its pointer wash:
  // a convertible gains a fine pointer when its mouse arrives, and should gain the drift with it.
  const [finePointer, setFinePointer] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(pointer: fine)");
    const sync = () => setFinePointer(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /*
   * ⚠ ONE ELEMENT TYPE FOR THE COMPONENT'S WHOLE LIFE. The first draft returned a plain `<div>`
   * for reduce/coarse and a `<motion.div>` otherwise — and `finePointer` RESOLVES AFTER MOUNT, so
   * the swap unmounted and remounted the entire subtree on the first render of every page load.
   * The mandala lives in that subtree, and the stage had already bound its kolam and orbit
   * ScrollTriggers to the ORIGINAL nodes — leaving them scrubbing detached elements (the review
   * caught it). Always `motion.div`; inactivity is expressed by never moving the springs and not
   * attaching listeners, which framer renders as no transform at all.
   */
  const active = !reduce && finePointer;

  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    rectRef.current = event.currentTarget.getBoundingClientRect();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = rectRef.current;
    if (!rect || rect.width === 0 || rect.height === 0) return;
    x.set(((event.clientX - rect.left) / rect.width - 0.5) * 2 * depth);
    y.set(((event.clientY - rect.top) / rect.height - 0.5) * 2 * depth);
  };
  const onPointerLeave = () => {
    x.set(0);
    y.set(0);
  };

  // A reader who flips reduced motion mid-hover must not be left holding a stray offset.
  useEffect(() => {
    if (!active) {
      x.set(0);
      y.set(0);
    }
  }, [active, x, y]);

  return (
    <motion.div
      style={{ x, y }}
      {...(active
        ? { onPointerEnter, onPointerMove, onPointerLeave }
        : {})}
      className={className}
    >
      {children}
    </motion.div>
  );
}
