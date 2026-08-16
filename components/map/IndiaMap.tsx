"use client";

/**
 * The Centre's map of India — the outline, and a pin per craft region.
 *
 * PORTED from the Field Repository's map (the owner's own product; its module headers travel with
 * their files — indiaGeometry.ts carries the provenance argument for the OFFICIAL Government of
 * India depiction and must never be swapped for a Western dataset). This edition is the NATION
 * level only: the landing page asks "where is the work?", not "which district?", so the state and
 * district border fetches were left behind with the level toggle — the outline IS the national
 * border, inlined, with no loading state to get wrong.
 *
 * IT IS A GRAPHIC, AND IT IS MARKED AS ONE. The whole `<svg>` is `aria-hidden` and holds nothing
 * focusable — an SVG full of tabbable circles is "button, button, button" with nothing to compare.
 * Everything the picture says is said again by `MapPlaceList` beside it, a real list with real
 * counts and real links; a keyboard or screen-reader user gets the better interface of the two.
 *
 * NO MAPPING LIBRARY. maplibre already earns its quarter-megabyte in the craft explorer's real
 * basemap; here the whole geometry is 18 KiB of string and one `<path>`. Nothing re-renders on a
 * pointer move except the hover card.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PINS BLOOM AS THE READER REACHES THEM, and two things about that are decisions rather than
 * defaults.
 *
 * The stagger is POSITIONAL. framer's `staggerChildren` releases children in DOM order, and this
 * map's DOM order is by RADIUS — `layoutPins` sorts biggest-last so a large pin can never hide a
 * small one it was drawn before — so a child stagger would sweep the map from the busiest place to
 * the quietest, which is no visible order at all. Each pin's delay is instead derived from where it
 * IS, and the marks arrive as a wave spreading outward across the country. See `bloomDelays`.
 *
 * It REVERSES: `viewport.once` is false, so scrolling back up puts the pins away again. That is the
 * opposite of `Reveal`'s default and the opposite for a reason — a reveal is a page section, which
 * should stay revealed once seen, whereas this is one picture whose entire content is the marks.
 * Coming back to it and watching the country fill again is the picture drawing itself, which is worth
 * more here than it would cost on a page of text.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { memo, useId, useMemo } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";

import { layoutPins, type MapPoint, type PlacedPin } from "@/components/map/layout";
import { MapHoverCard } from "@/components/map/MapHoverCard";
import { indiaOutlinePath, unitsPerKilometre, VIEW_BOX } from "@/components/map/projection";
import { DURATION, EASE_OUT, SPRING_PRESS, STAGGER } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

export type { MapPoint } from "@/components/map/layout";

export interface IndiaMapProps {
  points: MapPoint[];
  selectedKey?: string | null;
  hoveredKey?: string | null;
  onSelect?: (key: string) => void;
  onHover?: (key: string | null) => void;
  className?: string;
}

/**
 * How long the whole bloom takes, from the first pin to the last, in seconds.
 *
 * ⚠ A CONSTANT, NOT `interval × pin count`, and that is the one thing a positional stagger must get
 * right where `staggerChildren` gets it for free. This map draws whatever the archive holds — eight
 * pins today, forty once the corpus is loaded — and a per-item interval would leave the last pin of a
 * forty-pin map arriving two seconds after the first, long after the reader has moved on. A sweep
 * across a picture belongs to the picture: `STAGGER.cards` is the house interval for six to nine
 * items, and the wave reads as about that many rings whatever the count.
 */
const BLOOM = STAGGER.cards * 8;

/**
 * When each pin pops, keyed by point.
 *
 * The wave spreads from the CENTRE OF GRAVITY OF THE PINS THEMSELVES rather than from the middle of
 * the viewBox: the middle of the viewBox is a spot in central India that may hold nothing, while the
 * mean of the placed pins is where the archive actually is, so the bloom starts on the work and runs
 * out to the coasts. Normalised by the furthest pin, so the wave always takes exactly `BLOOM` however
 * spread out the corpus is.
 *
 * Deterministic, like `layoutPins` above it: same points in, same delays out, so nothing re-times
 * between renders.
 */
function bloomDelays(pins: readonly PlacedPin[]): Map<string, number> {
  const delays = new Map<string, number>();
  if (pins.length === 0) return delays;

  const centreX = pins.reduce((sum, pin) => sum + pin.x, 0) / pins.length;
  const centreY = pins.reduce((sum, pin) => sum + pin.y, 0) / pins.length;

  let furthest = 0;
  for (const pin of pins) {
    furthest = Math.max(furthest, Math.hypot(pin.x - centreX, pin.y - centreY));
  }

  for (const pin of pins) {
    // A single pin, or several on one coordinate, is the whole map at distance zero — no wave to
    // spread and nothing to divide by.
    const share = furthest === 0 ? 0 : Math.hypot(pin.x - centreX, pin.y - centreY) / furthest;
    delays.set(pin.point.key, share * BLOOM);
  }
  return delays;
}

/**
 * The pop, as a dynamic variant: `custom` is the pin's delay in seconds.
 *
 * ⚠ IT LIVES HERE RATHER THAN IN components/motion/variants.ts, WHICH IS NOT A LICENCE TO INVENT
 * MOTION. Every number in it comes from constants.ts; what the shared vocabulary cannot express is
 * the delay, because a variant factory there takes `reduce` and a distance and knows nothing about
 * where a mark sits on a map. `SPRING_PRESS` is the springiest thing the house set holds: its damping
 * ratio is 30 / (2√(380 × 0.7)) ≈ 0.92, against 0.93 for ISLAND, 0.99 for TOAST and over 1 — no
 * overshoot at all — for the other four.
 *
 * ⚠ THAT IS NOT A VISIBLE BOUNCE, AND NOBODY SHOULD WRITE THAT IT IS. At ζ = 0.92 the analytic
 * overshoot is exp(−πζ/√(1−ζ²)) ≈ 0.0006 — six hundredths of one per cent of a 0.7 step, four
 * ten-thousandths of a scale unit, which is not a thing an eye can see. What makes a small mark read
 * as POPPING rather than swelling is the delta and the speed: 0.3 → 1 at ωₙ ≈ 23 rad/s lands in about
 * 190 ms (4/ζωₙ) and stops dead. A pin that genuinely passed 1 and came back would need a constant
 * under ζ ≈ 0.9, and constants.ts deliberately holds none — SPRING_ISLAND's own line is "arrives
 * without a visible bounce". Inventing one HERE is the thing this comment exists to prevent.
 *
 * Under reduction the scale collapses to 1 and the transition to zero, exactly as `scaleIn` does:
 * the pin is simply there. `opacity: 0` stays in BOTH branches of `hidden`, because the preference
 * resolves after hydration and an `initial` that differs between the server and the client is a
 * flash (useReducedMotionPreference.ts). The delay is zeroed WITH the duration — a zero-duration
 * animation that still waits its turn is a staggered pop, which is louder than the bloom it replaced.
 *
 * ⚠ `hidden` CARRIES A TRANSITION TOO, WHICH IT WOULD NOT NEED ANYWHERE ELSE. `viewport.once` is
 * false, so this variant is not only the initial state — it is played, every time the reader scrolls
 * back past the map. Left bare it would leave for ever on framer's own default (a 0.3 s opacity tween
 * and an untuned spring on the scale), which is house motion nobody chose and, for a reader who asked
 * for none, motion after the promise above said there would be none. Entry and exit are now the same
 * spring and the same zero.
 */
function pinPop(reduce: boolean): Variants {
  return {
    hidden: {
      opacity: 0,
      scale: reduce ? 1 : 0.3,
      transition: reduce ? { duration: 0 } : SPRING_PRESS
    },
    visible: (delay: number) => ({
      opacity: 1,
      scale: 1,
      transition: reduce ? { duration: 0 } : { ...SPRING_PRESS, delay }
    })
  };
}

/**
 * The leader lines, which arrive LAST — after the wave has passed, on a plain fade.
 *
 * They exist to tie a displaced pin back to its true coordinate, and a hairline drawn to a pin that
 * has not appeared yet is a line to nowhere. Waiting out the bloom also means the reader watches the
 * marks land first and reads the corrections second, which is the order the information matters in.
 */
function leaderFade(reduce: boolean): Variants {
  return {
    hidden: {
      opacity: 0,
      // Played on the way out as well (see `pinPop`), and ⚠ WITHOUT `visible`'s `delay`. That wait
      // is there so a hairline is never drawn to a pin that has not arrived; carried into the exit it
      // would instead hold the lines on screen for `BLOOM` seconds after the pins they explain had
      // gone — leaders to nowhere, which is the exact failure the delay was added to prevent.
      transition: reduce ? { duration: 0 } : { duration: DURATION.scrim, ease: EASE_OUT }
    },
    visible: {
      opacity: 1,
      transition: reduce
        ? { duration: 0 }
        : { duration: DURATION.page, ease: EASE_OUT, delay: BLOOM }
    }
  };
}

/** Built once from a path string that is itself built once — this never has a reason to re-render. */
const Coastline = memo(function Coastline() {
  return (
    <path
      d={indiaOutlinePath()}
      fillRule="evenodd"
      className="fill-purple-100/60 stroke-purple-300 dark:fill-purple-950/40"
      // A hairline stroke is what makes Lakshadweep visible: those islands are genuinely under a
      // pixel at this scale, and a fill alone would render the territory as nothing at all.
      strokeWidth={1.6}
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
});

export function IndiaMap({
  points,
  selectedKey = null,
  hoveredKey = null,
  onSelect,
  onHover,
  className = ""
}: IndiaMapProps) {
  const reduce = useReducedMotionPreference();
  const pins = useMemo(() => layoutPins(points, unitsPerKilometre()), [points]);
  const active = pins.find((pin) => pin.point.key === (hoveredKey ?? selectedKey)) ?? null;
  const delays = useMemo(() => bloomDelays(pins), [pins]);

  /**
   * THE SHARED NAME FOR A PLACE across the picture and the list beside it: `MapPlaceList` numbers
   * its rows 1..N in the callers' order and the hover card prints the same number, so "the third
   * one" means one thing in both views. Derived from `points`, not `pins` — the collision pass may
   * reorder while it nudges.
   */
  const ordinals = useMemo(
    () => new Map(points.map((point, index) => [point.key, index + 1])),
    [points]
  );

  // One id per mounted map, kept for parity with the source (a second map on a page must not
  // share defs with the first).
  useId();

  return (
    /*
     * The wrapper exists for the hover card, which is HTML and cannot live inside the svg. It is the
     * card's positioning context and its measuring stick — the svg is `h-auto w-full`, so this box is
     * exactly the picture's box and a percentage of it is a percentage of the viewBox.
     *
     * ⚠ NEVER GIVE IT AN `overflow`. The card is deliberately allowed to hang past the picture's
     * edges; a clipping container here would cut it off at exactly the pins nearest the coasts.
     */
    <div className={cn("relative", className)}>
      <motion.svg
        viewBox={`0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`}
        className="h-auto w-full max-w-full"
        role="presentation"
        aria-hidden="true"
        focusable="false"
        /*
         * The svg animates NOTHING itself — it is here only to be the variant parent. A motion
         * component whose `initial` is a variant LABEL becomes a variant node, so these two words
         * propagate to every child that declares `variants`, and one IntersectionObserver serves
         * forty pins instead of forty observers serving one each.
         *
         * ⚠ `amount: 0.4` IS BOUNDED FROM BOTH SIDES, which is why it is a number and not a default.
         *
         * From above by framer's viewport observer: this value is handed straight to an
         * IntersectionObserver as its threshold, and a threshold higher than
         * `viewportHeight / elementHeight` can never be met — the trap Reveal.tsx's
         * `useAchievableAmount` exists to close, and the failure is not a late entrance but a country
         * that stays empty for ever. This picture is about 1.1 times as tall as it is wide, so on the
         * shortest laptop the map column still shows about four fifths of itself and 0.4 is
         * comfortable; anything near 1 would not be.
         *
         * From below by the `Reveal` this section sits inside, which fades the whole block up at 0.3
         * of ITS box. Two observers watching two different boxes cannot be made to fire together, but
         * a much lower number here spends the entire bloom behind a wrapper still at `opacity: 0` —
         * the reader scrolls to a map whose pins have already landed. Close to the wrapper's own
         * threshold, the wave lands AS the section arrives.
         */
        initial="hidden"
        whileInView="visible"
        viewport={{ once: false, amount: 0.4 }}
      >
        <Coastline />

        {/* Leader lines tie a displaced pin back to where the place really is — Bagru and Sanganer
            are 25 km apart, eight pixels at this scale, and two towns are two towns. */}
        <motion.g variants={leaderFade(reduce)} data-reveal="">
          {pins
            .filter((pin) => pin.displaced)
            .map((pin) => (
              <g key={`leader-${pin.point.key}`}>
                <line
                  x1={pin.anchorX}
                  y1={pin.anchorY}
                  x2={pin.x}
                  y2={pin.y}
                  className="stroke-purple-400"
                  strokeWidth={1.2}
                />
                <circle cx={pin.anchorX} cy={pin.anchorY} r={2} className="fill-purple-500" />
              </g>
            ))}
        </motion.g>

        {pins.map((pin) => (
          <Pin
            key={pin.point.key}
            pin={pin}
            isActive={pin.point.key === selectedKey || pin.point.key === hoveredKey}
            delay={delays.get(pin.point.key) ?? 0}
            reduce={reduce}
            onSelect={onSelect}
            onHover={onHover}
          />
        ))}

        <ScaleBar />
      </motion.svg>

      {/* Keyed by place, so moving from one pin to another swaps one card for another rather than
          animating a single card across the country — which at this scale reads as a bug. */}
      <AnimatePresence>
        {active ? (
          <MapHoverCard
            key={active.point.key}
            pin={active}
            ordinal={ordinals.get(active.point.key)}
            reduce={reduce}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * One mark.
 *
 * ⚠ TWO GROUPS, AND THE SPLIT IS THE WHOLE TRICK. The outer group carries the pin's POSITION as an
 * SVG `transform` attribute and never animates; the inner one carries the SCALE as an inline style
 * and never moves. Keeping them apart buys three things that are each awkward to get any other way:
 *
 *   • The pin's contents are drawn at the origin of their own coordinate system, so the scale has the
 *     pin's centre as its origin no matter how framer resolves `transform-origin` for SVG. (In this
 *     version it writes `transform-box: fill-box` and `50% 50%`, which lands in the same place — but
 *     that is an implementation detail of the library and this does not depend on it.)
 *   • `data-reveal` can sit on the inner group. The `<noscript>` rescue that a `Reveal` ships is
 *     `[data-reveal]{opacity:1!important;transform:none!important}`, and ⚠ `transform: none` beats a
 *     transform ATTRIBUTE as well as a style — on the outer group it would flatten every pin onto the
 *     top-left corner of the map. On the inner one it clears the scale and nothing else, which is
 *     exactly the rescue a reader with no JavaScript needs.
 *   • The position is written once, as markup, and is never rewritten again. Were both on one
 *     element, every frame of the pop would have to re-emit the translate alongside the scale, and
 *     the pin's TRUE COORDINATE — the thing `layoutPins` spent sixty passes deciding — would live
 *     inside a string an animation library owns.
 *
 * The pointer handlers are on the INNER group, so the hit area grows with the mark: a pin that has
 * not arrived yet has no area, and cannot open a card for a place the reader cannot see.
 */
function Pin({
  pin,
  isActive,
  delay,
  reduce,
  onSelect,
  onHover
}: {
  pin: PlacedPin;
  isActive: boolean;
  /** Seconds to wait after the map enters view. From `bloomDelays`. */
  delay: number;
  reduce: boolean;
  onSelect?: (key: string) => void;
  onHover?: (key: string | null) => void;
}) {
  const { point, x, y, radius } = pin;

  return (
    <g transform={`translate(${x} ${y})`}>
      <motion.g
        data-reveal=""
        variants={pinPop(reduce)}
        // Resolved against THIS element's own variant, which is why the delay can differ per pin
        // while every pin shares one parent and one observer.
        custom={delay}
        // Pointer-only, deliberately: focusable content inside an aria-hidden subtree is unreachable
        // by AT but still in the tab order — the worst of both. The list beside the map is the
        // keyboard path, and focusing a row lights this pin and opens its card.
        className="cursor-pointer"
        onClick={() => onSelect?.(point.key)}
        onPointerEnter={() => onHover?.(point.key)}
        onPointerLeave={() => onHover?.(null)}
      >
        {/* An invisible target a little larger than the mark, so a small pin is not a small hit area.
            Centred on the origin like everything else here — see the header. */}
        <circle r={radius + 8} fill="transparent" />

        <circle
          r={radius}
          className={`fill-purple-700 stroke-white ${isActive ? "opacity-100" : "opacity-90"}`}
          strokeWidth={2}
        />

        {/* The count belongs ON the pin, on EVERY pin — it is what stops a place holding nine crafts
            reading exactly like a place holding one. Size follows the digits so "12" fits and "1"
            does not rattle. */}
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={radius * (point.total >= 100 ? 0.72 : point.total >= 10 ? 0.9 : 1.05)}
          className="pointer-events-none fill-white font-display font-bold"
        >
          {point.total}
        </text>
      </motion.g>
    </g>
  );
}

/** Without one, nobody can tell whether two pins are 20 km apart or 200. */
function ScaleBar() {
  const kilometres = 500;
  const length = kilometres * unitsPerKilometre();
  const x = 26;
  const y = VIEW_BOX.height - 34;
  return (
    <g className="pointer-events-none">
      <line x1={x} y1={y} x2={x + length} y2={y} className="stroke-ink-500" strokeWidth={2} />
      <line x1={x} y1={y - 5} x2={x} y2={y + 5} className="stroke-ink-500" strokeWidth={2} />
      <line
        x1={x + length}
        y1={y - 5}
        x2={x + length}
        y2={y + 5}
        className="stroke-ink-500"
        strokeWidth={2}
      />
      <text x={x} y={y + 22} className="fill-ink-500 font-sans text-[15px]">
        {kilometres} km
      </text>
    </g>
  );
}
