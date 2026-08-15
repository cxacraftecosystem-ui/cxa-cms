"use client";

/**
 * ScrollProgress — the reading-progress spine for long pages.
 *
 * A vertical track with a fill that grows as the reader descends, and an optional node that travels
 * with the fill's head. It is ONE MotionValue: framer's `scrollYProgress`, smoothed once by
 * SPRING_SCROLL and then read by both the fill's `scaleY` and the node's `y`. Two independently
 * animated values would drift apart by a frame or two and the node would visibly detach from the tip
 * of its own fill.
 *
 * ⚠ BOTH READERS ARE TRANSFORMS, AND THE NODE'S ONE HAS TO BE. A spring goes on producing frames for
 * a while after the reader's finger stops, so whatever it writes is written sixty times a second past
 * the end of the gesture. `transform` is handed to the compositor; `top` is a layout property, and a
 * new value on every frame is a reflow and a repaint on the main thread instead. That is why the node
 * is pinned at `top: 0` and moved by a measured pixel offset — see the ResizeObserver below.
 *
 * UNDER REDUCED MOTION the spring is bypassed and the raw scroll value is used — not a shorter
 * spring, none at all. The fill then reports the scroll position exactly, which is the same
 * information the scrollbar is already giving, and the travelling node is not rendered: a dot that
 * glides is decoration, and decoration is what the preference asked to be spared.
 *
 * `aria-hidden` on the wrapper, and therefore on everything inside it. A scroll position is not
 * information a screen reader needs announced — the reader already knows where they are, and there is
 * emphatically no `aria-live` here: it would interrupt on every scroll event for a fact the assistive
 * technology reports natively (contract §8).
 *
 * LAYOUT. The outer element takes the caller's classes and is where the position, height and z-index
 * belong (`fixed left-6 top-32 bottom-32 z-40`, say — pick z from the ladder in §6, never invent
 * one). The inner track is always `relative`, so the caller's own `position` utility cannot collide
 * with it; `cn()` is a plain join, and with two position utilities in one class string the CSS source
 * order decides, not the order you wrote them.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { motion, useScroll, useSpring, useTransform } from "framer-motion";

import { cn } from "@/lib/utils";
import { SPRING_SCROLL } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

export interface ScrollProgressProps {
  /**
   * The article to measure. Omit to measure the whole document — which is right for a page that IS
   * the article, and wrong for one with a long footer the reader is not "reading".
   */
  target?: RefObject<HTMLElement | null>;
  /** Render the travelling node at the head of the fill. Never rendered under reduced motion. */
  node?: boolean;
  /** Position, height and z-index go here. It needs a definite height to be visible at all. */
  className?: string;
}

export function ScrollProgress({ target, node = false, className }: ScrollProgressProps) {
  const reduce = useReducedMotionPreference();
  const trackRef = useRef<HTMLDivElement>(null);
  /**
   * How far the node has to travel, in pixels.
   *
   * The track's height comes from the caller's classes (`inset-y-2` on a rail, `top-32 bottom-32` on a
   * fixed spine), so it is only knowable by measurement — and it changes when the page reflows, which
   * on a chronology happens every time an image finishes loading. `offsetHeight` rather than the
   * observer's `contentRect` because the entry array is `T | undefined` under noUncheckedIndexedAccess
   * and the element is right there. Nothing here can loop: the state it sets only moves a transform.
   */
  const [trackHeight, setTrackHeight] = useState(0);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(() => setTrackHeight(track.offsetHeight));
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  // With a target: 0 when its top meets the top of the viewport, 1 when its bottom meets the bottom —
  // so the spine is full exactly when the last line has been reached, not when the page has.
  const { scrollYProgress } = useScroll(
    target ? { target, offset: ["start start", "end end"] } : undefined
  );

  const smoothed = useSpring(scrollYProgress, SPRING_SCROLL);
  const progress = reduce ? scrollYProgress : smoothed;
  // Zero until the observer has reported, which is where the node belongs at a progress of zero
  // anyway — so the first paint is right and the measurement only ever extends its reach.
  const nodeY = useTransform(progress, [0, 1], [0, trackHeight]);

  return (
    <div aria-hidden="true" className={cn("pointer-events-none", className)}>
      <div ref={trackRef} className="relative h-full w-px bg-line-200">
        <motion.div
          className="absolute inset-x-0 top-0 h-full origin-top bg-purple-700"
          style={{ scaleY: progress }}
        />

        {node && !reduce ? (
          // Centred on the track with NEGATIVE MARGINS, not `-translate-x-1/2`. That was always the
          // rule (contract §8) and it is now load-bearing twice over: `y` IS the transform framer
          // writes inline on this element, so a translate utility would not merely lose — it would be
          // overwritten sixty times a second.
          <motion.span
            style={{ y: nodeY }}
            className="absolute left-1/2 top-0 -ml-1 -mt-1 block h-2 w-2 rounded-full bg-purple-700 shadow-glow-soft"
          />
        ) : null}
      </div>
    </div>
  );
}
