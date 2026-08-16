"use client";

/**
 * ArcCarousel — the same cards a rail carries, fanned along a circular arc the reader turns by hand.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE GEOMETRY, WHICH IS THE WHOLE TRICK. Every card sits on one large circle whose centre is far
 * BELOW the stage — about a thousand pixels below a thirty-rem box — so the visible top of that
 * circle is a shallow arc across the stage, and a card rotated to its own angle sits tangent to the
 * curve the way a hand of playing cards does. ONE motion value turns the lot: the fan's rotation, in
 * degrees, driven by a drag anywhere on the stage or by the two arrow buttons, which are also the
 * keyboard path. Centre-most card upright and largest; the rest dim and shrink with distance.
 *
 * ⚠ THIS COMPONENT IS DELIBERATELY DUMB. It receives finished `src` strings and finished hrefs and
 * resolves nothing — the section that renders it owns the batched media read, the craft-manifest
 * lookup and (⚠) the licence credit a manifest photograph obliges. A carousel that resolved its own
 * images would be a second copy of `StoryPicture`'s precedence rule, drifting from the first.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHO WRITES `transform` WHERE, because two writers on one element is jitter (contract §8):
 *   • the DRAG layer — framer's drag `x`, cancelled exactly by the layer inside it, so the content
 *     never moves sideways and the drag is pure input;
 *   • the WHEEL (`<ol>`) — framer's `rotate`, the one animated transform in the component;
 *   • each `<li>` — a STATIC inline `rotate(θ) translateY(-R)` computed once from its index;
 *   • the card face inside it — framer's `scale`, derived from the same rotation value.
 * Four elements, one writer each, and no element is ever written to by both a class and a library.
 *
 * REDUCED MOTION: the drag itself still works — it is the reader's own hand, not ambient motion —
 * but nothing springs. The styles bind to the RAW angle rather than the spring-smoothed copy, so a
 * button press or a keyboard focus snaps the fan in zero seconds. Both motion values exist in both
 * branches and both start at zero, so the first paint is identical whatever the preference resolves
 * to after hydration (contract §8: reduction changes durations, never the initial state).
 *
 * ⚠ THE STAGE CLIPS WITH `overflow-hidden`, AND A HIDDEN OVERFLOW IS STILL PROGRAMMATICALLY
 * SCROLLABLE: when a keyboard reader tabs to a card that hangs past the edge, the browser "helpfully"
 * scrolls the clip box to reveal it, which shears the whole geometry sideways and never scrolls
 * back. Two answers, belt and braces: keyboard focus TURNS THE FAN to centre the focused card (the
 * right behaviour anyway), and the stage resets any scroll the browser sneaks in.
 */

import { useRef, type FocusEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import {
  motion,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue
} from "framer-motion";

import { SPRING_SCROLL } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { Button } from "@/components/ui/Button";
import { clamp } from "@/lib/utils";

export interface ArcCarouselItem {
  /** Where the card goes. `""` renders the card as a picture with a caption rather than a link. */
  href: string;
  title: string;
  /** The small line under the title — a place, a date, a material. */
  subtitle?: string;
  /** A finished, servable URL. The section computed it; this component never resolves anything. */
  imageSrc?: string;
  /** `""` is meaningful — it marks the picture decorative (contract §11). */
  imageAlt: string;
}

export interface ArcCarouselProps {
  items: ArcCarouselItem[];
}

/**
 * The circle, in numbers. All in pixels because they are geometry, not theme: they feed inline
 * `transform` strings and a `top` offset, which Tailwind cannot assemble at runtime anyway
 * (contract §5 — no concatenated class names).
 *
 * `STEP_DEGREES` and `RADIUS` together set the spacing: the chord between neighbours is
 * 2·R·sin(θ/2) ≈ 278px against a 256px card, so the cards sit a hand's width apart and never
 * overlap — which is what lets this component avoid inventing a z-order entirely (contract §6).
 */
const RADIUS = 1000;
const STEP_DEGREES = 16;
const CARD_WIDTH = 256;
const CARD_HEIGHT = 420;
/** The circle's centre: below the stage by the radius, so the card at 0° rests 24px from the top. */
const CENTRE_TOP = 24 + CARD_HEIGHT / 2 + RADIUS;
/** How far a finger travels to turn the fan one card. Shorter reads twitchy, longer reads stiff. */
const DRAG_PER_STEP = 180;

export function ArcCarousel({ items }: ArcCarouselProps) {
  // Split from `ArcFan` so this guard sits before any hook rather than between them. The section
  // already states the empty case in words; a bare stage here would draw an empty box with two
  // working buttons — and hand framer inverted drag constraints (left 180, right 0).
  if (items.length === 0) return null;

  return <ArcFan items={items} />;
}

function ArcFan({ items }: ArcCarouselProps) {
  const reduce = useReducedMotionPreference();
  const lastIndex = items.length - 1;

  /**
   * THE one input: the drag layer's x, in pixels. Negative is "later cards". Buttons write to it in
   * card-sized steps, the drag writes to it continuously, and everything visible derives from it —
   * one source of truth, so a drag after a button press continues from where the button left off.
   */
  const dragX = useMotionValue(0);
  /** Cancels the drag layer's travel so the content holds still while the gesture is read. */
  const cancelX = useTransform(dragX, (value) => -value);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * THE PAGE'S OWN SCROLL TURNS THE FAN, and it is the PRIMARY driver now — the drag is a nudge on
   * top of it rather than the only input.
   *
   * Scrolling DOWN carries the fan to the LEFT (later cards come to the centre); scrolling back up
   * carries it right. That is what a reel of objects passing a window does, and it means a reader
   * who never touches the carousel still sees all eight cards instead of the three that happened to
   * fit on the first screen.
   *
   * ⚠ THIS ALSO FIXES THE COMPOSITION, WHICH WAS THE REAL DEFECT. Card 0 sits at 0° — top dead
   * centre — and every later card fans to its RIGHT, so at rest the left half of a 30rem stage was
   * empty page while the right-hand cards ran under the `overflow-hidden` edge and were clipped
   * mid-title. Measured on the live site: the first card began near x=580 of 1440 and only three of
   * eight were visible. Binding the span to the section's transit means the fan is only one-sided
   * at the very start and very end of that transit — when the section is half off-screen anyway —
   * and is balanced for the whole of the time the reader is actually looking at it.
   *
   * The offset spans the full deck: card 0 centred as the section enters, the middle card at
   * mid-transit, the last card as it leaves.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const stageRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: stageRef,
    // "the stage's top reaches the bottom of the window" → "its bottom reaches the top".
    offset: ["start end", "end start"]
  });
  const scrollX = useTransform(scrollYProgress, [0, 1], [0, -lastIndex * DRAG_PER_STEP]);

  /**
   * Drag and scroll, added.
   *
   * ⚠ UNDER REDUCED MOTION THE SCROLL TERM IS DROPPED ENTIRELY — a fan that turns because the page
   * moved is precisely the scroll-coupled motion that preference asks not to happen, and the buttons
   * and drag still reach every card without it. The hook still runs so the hook order never changes
   * between renders (the same rule the spring below already follows).
   */
  const totalX = useTransform([dragX, scrollX] as MotionValue<number>[], (values: number[]) =>
    reduce ? (values[0] ?? 0) : (values[0] ?? 0) + (values[1] ?? 0)
  );

  /** Pixels → degrees. Unclamped on purpose: the elastic overdrag at either end should turn the
   *  fan a little past the last card and be pulled back, not hit a wall while the finger keeps going. */
  const angle = useTransform(totalX, (value) => (value / DRAG_PER_STEP) * STEP_DEGREES);
  /**
   * The smoothing. `SPRING_SCROLL` is the house spring for exactly this — a value the reader is
   * already driving with their own hand, lagged just enough to look liquid (contract §8). Under
   * reduction the styles bind to `angle` directly and every change lands in zero seconds; the spring
   * still exists so the hook order never changes and the first render is identical either way.
   */
  const smoothed = useSpring(angle, SPRING_SCROLL);
  const rotation = reduce ? angle : smoothed;

  /**
   * Which card the fan is nearest to right now, from the COMBINED input rather than the spring —
   * `totalX`, not `dragX`, or the buttons would count from a position the reader can no longer see
   * once the page has scrolled.
   */
  const nearestIndex = () => clamp(Math.round(-totalX.get() / DRAG_PER_STEP), 0, lastIndex);

  const turnTo = (index: number) => {
    // Stop first: a set() during the drag's momentum animation would be overwritten a frame later.
    dragX.stop();
    // ⚠ SOLVED FOR THE DRAG TERM, because the scroll term is not ours to move: the reader's scroll
    // position owns it. Landing card `index` at the centre means `drag + scroll = -index·step`, so
    // the drag has to absorb whatever the scroll currently contributes. Without this subtraction a
    // button press part-way down the section jumps to the wrong card by however far the page has
    // scrolled.
    const scrollTerm = reduce ? 0 : scrollX.get();
    dragX.set(-clamp(index, 0, lastIndex) * DRAG_PER_STEP - scrollTerm);
  };

  /**
   * TRUE from the moment a real drag starts until the click it spawns has been swallowed. Releasing
   * a drag over a card fires that card's native `click`, and a reader who dragged the fan half a
   * turn did not ask to navigate. Cleared on the next fresh press rather than on drag end, because
   * a drag released outside the window never produces the click that would have cleared it.
   */
  const dragging = useRef(false);

  return (
    <div>
      {/*
        The stage. `h-[30rem]` is the whole arc drawing: tall enough for the centred card plus the
        drop of its neighbours down the curve, and everything past the curve is clipped here.
      */}
      <div
        ref={stageRef}
        className="relative h-[30rem] overflow-hidden"
        onScroll={(event) => {
          // The browser scrolled the clip box to reveal a focused card — undo it; the focus
          // handler below has already turned the fan to do the same job without breaking geometry.
          event.currentTarget.scrollTo(0, 0);
        }}
      >
        <motion.div
          drag="x"
          // ⚠ SYMMETRIC AND DELIBERATELY SMALLER THAN THE DECK, because the drag no longer has to
          // reach every card on its own — the scroll term does that. Left at the old
          // `{ left: -lastIndex·step, right: 0 }` the two inputs would ADD to nearly twice the deck,
          // spinning the fan a full turn past the last card at the foot of the section. A ±2-card
          // nudge is enough to look at a neighbour without leaving where the page has put you, and
          // `turnTo` writes outside these bounds freely — constraints govern the gesture, not `set`.
          dragConstraints={
            reduce
              ? { left: -lastIndex * DRAG_PER_STEP, right: 0 }
              : { left: -2 * DRAG_PER_STEP, right: 2 * DRAG_PER_STEP }
          }
          // Overdrag is a spring-back animation the reader did not perform, so reduction turns the
          // give off entirely along with the momentum — the fan simply stops at either end.
          dragElastic={reduce ? 0 : 0.4}
          dragMomentum={!reduce}
          style={{ x: dragX }}
          onPointerDown={() => {
            dragging.current = false;
          }}
          onDragStart={() => {
            dragging.current = true;
          }}
          onClickCapture={(event) => {
            if (dragging.current) {
              event.preventDefault();
              event.stopPropagation();
              dragging.current = false;
            }
          }}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
        >
          {/* The exact inverse of the drag travel, so the cards never slide — they only turn. */}
          <motion.div style={{ x: cancelX }} className="absolute inset-0">
            {/*
              THE WHEEL: a zero-size point at the circle's centre, far below the stage, and the one
              element framer rotates. `<ol>` because the fan is ordered left to right exactly as the
              editor ordered it; `role="list"` restores what `list-none` strips from Safari.
            */}
            <motion.ol
              role="list"
              style={{ top: CENTRE_TOP, rotate: rotation }}
              className="absolute left-1/2 h-0 w-0 list-none"
            >
              {items.map((item, index) => (
                <ArcCard
                  // Index-keyed deliberately — the same reasoning as the rail's cards: no id in the
                  // payload, reordered only by an editor rewriting the array.
                  key={index}
                  item={item}
                  index={index}
                  rotation={rotation}
                  onCentre={turnTo}
                />
              ))}
            </motion.ol>
          </motion.div>
        </motion.div>
      </div>

      {/*
        The buttons are the keyboard path and the discoverable path — a drag surface announces
        nothing. They step one card and clamp at the ends rather than disabling: a `disabled` that
        arrives while the button is focused drops the reader's focus to `<body>` (see Button's own
        header), which is a worse failure than a press that has nothing left to do.
      */}
      <div className="mt-6 flex justify-center gap-3">
        <Button
          variant="ghost"
          icon={ArrowLeft}
          aria-label="Turn the carousel left"
          onClick={() => turnTo(nearestIndex() - 1)}
        />
        <Button
          variant="ghost"
          icon={ArrowRight}
          aria-label="Turn the carousel right"
          onClick={() => turnTo(nearestIndex() + 1)}
        />
      </div>
    </div>
  );
}

/**
 * One card on the arc.
 *
 * The `<li>` is pure geometry: its static transform lifts it from the circle's centre up to the arc
 * and tilts it tangent, and framer never touches it. The face inside is what framer scales and dims,
 * both derived from the fan's rotation — so the emphasis follows the turn with no state, no
 * "selected index" to fall out of step, and nothing to reconcile on release.
 */
function ArcCard({
  item,
  index,
  rotation,
  onCentre
}: {
  item: ArcCarouselItem;
  index: number;
  rotation: MotionValue<number>;
  onCentre: (index: number) => void;
}) {
  /** Degrees between this card and the stage's centre line, always positive. */
  const offset = useTransform(rotation, (value) => Math.abs(value + index * STEP_DEGREES));
  // Upright and largest at the centre, ordinary size one step out; the dimming keeps easing off to
  // 0.75 across three steps so the fan reads as receding rather than switched.
  const scale = useTransform(offset, [0, STEP_DEGREES], [1.06, 1]);
  const opacity = useTransform(offset, [0, STEP_DEGREES * 3], [1, 0.75]);

  const linked = Boolean(item.href && item.title);

  const face = (
    <>
      {item.imageSrc ? (
        /*
          `next/image` in `fill` mode, same as `MediaImage`: this repo routes every stored picture
          through the optimiser (eslint enforces it — the derivative pipeline and the CDN cache keys
          assume it is in the path), and the one thing `fill` needs, a `sizes` hint, this card can
          state exactly because its box is fixed by the geometry above. The frame reserves the space,
          so nothing shifts when the bytes arrive.
        */
        <span className="relative block aspect-[4/5] w-full">
          {/* `pointer-events-none`: an `<img>` is natively draggable, and a native image drag
              starting mid-gesture steals the pointer from the fan. Clicks pass to the link. */}
          <Image
            src={item.imageSrc}
            alt={item.imageAlt}
            fill
            sizes="16rem"
            className="pointer-events-none object-cover"
          />
        </span>
      ) : (
        // Stated rather than blank — an editor who can see the hole can fill it (contract §1.6).
        <div className="flex aspect-[4/5] w-full items-center justify-center bg-surface-100 p-6">
          <p className="text-center text-xs text-ink-500">No photograph has been chosen for this card.</p>
        </div>
      )}
      <span className="block px-4 pb-4 pt-3">
        {/*
          A real `<h3>`, exactly as the rail's cards carry — the section renders its own heading (or
          an `sr-only` fallback) partly so these do not hang off the `<h1>` with a level missing, and
          that reasoning has to hold in both drawings (contract §11). Valid inside the card's link:
          an anchor's content model is transparent, and its parent here accepts flow content.
        */}
        <h3 className="display-title truncate text-base leading-snug">{item.title}</h3>
        {item.subtitle ? (
          <p className="mt-1 truncate text-xs font-medium uppercase tracking-[0.14em] text-ink-500">
            {item.subtitle}
          </p>
        ) : null}
      </span>
    </>
  );

  return (
    <li
      className="absolute"
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        left: -CARD_WIDTH / 2,
        top: -CARD_HEIGHT / 2,
        // Right to left: lift the card from the circle's centre up to the arc, then swing it to its
        // slot — the rotation happens about the centre, so the card arrives tangent to the curve.
        transform: `rotate(${index * STEP_DEGREES}deg) translateY(${-RADIUS}px)`
      }}
    >
      <motion.div
        style={{ scale, opacity }}
        // Themed tokens throughout: this stage sits on the light half of the page but must survive
        // the dark theme too, so the card ground is `bg-card` and never a literal white.
        className="h-full overflow-hidden rounded-2xl bg-card ring-1 ring-line-200"
      >
        {linked ? (
          <CardLink href={item.href} onCentre={() => onCentre(index)}>
            {face}
          </CardLink>
        ) : (
          <span className="block h-full">{face}</span>
        )}
      </motion.div>
    </li>
  );
}

/**
 * The card's link, in two concrete branches: `next/link` on an internal path, a plain `<a>` on
 * anything else — the same split, for the same reasons, as this section's rail cards and LinkButton
 * (routing a `mailto:` or another origin through the client router adds prefetch machinery and a
 * surprise). The focus handler turns the fan on KEYBOARD focus only: a card that swings away
 * between mousedown and mouseup swallows its own click, so pointer focus must leave it be.
 */
function CardLink({
  href,
  onCentre,
  children
}: {
  href: string;
  onCentre: () => void;
  children: ReactNode;
}) {
  const className = "block h-full focus-visible:rounded-2xl";
  const onFocus = (event: FocusEvent<HTMLAnchorElement>) => {
    if (event.currentTarget.matches(":focus-visible")) onCentre();
  };

  if (href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) {
    return (
      // `draggable={false}` on both branches: an anchor is natively draggable, and a native link
      // drag starting mid-gesture steals the pointer from the fan's own drag.
      <Link href={href} className={className} onFocus={onFocus} draggable={false}>
        {children}
      </Link>
    );
  }

  return (
    <a href={href} className={className} onFocus={onFocus} draggable={false}>
      {children}
    </a>
  );
}
