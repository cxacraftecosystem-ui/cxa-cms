"use client";

/**
 * CountUp — an animated statistic.
 *
 * The value is a STRING, and that is the whole design. "1,240", "12+", "98%", "₹4.2 crore" and
 * "Ongoing" are all real answers an editor types into a stats block, and a numeric prop would force
 * every one of them through a formatter that has to guess at grouping, units and whether the "+" is
 * part of the number. So the string is authoritative: the leading numeric run is parsed out and
 * animated, everything around it is reprinted untouched, and a value with no number in it renders
 * exactly as typed rather than as an error.
 *
 * THREE PROPERTIES THIS MUST HAVE, AND HOW EACH IS BOUGHT:
 *
 *  1. **The SSR output is the final value.** With JavaScript disabled, or before the observer fires,
 *     the page says 1,240 and not 0 — the number is the content, and a statistic that reads zero
 *     until a script runs is simply wrong. The animation is therefore an imperative overwrite of an
 *     already-correct DOM node, never a React state machine that starts at zero.
 *  2. **No layout shift.** The readout is stacked in a single grid cell with an invisible twin
 *     holding the final string, so the cell is always as wide as the answer and the digits rolling
 *     underneath cannot push the surrounding text about. `tabular-nums` keeps the digits themselves
 *     from jittering.
 *  3. **It starts when it is seen.** An IntersectionObserver rather than framer's `useInView`,
 *     deliberately: `useInView` reports through React state, and the re-render it causes would repaint
 *     the final value one frame before the animation resets it to zero — a visible blink. Nothing
 *     here re-renders at all; the observer writes to the DOM node directly.
 *
 * Under reduced motion the final value is simply printed, immediately and with no animation, which is
 * also what it already says — so the branch is a matter of not starting rather than of undoing.
 *
 * ⚠ Because the readout is mutated imperatively, every exit path restores the final string. React
 * diffs against its own last virtual value, not against the DOM: a later re-render with unchanged
 * children would leave a half-counted "437" on screen forever.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NOTHING A SCREEN READER CAN REACH EVER HOLDS A HALF-COUNTED NUMBER
 *
 * The rolling readout is the ONE element on the site whose text changes sixty times a second, and text
 * is what assistive technology reads. A reader whose virtual cursor lands on this figure during the
 * 0.62s it is counting would be told "437 crafts documented" — a number that was never true, on the
 * screen the Centre uses to say how much it holds. That is the trap contract §8 states as "animate the
 * container, never re-render the text in pieces": the accessible name must not change mid-animation.
 *
 * So the whole visual stack — the width-reserving twin AND the mutating readout — is `aria-hidden`,
 * and the accessible answer is a separate `sr-only` span that is rendered once and never touched. It
 * sits between the prefix and the suffix so the sentence still reads "₹4.2 crore" in order. `sr-only`
 * rather than a second `invisible`: `visibility: hidden` removes an element from the accessibility
 * tree, which is exactly what the twin wants and exactly what this must not have. Being
 * `position: absolute` it also costs no layout, so property 2 above is untouched.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useMemo, useRef } from "react";
import { animate, type AnimationPlaybackControls } from "framer-motion";

import { cn, clamp } from "@/lib/utils";
import { DURATION, EASE_OUT } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";

export interface CountUpProps {
  /** The final answer, formatted exactly as it should read: "1,240", "12+", "₹4.2 crore". */
  value: string;
  /**
   * Seconds. Defaults to the longest duration in the house set — a count that finishes in under a
   * third of a second is not read as counting, it is read as a flicker.
   */
  duration?: number;
  /** Fraction of the element that must be on screen before it starts. */
  amount?: number;
  /** Count once, the first time it is seen. False re-runs it on every entry. */
  once?: boolean;
  className?: string;
}

interface ParsedValue {
  /** Everything before the number: a currency symbol, a "≈". */
  prefix: string;
  /** The numeric run exactly as the editor typed it — the string the readout must land on. */
  numeric: string;
  /** Everything after: "+", "%", " crore". */
  suffix: string;
  target: number;
  decimals: number;
  /** Digit-group sizes read right-to-left, so "1,240" and "1,24,000" both come back correctly. */
  groups: number[];
}

/**
 * Prefix (lazy, so a leading minus belongs to the number rather than to the prefix), then the numeric
 * run — digits with optional comma separators and an optional decimal tail — then everything else.
 * Whitespace is deliberately NOT part of the run: "12 crore" must split as 12 + " crore", not as a
 * space-separated number.
 */
const NUMERIC_RUN = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)([\s\S]*)$/;

export function CountUp({
  value,
  duration = DURATION.words,
  amount = 0.4,
  once = true,
  className
}: CountUpProps) {
  const reduce = useReducedMotionPreference();
  const readoutRef = useRef<HTMLSpanElement>(null);
  const parsed = useMemo(() => parseValue(value), [value]);

  useEffect(() => {
    const readout = readoutRef.current;
    if (!readout || !parsed) return;

    // Already showing the final value from the server render; under reduction that is the end of it.
    if (reduce) return;

    let controls: AnimationPlaybackControls | null = null;
    let started = false;

    const start = () => {
      if (started) return;
      started = true;
      // Written synchronously so the reader never sees the final value blink before the count begins.
      readout.textContent = formatNumber(0, parsed.decimals, parsed.groups);
      controls = animate(0, parsed.target, {
        duration,
        ease: EASE_OUT,
        onUpdate: (latest) => {
          readout.textContent = formatNumber(latest, parsed.decimals, parsed.groups);
        },
        // Lands on the SOURCE string rather than a re-format of the target. Reformatting would let a
        // rounding rule of ours quietly disagree with what the editor typed.
        onComplete: () => {
          readout.textContent = parsed.numeric;
        }
      });
    };

    if (typeof IntersectionObserver !== "function") {
      // No observer (an old browser, a test environment): count immediately rather than never. A
      // statistic that only animates in modern browsers is fine; one that stays at zero is not.
      start();
      return () => {
        controls?.stop();
        readout.textContent = parsed.numeric;
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            start();
            if (once) observer.disconnect();
          } else if (!once) {
            controls?.stop();
            readout.textContent = parsed.numeric;
            started = false;
          }
        }
      },
      { threshold: clamp(amount, 0, 1) }
    );

    observer.observe(readout);

    return () => {
      observer.disconnect();
      controls?.stop();
      readout.textContent = parsed.numeric;
    };
  }, [parsed, reduce, duration, once, amount]);

  if (!parsed) {
    // "Ongoing", "—", "Since 1998" with no run we can animate: a legitimate answer, printed as typed.
    return <span className={className}>{value}</span>;
  }

  return (
    <span className={cn("tabular-nums", className)}>
      {parsed.prefix}
      {/*
        The accessible answer, and the only copy of the number that is in the accessibility tree.
        Rendered once by React and never mutated, so the figure a screen reader announces is the
        finished one whenever it is asked for. See the header.

        ⚠ `select-none`, because `sr-only` clips an element out of sight WITHOUT taking it out of the
        selection: a reader dragging across "1,240" to quote it would otherwise copy "1,2401,240".
        It has no bearing on assistive technology, which reads the accessibility tree and not the
        selection — the visible readout stays the copyable one.
      */}
      <span className="sr-only select-none">{parsed.numeric}</span>
      {/*
        The visual stack, hidden from assistive technology as a whole — both children are the same
        number in different states of being drawn, and neither is the one to read.
      */}
      <span aria-hidden="true" className="inline-grid">
        {/*
          The width reservation. `invisible` is visibility:hidden, so it occupies its box and is not
          selectable — it holds the cell open at the width of the final answer while the shorter
          numbers roll underneath it.
        */}
        <span className="invisible col-start-1 row-start-1">{parsed.numeric}</span>
        <span ref={readoutRef} className="col-start-1 row-start-1">
          {parsed.numeric}
        </span>
      </span>
      {parsed.suffix}
    </span>
  );
}

function parseValue(value: string): ParsedValue | null {
  const match = NUMERIC_RUN.exec(value);
  if (!match) return null;

  const [, prefix = "", numeric = "", suffix = ""] = match;
  const target = Number(numeric.replace(/,/g, ""));
  if (!Number.isFinite(target)) return null;

  const [integer = "", fraction] = numeric.split(".");
  return {
    prefix,
    numeric,
    suffix,
    target,
    decimals: fraction ? fraction.length : 0,
    groups: groupSizesOf(integer)
  };
}

/**
 * The digit-group sizes of a sample integer, read RIGHT to LEFT, ignoring the leading group (which is
 * whatever is left over and says nothing about the convention).
 *
 * "1,240" → [3] (western); "1,24,000" → [3, 2] (Indian lakh/crore grouping). Deriving the pattern
 * from the editor's own string is what lets both conventions live in one field —
 * `Intl.NumberFormat` would need a locale, and the locale of the *reader* is not the locale of the
 * *figure*.
 */
function groupSizesOf(integer: string): number[] {
  const parts = integer.split(",");
  if (parts.length < 2) return [];

  const sizes: number[] = [];
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const part = parts[index];
    if (part && part.length > 0) sizes.push(part.length);
  }
  return sizes;
}

function formatNumber(value: number, decimals: number, groups: number[]): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [integer = "", fraction] = fixed.split(".");
  const grouped = groups.length > 0 ? groupDigits(integer, groups) : integer;
  const sign = value < 0 ? "-" : "";
  return fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

/**
 * Insert separators using the sizes from `groupSizesOf`, repeating the LAST size once the pattern
 * runs out — which is what makes [3, 2] produce 1,00,00,000 and [3] produce 10,000,000.
 */
function groupDigits(digits: string, sizes: number[]): string {
  const parts: string[] = [];
  let rest = digits;
  let index = 0;

  while (rest.length > 0) {
    // `sizes[…]` is `number | undefined` under noUncheckedIndexedAccess even though the index is
    // clamped; the fallback also guards a zero, which would loop forever.
    const size = Math.max(1, sizes[Math.min(index, sizes.length - 1)] ?? 3);
    if (rest.length <= size) {
      parts.unshift(rest);
      break;
    }
    parts.unshift(rest.slice(rest.length - size));
    rest = rest.slice(0, rest.length - size);
    index += 1;
  }

  return parts.join(",");
}
