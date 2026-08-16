"use client";

/**
 * MandalaOrb — the mandala becoming the orb, on one scroll value.
 *
 * The chapter's argument is that craft and intelligence are the same lineage, so the ornament does
 * not sit BESIDE the orb and it does not cross-fade with it: it TURNS INTO it. As the section
 * travels the viewport the mandala rotates, contracts toward its own centre, sheds its outer rings
 * and dissolves, while the orb rises through the hole it leaves — scaling up, fading in, its glow
 * blooming. Both halves are `useTransform`s of ONE MotionValue (`flow`, below). Two scroll
 * subscriptions would drift by a frame or two under a spring and the reader would see two
 * animations that happen to overlap, which is precisely the thing this is not.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS NOT A PATH MORPH, AND IT WAS NEVER GOING TO BE
 *
 * The orb is a WebGL shader (components/ui/voice-powered-orb) and the mandala is 1,876 filled
 * sub-paths. There is no honest interpolation between those two things — a "morph" would have meant
 * throwing away the shader and tweening a thousand outlines into a circle, at a cost no decoration
 * on a landing page can justify. What is built here is the READING of a morph: coaxial, concentric,
 * one contracting as the other expands, handing over across the same stretch of scroll. That is the
 * effect the owner asked for; the mechanism is transforms and opacity, which is what the compositor
 * can actually afford sixty times a second.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE ARTWORK. `/public/mandala.svg` is a 28-fold-symmetric line mandala reduced from a 2,386,808
 * byte Illustrator export to 35,856 bytes — see the note above MANDALA_MASK for how, and for what
 * was given up. It is referenced as a CSS `mask-image`, never imported, so it is a cacheable static
 * asset and contributes nothing to the JS bundle.
 *
 * WHY A MASK RATHER THAN `<img>` + `currentColor`. The asset carries `fill="currentColor"` so that
 * anyone who ever inlines it gets a tintable mandala — but an SVG loaded through `<img>` or
 * `mask-image` is an ISOLATED DOCUMENT and does not inherit the host page's `color`. I tried it:
 * `<img src="/mandala.svg">` inside a `text-gold-300` box renders BLACK, because `currentColor`
 * resolves against the SVG document's own initial `color`. A mask has no such problem — the artwork
 * supplies alpha only and the page supplies every pixel of paint, so the two layers below are
 * tinted by their own gradients and can be re-tinted by editing this file alone.
 */

import type { ReactNode, RefObject } from "react";
import { motion, useScroll, useSpring, useTransform } from "framer-motion";

import { SPRING_SCROLL } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

/**
 * The mask, and the compression story behind it.
 *
 * The source (`944544_ODURBM1.svg`, Illustrator 27.5) was 2,386,808 bytes of 3,477 paths. svgo 3 on
 * its own only reached 1,740,397 — a 27% saving on a 2.3 MB decoration is no saving at all, because
 * the bytes ARE the path data (1,630,490 of them) and no amount of attribute tidying touches that.
 * Two things got it to 35,856:
 *
 *   1. THE ARTWORK IS 28-FOLD SYMMETRIC. Path counts per concentric band come out as 28, 56, 84,
 *      112, 140, 168, 196, 224 and the modal angular gap between neighbouring motifs is 12.75°,
 *      against a perfect 360/28 = 12.857°. So one 12.857° sector is kept in a `<defs>` group and
 *      stamped 28 times with `<use transform="rotate(…)">`. Sector membership is decided by each
 *      path's centroid, which is a near-partition rather than an exact one: sector zero caught 67
 *      of the 1,836 ink paths where a perfect 28th would be 65.6, so the asset draws about 2% MORE
 *      shapes than the source did. That costs nothing — see (2), the result is a union — and it is
 *      why the sub-path count above is 1,876 and not 1,836. A second svgo pass then merges those 67
 *      into 52 `<path>` elements, since with the fills gone they share every attribute, so what
 *      actually ships is 52 elements referenced 28 times.
 *      ⚠ THIS IS A REAL VISUAL CHANGE AND IT IS WORTH SAYING OUT LOUD. The source was auto-traced,
 *      so the 28 sectors are NEAR-identical rather than identical — the same motif came out as 104
 *      to 125 points depending on the sector, sitting up to 0.4° off the ideal grid. Folding
 *      replaces those 28 hand-wobbled variants with 28 exact rotations of one of them. For a
 *      mandala — an object whose entire subject is exact rotational symmetry — that reads as the
 *      tracing noise being cleaned up, not as detail being lost. A designer redrawing this properly
 *      would land in the same place.
 *   2. THE WHITE PATHS WERE DROPPED. The source is not "mostly white": it is 1,641 white paths,
 *      1,758 near-black and 78 dark grey. The white ones are the mandala's PAPER — the opaque
 *      silhouette the linework is drawn on — not highlights. On a page this dark they would have
 *      punched a near-black disc through the section background, and as a mask they would have
 *      filled every petal solid. Keeping only the ink leaves the delicate outline drawing the
 *      source actually is, and makes the fold safe twice over: with every remaining path the same
 *      colour the result is a union of shapes, so nothing depends on paint order and re-ordering
 *      the sectors cannot break the picture.
 *
 * Rendered side by side against the 2.28 MiB original at 380px, the 35 KiB result is not
 * distinguishable. Coordinates are at svgo `--precision=2`, i.e. 0.01 of an 800 unit viewBox, which
 * at the ~500px this ever paints at is 0.006 of a pixel.
 *
 * ⚠ `mask-size: contain` and `mask-repeat: no-repeat` are BOTH load-bearing. The asset has a
 * `viewBox` and no width/height, so it has a ratio and no intrinsic size; the initial `mask-repeat`
 * is `repeat`, and without these two the mandala tiles.
 */
const MANDALA_MASK = {
  maskImage: "url(/mandala.svg)",
  maskSize: "contain",
  maskPosition: "center",
  maskRepeat: "no-repeat"
} as const;

/**
 * Hide the layer unless the browser can actually mask with an image.
 *
 * ⚠ WITHOUT THIS, A BROWSER WITHOUT CSS MASKING SHOWS THE UNMASKED PAINT — a solid gold disc a
 * third wider than the orb, sitting on the chapter. `visibility` rather than `opacity` because
 * framer writes `opacity` inline on these elements every frame and an inline style beats a class;
 * the pattern (a base utility overridden by a `supports-` variant of itself) is the one
 * HeroSection and ParallaxBannerSection already use for `100svh`, and it works because Tailwind
 * emits variant utilities after unvariant ones in the same layer.
 *
 * ⚠ IT TESTS `mask-size`, NOT `mask-image`, AND DELIBERATELY SO. The two shipped in the same
 * release of every engine, so they are the same question — but `mask-size:contain` contains no
 * parentheses, no `/` and no `#`, and Tailwind has to recover this class out of a string literal
 * with a regex. The cheapest way to lose the guard entirely is to write a candidate the extractor
 * declines to extract, and a guard that silently does not compile is worse than no guard: it is the
 * gold disc, shipped.
 *
 * Masking has been Baseline since 2023, so the browsers this excludes are older than the ones that
 * would fail the orb's WebGL probe anyway. They get no mandala, which is the correct degradation
 * for decoration — the chapter reads identically without it.
 */
const MASK_GUARD = "invisible supports-[mask-size:contain]:visible";

/**
 * How far the mandala oversteps the orb's host.
 *
 * `inset` percentages resolve against the containing block — width for left/right, height for
 * top/bottom — and the host is square at both breakpoints (`h-56 w-56`, `sm:h-72 sm:w-72`), so a
 * single value stays concentric. -36% makes the layer 172% of the host: the artwork's outer edge
 * lands about 1.35× the orb's diameter, and its empty middle (the source leaves everything inside
 * 21.6% of the radius blank) sits well inside the orb, so the orb genuinely rises THROUGH the
 * mandala rather than in front of a hole cut for it.
 */
const REACH = "absolute -inset-[36%]";

/**
 * The two coaxial halves of the artwork, selected by where their paint is rather than by cutting
 * the asset in two.
 *
 * ⚠ THE OUTER RINGS HAVE TO LEAVE BEFORE THE CORE, AND THIS IS THE CHEAP WAY TO DO IT. The obvious
 * implementation — one layer, with a radial gradient mask whose reach shrinks — repaints a ~500px
 * square mask on every scrolled frame, and it needs `mask-composite` to combine with the artwork
 * mask, which Chromium and WebKit still spell differently (`intersect` vs `source-in`; I had it
 * silently do nothing in a test page). Instead both layers carry the SAME artwork mask and differ
 * only in the radial gradient they PAINT, so the annulus selection is baked into a background that
 * is rasterised once and thereafter only composited. Their `rotate` and `scale` are the identical
 * MotionValues, which is what keeps the join invisible: if the two halves contracted at different
 * rates the linework would visibly step across the boundary. Only their opacity ramps differ, and
 * the gradients feather across 42–56% so the handover is a gradation rather than a seam.
 *
 * Stops are fractions of the box RADIUS (`closest-side` on a square box). The drawing occupies
 * 21.6%–78.6% of it.
 */
const RING_PAINT =
  "radial-gradient(closest-side, transparent 42%, oklch(0.85 0.11 86 / 0.8) 56%, oklch(0.78 0.135 84 / 0.62) 100%)";
const CORE_PAINT =
  "radial-gradient(closest-side, oklch(0.9 0.08 88 / 0.92) 28%, oklch(0.85 0.11 86 / 0.85) 44%, transparent 58%)";

/**
 * The bloom. Violet, not gold — it is the ORB's light arriving, and it reads as the mandala's gold
 * being replaced rather than merely covered. Same hue as the resting disc AiOrb already draws
 * (oklch 305) so the two never disagree about what colour the intelligence is.
 */
const GLOW_PAINT =
  "radial-gradient(closest-side, oklch(0.56 0.205 305 / 0.5), oklch(0.47 0.198 305 / 0.2) 55%, transparent 78%)";

/**
 * The handover, in one place, as fractions of the host's travel through the viewport.
 *
 * With `["start end", "end start"]` the progress is 0 when the host's top touches the bottom of the
 * window and 1 when its bottom clears the top — about one viewport height plus the host's own 224px
 * (288px from `sm`) of scrolling — and 0.5 is the moment the host is vertically centred. The morph
 * is therefore spent BEFORE the middle and finished around it: by 0.62 the orb is whole and the
 * mandala is all but gone, its core clearing at 0.68. That is the state the reader is in while they
 * read the three paragraphs printed below the orb, since those put the host above the centre line,
 * i.e. past 0.5 — the handover happens on the way IN, not while they are reading.
 */
const MORPH_END = 0.62;

/**
 * Where everything rests when the reader has asked for less motion.
 *
 * ⚠ NO SPIN AND NO MORPH — and specifically NOT "the morph parked at its last frame". Parking at
 * `MORPH_END` would leave the mandala dissolved, i.e. the reader who asked for less motion gets
 * LESS ARTWORK, and what they would be looking at is an animation that has stopped rather than a
 * composition. So the mandala stays, still, quiet and a touch contracted, and the orb sits at its
 * full size and full opacity with a steady bloom. That is the same principle AiOrb's own header
 * states for the shader (contract §1.4): the resting state is the design at rest.
 *
 * It is a still mandala rather than nothing because the ornament is the chapter's subject — craft —
 * and deleting it would leave these readers a bare disc where everyone else gets the argument.
 */
const REST = {
  mandalaRotate: 0,
  mandalaScale: 0.88,
  ringOpacity: 0.1,
  coreOpacity: 0.14,
  glowOpacity: 0.35,
  glowScale: 1,
  orbScale: 1,
  orbOpacity: 1
} as const;

export interface MandalaOrbProps {
  /**
   * The element whose travel through the viewport drives the whole effect — in practice AiOrb's
   * own `hostRef`, which is also this component's parent.
   */
  scrollTarget: RefObject<HTMLElement | null>;
  /** The orb itself. Rendered last, so it paints over the mandala, inside the emergence transform. */
  children?: ReactNode;
}

export function MandalaOrb({ scrollTarget, children }: MandalaOrbProps) {
  const reduce = useReducedMotionPreference();

  const { scrollYProgress } = useScroll({ target: scrollTarget, offset: ["start end", "end start"] });
  /*
   * ONE VALUE, SMOOTHED ONCE. Everything below is a `useTransform` of `flow`, so the mandala's turn
   * and the orb's arrival cannot fall out of step by even a frame — the same reasoning, and the same
   * SPRING_SCROLL, as the reading spine in components/motion/ScrollProgress.tsx.
   *
   * Under reduced motion the spring is bypassed rather than shortened, exactly as it is there.
   * ⚠ That is a statement about what is PAINTED, not about what runs: `useSpring` stays subscribed
   * to `scrollYProgress` either way, because a hook cannot be called conditionally, so the spring
   * goes on integrating whether or not anything reads it. Under reduction nothing does — every
   * `style` below takes its value from REST — and the ternary is kept so that the live branch is
   * the only path that can ever reach the DOM.
   */
  const smoothed = useSpring(scrollYProgress, SPRING_SCROLL);
  const flow = reduce ? scrollYProgress : smoothed;

  /*
   * ⚠ 90° OF TURN IS NOT AN ARBITRARY NUMBER, AND NEITHER WOULD 900° HAVE BEEN. The artwork is
   * 28-fold symmetric, so it maps exactly onto itself every 12.857°: past that first sector no
   * amount of extra rotation is DISTINGUISHABLE from the start, and only the RATE reads. The sweep
   * below is therefore chosen for speed, not for arrival — 180° across roughly one and a half
   * viewport heights is a slow, continuous turn that never resolves into a countable spin. It
   * starts negative so the mandala is already mid-turn when it enters, which is what makes it read
   * as something that was always turning rather than something switched on by the scroll.
   */
  const mandalaRotate = useTransform(flow, [0, 1], [-90, 90]);
  const mandalaScale = useTransform(flow, [0, 0.15, MORPH_END, 1], [1.12, 1.05, 0.46, 0.34]);
  // The outer rings go first — the mandala loses its edge, then its heart.
  const ringOpacity = useTransform(flow, [0, 0.14, 0.4, 0.56], [0, 0.5, 0.16, 0]);
  const coreOpacity = useTransform(flow, [0, 0.14, 0.5, 0.68], [0, 0.6, 0.3, 0]);

  // …and the orb comes up through the gap, on the same clock: whole at MORPH_END, then held.
  const orbScale = useTransform(flow, [0, 0.16, MORPH_END, 1], [0.62, 0.68, 1, 1]);
  const orbOpacity = useTransform(flow, [0, 0.18, 0.58, 1], [0.18, 0.28, 1, 1]);
  const glowOpacity = useTransform(flow, [0, 0.3, MORPH_END, 1], [0, 0.25, 0.85, 0.5]);
  const glowScale = useTransform(flow, [0, MORPH_END, 1], [0.5, 1.05, 1]);

  return (
    <>
      {/*
        Decoration, and marked as such. There is nothing here a screen reader can use: the mandala
        carries no information the surrounding prose does not already carry, and `pointer-events-none`
        keeps a layer 172% of the orb's size from swallowing the microphone button's hit area — it
        overhangs the host in every direction, including downward over the control below.
      */}
      <motion.div
        aria-hidden="true"
        className={cn("pointer-events-none", REACH, MASK_GUARD)}
        style={{
          ...MANDALA_MASK,
          background: RING_PAINT,
          rotate: reduce ? REST.mandalaRotate : mandalaRotate,
          scale: reduce ? REST.mandalaScale : mandalaScale,
          opacity: reduce ? REST.ringOpacity : ringOpacity
        }}
      />
      <motion.div
        aria-hidden="true"
        className={cn("pointer-events-none", REACH, MASK_GUARD)}
        style={{
          ...MANDALA_MASK,
          background: CORE_PAINT,
          rotate: reduce ? REST.mandalaRotate : mandalaRotate,
          scale: reduce ? REST.mandalaScale : mandalaScale,
          opacity: reduce ? REST.coreOpacity : coreOpacity
        }}
      />

      {/* The bloom is deliberately sandwiched — in front of the mandala, behind the orb — so the
          light appears to come from inside the ornament rather than from a lamp set before it. */}
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-[12%] rounded-full"
        style={{
          background: GLOW_PAINT,
          scale: reduce ? REST.glowScale : glowScale,
          opacity: reduce ? REST.glowOpacity : glowOpacity
        }}
      />

      {/*
        The orb, rising. `inset-0` reproduces the host's own box exactly, so the children AiOrb
        passes in keep the absolute positions they were written with (`inset-4` for the resting
        disc, `inset-0` for the shader) and nothing about that file's layout had to change.

        ⚠ NOT `aria-hidden`. Everything above this is ornament; this wrapper carries the orb, and
        the orb's siblings in AiOrb — the microphone button, the state line, the transcript — are
        real semantics that must stay reachable. The wrapper only ever writes a transform and an
        opacity, and both settle at 1.
      */}
      <motion.div
        className="absolute inset-0"
        style={{
          scale: reduce ? REST.orbScale : orbScale,
          opacity: reduce ? REST.orbOpacity : orbOpacity
        }}
      >
        {children}
      </motion.div>
    </>
  );
}
