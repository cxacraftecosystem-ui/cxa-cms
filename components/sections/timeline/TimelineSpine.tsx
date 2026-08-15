"use client";

/**
 * TimelineSpine — the vertical rail behind a chronology, and the scroll-linked fill that runs down it.
 *
 * It is its own client module for one reason: `ScrollProgress` measures a `RefObject`, and a ref
 * needs a hook. Keeping the hook here rather than marking the whole `TimelineSection` as a client
 * component means the entries — forty of them on a long history, each possibly carrying a
 * `MediaImage` — stay server-rendered and out of the browser bundle. Children passed from a Server
 * Component to a client one are rendered on the server; only this wrapper ships.
 *
 * There is no second scroll instrument here. `ScrollProgress` already owns "how far down are we":
 * one smoothed MotionValue, `SPRING_SCROLL`, a static track that survives reduced motion and a
 * travelling node that does not. A bespoke `useScroll` for the timeline would be the same instrument
 * built twice, drifting by a frame.
 */

import { useRef, type ReactNode } from "react";

import { ScrollProgress } from "@/components/motion/ScrollProgress";
import { cn } from "@/lib/utils";

export interface TimelineSpineProps {
  children: ReactNode;
  className?: string;
}

export function TimelineSpine({ children, className }: TimelineSpineProps) {
  const railRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={railRef} className={cn("relative", className)}>
      {/*
        `inset-y-2` is what gives the track a height — without a definite height it renders as
        nothing at all. It stops short of the first and last dot so the line reads as joining the
        entries rather than as running off the ends of the list.
      */}
      <ScrollProgress target={railRef} node className="absolute inset-y-2 left-2" />
      {children}
    </div>
  );
}
