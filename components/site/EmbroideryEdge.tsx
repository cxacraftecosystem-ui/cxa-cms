"use client";

/**
 * EmbroideryEdge — a worked selvedge down the left and right of the page's paper.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS. A length of hand-printed cotton is finished at both selvedges with a narrow worked
 * border: a running stitch down each side and a column of small `buti` between them, at a fraction
 * of the size of the ones in the field. It is the last thing a printer adds and the first thing you
 * see when the cloth is folded. That is what this draws, at the edge of the light part of the page —
 * a decorated margin, not a border. If it is the first thing a reader notices, it is too strong.
 *
 * THE GEOMETRY IS NOT NEW. Every path comes from `BUTI_BY_ID` in components/craft/motifs.ts — the
 * same four blocks `BlockPrintField` prints across the hero, drawn here at roughly half size in a
 * 20 × 56 unit tile. Nothing about the ornament is invented at this edge; only the arrangement is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ ONE `mask-image`, NOT A HUNDRED ELEMENTS AND NOT A COLOURED PICTURE. The tile is a static file,
 * public/edge-thread.svg, built from the motifs by scripts/build-edge-thread.ts (see
 * components/site/embroidery-edge-tile.ts) and handed to CSS as a mask, exactly the reading `JaaliScreen`
 * argues for: the strip is a plain rectangle of a TOKEN colour with the stitches cut out of it. So
 * the thread follows `--ink-300` into the dark theme like everything else on the site, and there is
 * one element per edge rather than one per stitch. A background IMAGE would have had to bake a
 * neutral into the URI and then carry a second, dark copy of it — a literal colour that could not
 * invert, which is precisely what contract §1.2 exists to stop.
 *
 * ⚠ IT IS `position: fixed`, WHICH IS THE ONLY PLACEMENT THAT WORKS ON THIS SITE. Three were tried
 * on paper before this one was written:
 *
 *   • A strip BEHIND the content, showing through the gap between the page canvas and the sections.
 *     There is no such gap — `components/site/SplashCursor.tsx`'s header records the same discovery
 *     for the fluid canvas: "this site's sections carry full-width opaque grounds of their own", so
 *     anything under them is under everything, always.
 *   • A background painted onto each of `<main>`'s children. That means writing `background-image`
 *     over whatever ground a section already has — `.grad-mesh` and `.ambient-light` are two of the
 *     three sanctioned gradient recipes and both are backgrounds — and it means the ornament's shape
 *     depends on a page structure the CMS decides, not this file.
 *   • An absolute overlay the full height of the frame, with the purple bands raised above it. That
 *     one works and is still wrong: raising `[data-splash-off]` to a rung above the fluid cursor is
 *     a real change to how the hero, the story and the footer paint, made from a stylesheet, in the
 *     name of a decorative margin. The blast radius is three of the biggest surfaces on the site.
 *
 * Fixed costs one `IntersectionObserver` and nothing else: no stacking contract is touched, no
 * section's background is overwritten, and it works identically on a page the studio built this
 * morning. It also cannot lengthen the document — a fixed box contributes nothing to scrollable
 * overflow — so there is no width at which this produces a horizontal scrollbar.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHY IT READS `data-splash-off` RATHER THAN AN ATTRIBUTE OF ITS OWN
 *
 * The edge must not appear over the three dark purple bands — the hero, the cinematic story and the
 * closing footer. All three already carry `data-splash-off`, and the decision went this way:
 *
 *   • A NEW attribute (`data-edge-off`, say) would have to be added to `HeroSection`,
 *     `CinematicScroll` and `SiteFooter` — and then remembered by whoever writes the fourth purple
 *     band. An opt-out nobody remembers to set fails SILENTLY and in the ugliest possible direction:
 *     pale lavender stitching down both sides of a night-dark hero.
 *   • Reusing `data-splash-off` risks the other trap — one attribute meaning two things, so a later
 *     hand removing the fluid cursor takes the attribute with it and breaks something unrelated.
 *
 * What settles it is that `data-splash-off` HAS NO READER TODAY. Grep it: three files set it, none
 * consumes it. It is not the fluid cursor's private switch; it is a claim the three bands make about
 * themselves, and the comment beside each one says so in nearly the same words — "the splash cursor
 * stands down over the hero's own weather", "the story has its own weather". The set it names is
 * exactly "this band is a dark ground carrying its own atmosphere; site-wide ornament stands down
 * here", which is the question this component has to ask. Reusing it also means the answer is right
 * on every page from the moment this mounts, including CMS-built pages nobody has looked at.
 *
 * ⚠ SO THE ATTRIBUTE IS NOW LOAD-BEARING IN TWO PLACES AND MUST NOT BE CLEANED UP WITH THE CURSOR.
 * If `SplashCursor` is ever removed, `data-splash-off` stays. If a fourth dark band is added, it
 * carries the attribute. Those two sentences are the whole maintenance cost of this decision, and
 * they are cheaper than a second attribute with the same failure mode and none of the reach.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * FIRST PAINT. `showing` starts FALSE on the server and on the first client render, and only the
 * observer's callback can ever turn it on (contract §8). That is not caution about hydration alone — the server
 * cannot know where the reader is on the page, and the homepage opens ON a dark band, so "visible
 * until proven otherwise" would stamp the stitching across the hero for one frame of every cold
 * load. Hidden is both the safe answer and the correct one for the commonest entry point.
 *
 * MOTION. The only thing that moves is `opacity`, as a CSS transition on a class this file adds or
 * withholds — the same shape as `KolamLattice`: the server markup carries the transitioning class,
 * so the reduced-motion rules in globals.css flatten it for the instant before hydration, and
 * `useReducedMotionPreference()` withholds it afterwards. A reader who asked for less motion gets
 * the edge appearing and disappearing instantly, which is a resting state rather than a stopped
 * animation. No framer here and no spring: this is one compositor property on a decoration, and
 * `components/motion/constants` exists so that a JS animation reaches the house curve — a CSS rule
 * can write that curve directly, which globals.css does.
 *
 * PLACEMENT. ONCE, in `app/(site)/layout.tsx`, inside the frame `<div>` that already holds the
 * header, `<main>` and the footer — beside `<SplashCursorMount />` is the natural spot, since the two
 * are the same kind of thing: a site-wide ornament that belongs to the frame rather than to a page.
 * It needs no `relative` parent and takes no space (the strips are fixed and the carrier is
 * `display: contents`), so nothing about that div has to change. It must NOT be mounted per page or
 * per section: the observer would then be one per instance, and two instances would ship the tile
 * twice.
 *
 * `aria-hidden` and `pointer-events: none`: it carries no information and must never take a press.
 */

import { useEffect, useRef, useState } from "react";
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

export function EmbroideryEdge() {
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
    <div aria-hidden="true" className={EDGE_CLASS.set}>
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
