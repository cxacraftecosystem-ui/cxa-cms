"use client";

/**
 * The two stitched strips and the one observer that lights them — the client half of EmbroideryEdge.
 *
 * ⚠ SPLIT FROM components/site/EmbroideryEdge.tsx SO THE MOTIF GEOMETRY STAYS ON THE SERVER. The tile is
 * a constant built from `BUTI_BY_ID` in components/craft/motifs.ts; built here, it put that whole module
 * (~14 KB compressed, the butis' paths and their descriptions) into the JavaScript of every public page,
 * because this strip is in the site layout. The server half builds the identical data URI and hands it
 * down as `mask`, so the markup, the mask and the behaviour are unchanged and motifs.ts is no longer
 * shipped to pages that draw no motif of their own. Everything else in this file is as it was; the
 * reasoning for each part is in the header of EmbroideryEdge.tsx.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";

import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";


/**
 * Complete literal class strings, looked up rather than assembled (contract §5). Nothing here is
 * built by concatenation, so every class in this file is greppable and Tailwind-scannable as written.
 */
const EDGE_CLASS = {
  set: "cxa-edge-set",
  left: "cxa-edge cxa-edge--left",
  right: "cxa-edge cxa-edge--right",
  lit: "cxa-edge--lit",
  fade: "cxa-edge--fade"
} as const;

/** The attribute the three dark bands already wear. See the header for why this and not a new one. */
const DARK_BAND_SELECTOR = "[data-splash-off]";

export function EmbroideryEdgeStrips({ mask }: { mask: string }) {
  const reduce = useReducedMotionPreference();
  const pathname = usePathname();
  const [showing, setShowing] = useState(false);
  /** The left strip: always on the page and never a dark band. See the effect. */
  const stripRef = useRef<HTMLDivElement | null>(null);

  /**
   * Is any dark band on screen right now?
   *
   * `threshold: 0` because the question is only ever "is any part of this in the viewport" — the
   * bands are full-width and taller than the screen, so a ratio would never reach a larger threshold
   * anyway. The strips are hidden while ANY band intersects, which means the edge stands down as the
   * story's first pixel arrives rather than when it has taken the screen: the alternative is
   * stitching that survives a few hundred pixels into a night-dark section, and an ornament that
   * overstays is worse than one that leaves early.
   *
   * ⚠ RE-QUERIED ON EVERY NAVIGATION, AND THAT IS NOT DEFENSIVE — IT IS THE BUG THIS COMPONENT WOULD
   * OTHERWISE HAVE. This mounts in the site frame, so it does NOT remount when the reader moves from
   * one public page to another: without `pathname` in the dependencies the observer would still be
   * holding the previous page's detached elements, which report nothing at all, and the edge would be
   * frozen at whatever the last page decided. Disconnecting and re-observing is the whole fix.
   *
   * ⚠ AND IT DROPS TO HIDDEN FIRST — in the render that carries the new page, so no frame shows the
   * previous page's answer over the new one, which on a light-to-homepage navigation is stitching
   * over the top of the hero. Falling back to hidden and letting the observer earn its way back is the
   * same rule the first paint follows.
   */
  const [observedPath, setObservedPath] = useState(pathname);
  if (pathname !== observedPath) {
    setObservedPath(pathname);
    setShowing(false);
  }

  useEffect(() => {
    const bands = new Set<Element>(document.querySelectorAll(DARK_BAND_SELECTOR));

    // The set, rather than a count: an observer delivers one entry per target and re-delivers the
    // same target whenever it crosses, so counting would drift the first time two bands are on
    // screen together (the hero leaving while the story arrives, on a page that has both).
    const covered = new Set<Element>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!bands.has(entry.target)) continue;
          if (entry.isIntersecting) covered.add(entry.target);
          else covered.delete(entry.target);
        }
        setShowing(covered.size === 0);
      },
      { threshold: 0 }
    );

    for (const band of bands) observer.observe(band);

    /*
     * ⚠ THE EDGE ALSO WATCHES ITS OWN STRIP, AND THAT IS WHAT LIGHTS IT WHERE THERE IS NO BAND AT ALL.
     * `SiteFooter` wears the attribute on every page of the site, so in the public frame there is
     * always a band to observe — but the component must not depend on that staying true: an observer
     * with nothing to observe never calls back, so "wait until the observer says it is safe" would
     * leave the edge hidden for ever on a surface with no dark band on it. Every observed target gets
     * one initial notification, and the strip is never a band (the callback skips it), so the first
     * answer is "nothing covers it" — the safe answer when there is provably nothing to hide from.
     */
    const strip = stripRef.current;
    if (strip) observer.observe(strip);

    return () => observer.disconnect();
  }, [pathname]);

  return (
    <div aria-hidden="true" style={{ "--cxa-edge-thread": mask } as CSSProperties} className={EDGE_CLASS.set}>
      <div
        ref={stripRef}
        className={cn(EDGE_CLASS.left, showing && EDGE_CLASS.lit, !reduce && EDGE_CLASS.fade)}
      />
      {/* The right-hand strip is the same tile MIRRORED, in globals.css — a border is worked
          inwards from each selvedge, so the mango leans towards the text on both sides. */}
      <div className={cn(EDGE_CLASS.right, showing && EDGE_CLASS.lit, !reduce && EDGE_CLASS.fade)} />
    </div>
  );
}
