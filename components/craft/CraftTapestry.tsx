"use client";

/**
 * CraftTapestry — the backdrop of the site, drawn entirely in code.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS. Four Indian craft traditions layered into one ornamental ground: a Bagru block-print
 * field, a Mughal pierced-stone `jaali` with light coming through it, a South Indian threshold
 * `kolam` drawn as a single unbroken line, and natural-dye pigment settling in front of the lot.
 * Each layer documents its own tradition in its own file; read those before changing any of them.
 *
 * THERE IS NO PHOTOGRAPHY HERE AND THERE MUST NEVER BE. Almost every photograph of Indian craft on
 * the open web is somebody's copyright, and shipping one would expose the Centre. Visual richness
 * comes from motifs the Centre's own site DRAWS, plus photographs the Centre uploads itself through
 * the media library.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ONE SCROLL SOURCE, SEVERAL LAYERS. Parallax is a single `useScroll` on this element feeding four
 * `useTransform`s, and each layer moves by a different amount — a `transform` on a handful of
 * wrappers and nothing else. Per-element scroll listeners are what turn a backdrop into a
 * scroll-jank bug report, and per-element springs would let the layers drift out of step by a frame
 * apiece. Only `transform` and `opacity` are ever animated, so the compositor does all of it.
 *
 * The far layers get the LARGEST positive travel: as the page scrolls up, a distant thing should
 * appear to move less, which means moving down relative to the page. The pigment, being nearest,
 * gets a small negative travel and so appears to move slightly faster than the page.
 *
 * REDUCED MOTION: NOTHING MOVES, AND THE STILL FRAME IS THE DESIGN. Every parallax output range
 * collapses to zero, the kolam is already drawn, the pigment is already settled and the jaali's
 * light sits at a composed resting position rather than at the first frame of its travel. That is a
 * deliberate composition and not an animation that has been stopped. Note that the layer wrappers
 * always render with the same structure and start at a zero transform for every reader, so nothing
 * about the FIRST PAINT depends on a preference that only resolves after hydration (contract §8).
 *
 * POINTER. `interactive` adds a slow wash that follows the cursor on the jaali's light and pushes
 * the kolam gently the other way, on `SPRING_POINTER`, the house spring for exactly this. It is
 * refused outright where `pointer: coarse` reports there is no pointer to follow — a touch device
 * has nothing to track and would only pay for the listener.
 *
 * ⚠ AND IT IS A REQUEST RATHER THAN A CAPABILITY, SO A CALLER MAY HAVE GOOD REASON TO WITHHOLD IT.
 * `components/sections/HeroSection.tsx` — the only caller that passes it — now says `false` whenever
 * its particle field is running, because a pointer that drives a warm wash AND this lattice AND a
 * suspended pigment field is three answers to one gesture, and a reader learns "this surface has
 * depth" from the first of them. That is a composition decision belonging to whoever stacks the
 * layers, which is why it is made there and not defended here; it is recorded so that reading this
 * file alone does not leave the impression that `interactive` is on wherever there is a mouse. The
 * SCROLL parallax below is untouched by it and is where this component's own depth actually lives.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `focus` — WHERE THE WORDS ARE, SO THE STONE CAN GET OUT OF THEIR WAY
 *
 * A jaali carried across a whole viewport at even strength stops being architecture and becomes
 * wallpaper: the lattice runs straight through the middle of a sentence, every cell exactly as
 * emphatic as every other, and the reader's eye is given no reason to go anywhere. That is precisely
 * what the hero looked like before this prop existed, and it is what "a flat purple lattice with text
 * on it" means.
 *
 * So a caller may say where its writing sits, and the jaali layer is masked with a hole over it: the
 * screen is at full strength out at the edges of the frame and pierced open where the words are. It
 * is also the architecturally true reading — a jaali is set INTO a wall at the edge of a room, and
 * what falls in the middle of the floor is the light that came through it, not more stone.
 *
 * ⚠ THE MASK IS AN ALPHA MASK, NOT A LUMINANCE ONE. CSS `mask-image` defaults to `alpha`, the
 * opposite of the `<mask>` element inside JaaliScreen, which is luminance (white shows, black hides).
 * Here it is the gradient's OPACITY that decides: opaque black shows the ornament, `transparent`
 * hides it. Writing white stops in this gradient would appear to work in Chromium and hide the whole
 * layer in a browser honouring `mask-mode: luminance` — so the stops are black and it is the alpha
 * that varies.
 *
 * It is an inline style rather than a Tailwind class for two reasons: an arbitrary
 * `[mask-image:radial-gradient(…)]` with commas in it is a fight with the class parser, and Safari
 * still wants the `-webkit-` spelling, which React can only write from a style object.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NOTHING HERE MOVES WHILE IT CANNOT BE SEEN, AND THAT IS NOT AN OPTIMISATION — IT IS THE
 * DIFFERENCE BETWEEN AN ORNAMENT AND A LEAK. This is a backdrop at the top of a long page, so for
 * almost all of a visit it is scrolled away, and two things would otherwise keep running for the life
 * of that visit:
 *
 *   1. A `window` `pointermove` listener setting two springs. Every mouse move ANYWHERE in the
 *      document would wake framer's animation loop and write transforms to two wrappers nobody can
 *      see — a real rAF, running forever, for a decoration that is a thousand pixels above the fold.
 *   2. The layers' own infinite CSS animations — the jaali's travelling light and every pigment grain.
 *      Compositor-only and therefore cheap per frame, but never-ending, and each animating element
 *      holds a promoted layer for as long as it ticks.
 *
 * So one `IntersectionObserver` plus `visibilitychange` decides whether the tapestry is AWAKE, and it
 * gates both — the same two conditions, tracked the same way, as `sections/hero/ParticleField.tsx`
 * uses for its canvas loop. Either reason alone would switch the other back on, so they are combined
 * rather than checked separately. Pausing is phase-preserving: an `alternate` animation resumes from
 * where it stopped, and the springs hold their last value, so coming back into view is never a jump.
 *
 * `awake` starts TRUE, which is what the server renders and what the first client render must
 * therefore agree with (contract §8); the observer only ever corrects it a tick later.
 *
 * ACCESSIBILITY. `aria-hidden` on the whole thing, and `pointer-events-none` so it can never take a
 * press away from the hero's buttons. It carries no information: every one of these layers is
 * ornament, and none of them is the only way any fact reaches the reader.
 *
 * PLACEMENT. It has no size of its own and expects a `relative isolate` parent — the hero already
 * is one, which is what keeps painting order equal to DOM order and means no z-index has to be
 * invented for any of this (contract §6).
 */

import { useEffect, useRef, useState } from "react";
import { motion, useScroll, useSpring, useTransform } from "framer-motion";

import { BlockPrintField } from "@/components/craft/BlockPrintField";
import { JaaliScreen } from "@/components/craft/JaaliScreen";
import { KolamLattice } from "@/components/craft/KolamLattice";
import { PigmentDrift } from "@/components/craft/PigmentDrift";
import { SPRING_POINTER } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

export type CraftLayer = "jaali" | "blockPrint" | "kolam" | "pigment";
export type CraftIntensity = "full" | "quiet";
/**
 * Where the host's writing sits. The three positional values are spelled exactly as the section
 * schema's `alignment` is, so a caller can pass its own alignment straight through without a lookup
 * table that would be one more thing to keep in step.
 */
export type CraftFocus = "none" | "left" | "center" | "right";

const ALL_LAYERS: readonly CraftLayer[] = ["jaali", "blockPrint", "kolam", "pigment"];

/**
 * The hole in the screen, one complete gradient per focus.
 *
 * Read a value as "how much stone survives here": `transparent` at the centre of the words, opaque
 * black out at the frame. The ellipse is deliberately WIDER THAN IT IS TALL (70% × 78% of the box)
 * because a headline, an introduction and two buttons are a tall block, and a circular hole would
 * either clear the words and eat the whole frame or fit the frame and cut through the buttons.
 *
 * The vertical centre is 48% rather than 50%: the hero's content column is optically centred against
 * a section that reserves space for the scroll cue at its foot, so the words sit a little high.
 *
 * The percentages are of THIS COMPONENT'S box, which a caller may well have made taller than its own
 * section so a parallax has room — the hero insets the tapestry 10rem beyond itself at both ends. That
 * stretches the hole vertically by roughly a fifth against the frame the reader is actually looking at,
 * and it does not matter: every stop is a soft ramp over tens of per cent, so a fifth either way moves
 * nothing anybody can see. It would matter for a hard-edged mask, which is a reason not to write one.
 *
 * `none` is the default and produces no mask at all — not a fully-opaque one. A mask that shows
 * everything still promotes the layer and still costs a compositing pass on every frame the jaali's
 * light travels, and "no mask" is the honest way to say that a caller has not asked for one.
 */
const JAALI_MASK: Record<CraftFocus, string | undefined> = {
  none: undefined,
  left: "radial-gradient(70% 78% at 20% 48%, transparent 0%, rgba(0,0,0,0.24) 44%, rgba(0,0,0,0.78) 74%, #000 100%)",
  center:
    "radial-gradient(64% 74% at 50% 48%, transparent 0%, rgba(0,0,0,0.24) 44%, rgba(0,0,0,0.78) 74%, #000 100%)",
  right:
    "radial-gradient(70% 78% at 80% 48%, transparent 0%, rgba(0,0,0,0.24) 44%, rgba(0,0,0,0.78) 74%, #000 100%)"
};

/**
 * How far each layer travels over the whole scroll of its host, in pixels.
 *
 * Far to near, and the sign matters: positive lags the page, negative leads it.
 */
const TRAVEL = {
  jaali: 88,
  blockPrint: 52,
  kolam: 26,
  pigment: -16
} as const;

/**
 * The two settings, as complete literal class strings.
 *
 * Every class here is written out in full because `cn()` is a plain join and Tailwind only sees
 * literals — a class assembled from an intensity name and a number would be purged and the layer
 * would render at full strength (contract §5).
 *
 * The dark variants are not decoration either: an ornament tuned to sit under dark type on a pale
 * canvas disappears entirely once the canvas inverts.
 *
 * ⚠ `jaaliPitch` IS A DENSITY, AND SMALLER IS FINER. JaaliScreen draws into a 480-unit square scaled
 * to COVER its box, so the pitch decides how many cells cross the frame: at 24 a 1440px-wide hero got
 * twenty cells, i.e. 72px hexagrams — closer to garden trellis than to pierced stone, and the single
 * biggest reason the lattice read as wallpaper. 16 gives thirty cells, about 48px, which is roughly
 * the proportion a real screen holds against a doorway. It costs nothing: the `<pattern>` tile carries
 * the same fifty-odd paths whatever the pitch, and the browser rasterises that tile once and repeats
 * it.
 */
const TONE = {
  full: {
    jaali: "opacity-[0.46] dark:opacity-[0.6]",
    blockPrint: "opacity-[0.14] dark:opacity-[0.22]",
    kolam: "opacity-[0.5] dark:opacity-[0.66]",
    pigment: "opacity-[0.7] dark:opacity-[0.85]",
    kolamBox: "bottom-[-10%] right-[-8%] w-[82%] max-w-[46rem] sm:w-[58%] lg:w-[46%]",
    printPitch: 150,
    jaaliPitch: 16,
    grains: 16
  },
  quiet: {
    jaali: "opacity-[0.26] dark:opacity-[0.36]",
    blockPrint: "opacity-[0.08] dark:opacity-[0.13]",
    kolam: "opacity-[0.3] dark:opacity-[0.42]",
    pigment: "opacity-[0.45] dark:opacity-[0.6]",
    kolamBox: "bottom-[-12%] right-[-10%] w-[64%] max-w-[34rem] sm:w-[44%] lg:w-[34%]",
    printPitch: 200,
    jaaliPitch: 22,
    grains: 9
  }
} as const;

export interface CraftTapestryProps {
  /**
   * `full` for a hero, where the tapestry is the point. `quiet` for a page that has work to do
   * over the top of it — same composition, drawn back far enough to read as texture.
   */
  intensity?: CraftIntensity;
  /** Which traditions to show, back to front. Defaults to all four. */
  layers?: readonly CraftLayer[];
  /** Position and clipping. It expects to be given a box — `absolute inset-0` is the usual one. */
  className?: string;
  /** Follow the pointer. Ignored on touch, and under reduced motion. */
  interactive?: boolean;
  /**
   * Where the host's own writing sits, so the jaali can be pierced open over it rather than run
   * straight through the middle of a sentence. See `JAALI_MASK`. `none` masks nothing.
   */
  focus?: CraftFocus;
  /** Same seed, same cloth and same suspension, on every render and every request. */
  seed?: string;
}

export function CraftTapestry({
  intensity = "full",
  layers = ALL_LAYERS,
  className,
  interactive = false,
  focus = "none",
  seed = "cxa"
}: CraftTapestryProps) {
  const reduce = useReducedMotionPreference();
  const hostRef = useRef<HTMLDivElement>(null);
  /** On screen AND in a foreground tab. See the header: this gates every moving thing below. */
  const [awake, setAwake] = useState(true);

  /**
   * 0 while the host's top is at the top of the viewport, 1 once its bottom has passed it. The one
   * scroll source for every layer below, so they cannot fall out of step.
   */
  const { scrollYProgress } = useScroll({
    target: hostRef,
    offset: ["start start", "end start"]
  });

  // The output range collapses to zero under reduction rather than the input being ignored, so the
  // MotionValues stay wired up and there is no second code path to keep in step.
  const jaaliY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : TRAVEL.jaali]);
  const printY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : TRAVEL.blockPrint]);
  const kolamY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : TRAVEL.kolam]);
  const pigmentY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : TRAVEL.pigment]);

  const pointerX = useSpring(0, SPRING_POINTER);
  const pointerY = useSpring(0, SPRING_POINTER);
  const washX = useTransform(pointerX, [-1, 1], [-22, 22]);
  const washY = useTransform(pointerY, [-1, 1], [-14, 14]);
  // Counter to the wash, so the two layers separate under the hand instead of sliding together.
  const kolamX = useTransform(pointerX, [-1, 1], [12, -12]);

  /**
   * Is the tapestry worth animating at all right now?
   *
   * Two independent reasons to stop, tracked separately and combined — either one alone would switch
   * the motion back on while the other still wanted it off. `threshold: 0` because the question is
   * only ever "is any part of this in the viewport", and a backdrop is the whole viewport wide.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let onScreen = true;
    let tabVisible = !document.hidden;
    const sync = () => setAwake(onScreen && tabVisible);

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        onScreen = entry.isIntersecting;
        sync();
      },
      { threshold: 0 }
    );
    observer.observe(host);

    const onVisibilityChange = () => {
      tabVisible = !document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!interactive || reduce) return;
    // Scrolled away, or the tab is in the background. The listener is dropped rather than kept and
    // ignored: an early return inside the handler still pays for the event and still wakes framer.
    if (!awake) return;
    if (typeof window === "undefined") return;
    // No pointer to follow. Attaching the listener anyway would cost a spring per frame of a
    // scroll-driven `pointermove` on some mobile browsers and buy nothing.
    if (window.matchMedia?.("(pointer: coarse)").matches) return;

    const onPointerMove = (event: PointerEvent) => {
      // Normalised across the VIEWPORT rather than this element: the reader moving the cursor over
      // the headline is moving it over this backdrop, and the wash should answer.
      pointerX.set((event.clientX / window.innerWidth) * 2 - 1);
      pointerY.set((event.clientY / window.innerHeight) * 2 - 1);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [interactive, reduce, awake, pointerX, pointerY]);

  const tone = TONE[intensity];
  const jaaliMask = JAALI_MASK[focus];
  const shows = (layer: CraftLayer) => layers.includes(layer);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn("pointer-events-none overflow-hidden", className)}
    >
      {shows("jaali") ? (
        // The mask rides on the SCROLL wrapper rather than on the pointer wrapper inside it, so the
        // hole stays put over the words while the stone drifts under it. It travels the wrapper's own
        // 88px over the whole exit, which against a mask ellipse three-quarters of the frame high is
        // beneath noticing — and the alternative, a mask on the host, would clip the kolam and the
        // pigment as well and cost a compositing pass over four layers instead of one.
        <motion.div
          style={{ y: jaaliY, maskImage: jaaliMask, WebkitMaskImage: jaaliMask }}
          className={cn("absolute inset-0", tone.jaali)}
        >
          {/*
            Inset NEGATIVELY so the pointer wash has room to travel without ever bringing the edge
            of the screen into frame. Two nested wrappers rather than one so the scroll transform
            and the pointer transform never have to be summed into a single style.
          */}
          <motion.div style={{ x: washX, y: washY }} className="absolute inset-[-12%]">
            <JaaliScreen pitch={tone.jaaliPitch} paused={!awake} className="h-full w-full" />
          </motion.div>
        </motion.div>
      ) : null}

      {shows("blockPrint") ? (
        <motion.div style={{ y: printY }} className={cn("absolute inset-[-6%]", tone.blockPrint)}>
          <BlockPrintField pitch={tone.printPitch} seed={seed} className="h-full w-full" />
        </motion.div>
      ) : null}

      {shows("kolam") ? (
        // A kolam is drawn on the ground at a doorway, so it sits low and is cropped by the edge of
        // the frame the way it is cropped by the step. Bottom right keeps it clear of the left-hand
        // column where a hero's headline and buttons live.
        <motion.div
          style={{ y: kolamY }}
          className={cn("absolute", tone.kolamBox, tone.kolam)}
        >
          <motion.div style={{ x: kolamX }}>
            <KolamLattice cols={7} rows={5} className="h-auto w-full text-purple-600" />
          </motion.div>
        </motion.div>
      ) : null}

      {shows("pigment") ? (
        <motion.div style={{ y: pigmentY }} className={cn("absolute inset-0", tone.pigment)}>
          <PigmentDrift
            count={tone.grains}
            seed={seed}
            paused={!awake}
            className="absolute inset-0"
          />
        </motion.div>
      ) : null}
    </div>
  );
}
