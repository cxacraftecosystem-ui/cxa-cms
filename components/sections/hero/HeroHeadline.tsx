"use client";

/**
 * HeroHeadline — the page's `<h1>`, revealed one word at a time, with an embroidered gold thread
 * drawn under the accent phrase once the words have landed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY GSAP OWNS EXACTLY THIS AND NOTHING ELSE
 *
 * Each word must start moving WHILE THE PREVIOUS ONE IS STILL MOVING. framer's `staggerChildren` is
 * a fixed delay BETWEEN siblings, so a word can only begin once the previous delay has elapsed; the
 * overlap this headline needs is an offset measured from a sibling's START, which is a timeline
 * primitive. That is the whole of GSAP's remit in this product (contract §8), and it is loaded by a
 * dynamic `import("gsap")` so ~70 KB does not sit in the bundle of every other page.
 *
 * THE THREAD BELOW IS NOT A SECOND GSAP ANIMATION — deliberately. Two libraries writing the same
 * element is a class of bug with no good ending, so the thread is a plain CSS transition on
 * `stroke-dashoffset`, flipped by one piece of React state when the timeline reports completion. It
 * also means the global reduced-motion rule in globals.css reaches it without a JS branch, and that
 * a reader who has asked for less motion simply finds the thread already drawn.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE SPLIT HAPPENS IN JSX, ONCE, ON THE SERVER — not by walking text nodes in an effect. Three
 * reasons: the gold accent is a `<span>` inside the headline and an imperative splitter would have to
 * reassemble it; a server-rendered split means the words exist for a crawler and for a reader whose
 * JavaScript never arrives; and a split that runs in an effect would run twice under React's
 * development double-mount. The dataset flag below is what makes the REVEAL run once even so.
 *
 * ⚠ THE TRAILING SPACE AFTER EACH WORD IS A TEXT NODE OUTSIDE THE SPAN. Inside an `inline-block` the
 * line stops breaking, the headline copies to the clipboard as one run-on string, and inside a
 * `.text-gold-gradient` span the space paints as a visible gap in the gradient.
 *
 * The words start at `opacity: 0` for EVERY reader, exactly as `components/motion/Reveal` does. On a
 * prerendered page an `initial` that differs between the server and the hydrated client is a flash,
 * so reduced motion changes what happens NEXT (the words are simply shown, with no timeline) and
 * never what is in the HTML (contract §8). `opacity: 0` text is still in the accessibility tree and
 * still selectable; the `<noscript>` rule at the foot covers the one reader that treatment fails.
 */

import { Fragment, useEffect, useId, useRef, useState } from "react";

import { DURATION } from "@/components/motion/constants";
import { prefersLessMotionNow } from "@/components/motion/gsap/runtime";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

export interface HeroHeadlineProps {
  /** The whole line, as the editor typed it. Whitespace only renders nothing at all — see below. */
  headline: string;
  /**
   * The run inside `headline` to paint in `.text-gold-gradient`, matched CASE-SENSITIVELY and only
   * on word boundaries. A miss renders the headline plainly rather than appending the accent to it.
   */
  accent: string;
  /** The type scale, the colour and any top margin. The heading has no size of its own. */
  className?: string;
}

interface HeadlineWord {
  text: string;
  /** Rendered in `.text-gold-gradient` — the one place gold is allowed (contract §1.1). */
  accent: boolean;
  /** Position within the accent run, or -1. Drives the thread's per-word head start. */
  accentIndex: number;
}

/**
 * How long after a word STARTS the next one starts — the overlap, and the whole reason GSAP is here.
 *
 * ⚠ ONE CONSTANT BECAUSE TWO THINGS ARE REQUIRED TO BE IDENTICAL. It is the offset in the timeline's
 * `"<…"` position AND the per-word delay on the thread beneath, and the only thing that makes a
 * two-word accent read as ONE thread pulled through both words is that those two figures agree. They
 * were previously written out separately, coupled by a comment claiming they matched — which is a
 * claim, not a mechanism, and the kind that survives exactly until somebody tunes one of them.
 *
 * It is deliberately NOT in constants.ts: that file's `STAGGER` map is `staggerChildren` intervals,
 * a delay BETWEEN siblings, and this is an offset measured from a sibling's START. There is no framer
 * animation that could ever use it, so it has no place in the shared vocabulary — it belongs to the
 * one timeline that can express it. `DURATION.words` (0.62s) is longer than this, which is what makes
 * the tweens overlap rather than queue.
 */
const WORD_OVERLAP_SECONDS = 0.28;

/** The thread draws for as long as a word travels, from the house set rather than chosen. */
const THREAD_DRAW_SECONDS = DURATION.words;

/**
 * The house curve, in GSAP's own vocabulary.
 *
 * `EASE_OUT` in constants.ts is `cubic-bezier(0.16, 1, 0.3, 1)`, which is the standard cubic
 * approximation of an EXPONENTIAL ease-out; `expo.out` is that same curve stated exactly rather than
 * approximated. GSAP core cannot be handed a raw cubic-bezier at all — that is `CustomEase`, a
 * separate module and more bytes for a curve GSAP already has a name for — so this is how the token
 * is reached from here.
 *
 * ⚠ IT WAS `power3.out`, WHICH IS A DIFFERENT CURVE. That is a CUBIC ease-out: it leaves the mark
 * more slowly and settles later. The thread drawn under these very words transitions on `HOUSE_CURVE`
 * below, so the two halves of a single hand-off were travelling on two different curves — the exact
 * drift the note on `HOUSE_CURVE` exists to prevent, arriving through GSAP's easing names instead of
 * through the CSS keyword.
 */
const HOUSE_EASE = "expo.out";

/**
 * The house expo curve, written out.
 *
 * ⚠ The keyword `ease-out` inside handwritten CSS is the CSS SPEC curve, which is a different and
 * much lazier curve spelled identically to the brand token (contract §4). This literal is the same
 * cubic as `EASE_OUT` in components/motion/constants.ts and as the `ease-out` Tailwind class.
 */
const HOUSE_CURVE = "cubic-bezier(0.16, 1, 0.3, 1)";

/**
 * The stitch, in a 100 × 8 user-space box that is then stretched to the width of its word.
 *
 * `pathLength="100"` normalises the path's own length to 100 so `stroke-dasharray: 100` is exactly
 * one full pass whatever the word is — no measuring, no `getTotalLength()`, no effect.
 *
 * There is deliberately NO `vector-effect="non-scaling-stroke"`. The box is stretched non-uniformly
 * (wide and very short), and combining that effect with `stroke-dasharray` is the one part of SVG
 * where browsers genuinely disagree. Without it the stroke is scaled by the box, which for a
 * near-horizontal path means its thickness follows the VERTICAL scale only — 8 user units mapped to
 * 0.2em — so the thread is a constant fraction of the type size at every viewport, which is what a
 * typographic rule should be anyway.
 */
const THREAD_PATH = "M0 4.4 C 13 1.8, 27 6.4, 41 3.6 S 69 1.1, 83 4.8 S 95 6.1, 100 3.8";

export function HeroHeadline({ headline, accent, className }: HeroHeadlineProps) {
  const reduce = useReducedMotionPreference();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [threadDrawn, setThreadDrawn] = useState(false);

  /**
   * A DOM-safe id stem for the per-word gradients.
   *
   * `useId()` is stable across the server and client renders, which is what an SVG `url(#…)`
   * reference needs, but React's own format contains punctuation. Stripping it to letters and digits
   * keeps the reference unambiguous in every browser without inventing a counter that two heroes on
   * one page would collide on.
   */
  const idStem = `hero-thread-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

  const words = headlineWords(headline, accent);

  useEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;

    const nodes = Array.from(heading.querySelectorAll<HTMLElement>("[data-hero-word]"));
    if (nodes.length === 0) return;

    /** The words, present and upright, with any half-finished tween cleared off them. */
    const settle = () => {
      for (const node of nodes) {
        node.style.removeProperty("transform");
        node.style.opacity = "1";
      }
    };

    // Reduced motion: no split animation, no timeline, no 70 KB of animation library. Just the
    // sentence, and a thread that is already drawn rather than one that draws itself.
    //
    // ⚠ BOTH TESTS, AND THEY ARE NOT THE SAME TEST. `reduce` is the mount-gated hook and is what
    // answers a reader who flips the toggle later — it must stay in the dependency list for that. But
    // it reports `false` for the first render BY DESIGN (contract §8: the value must not change what
    // is in the prerendered HTML), and the first render is the one whose effect starts the download.
    // Without the synchronous read, every reader who asked for less motion still fetches GSAP —
    // above the fold, on the homepage, against the hero photograph's own bytes — to then not use it.
    if (reduce || prefersLessMotionNow()) {
      settle();
      setThreadDrawn(true);
      return;
    }

    // The flag is set by `onComplete`, not on start, so a run that was killed part-way (React's
    // development double-mount, or the reader toggling the motion preference mid-reveal) can still
    // play — while a headline somebody has already watched arrive never plays twice.
    if (heading.dataset.heroWordsPlayed === "true") {
      settle();
      setThreadDrawn(true);
      return;
    }

    let cancelled = false;
    let timeline: { kill: () => void } | null = null;

    void import("gsap")
      .then(({ gsap }) => {
        if (cancelled) return;
        const created = gsap.timeline({
          defaults: { ease: HOUSE_EASE, duration: DURATION.words },
          onComplete: () => {
            heading.dataset.heroWordsPlayed = "true";
            // The one hand-off between the two systems, and it is a single boolean rather than a
            // shared property: GSAP finishes with the words, React starts the thread, and neither
            // ever writes what the other owns.
            if (!cancelled) setThreadDrawn(true);
          }
        });
        nodes.forEach((node, index) => {
          created.fromTo(
            node,
            { yPercent: 108, opacity: 0, rotate: 1.5 },
            { yPercent: 0, opacity: 1, rotate: 0 },
            // The overlap, and the whole reason GSAP is here. `"<0.28"` is 0.28s AFTER THE START of
            // the previous tween — which lasts 0.62s, so each word begins while the one before it is
            // still travelling. framer's `staggerChildren` can only express a delay between siblings,
            // never an offset measured from a sibling's start. The figure is shared with the thread's
            // per-word delay and is stated once, above.
            index === 0 ? 0 : `<${WORD_OVERLAP_SECONDS}`
          );
        });
        timeline = created;
      })
      .catch(() => {
        // The chunk did not arrive. This is the most important sentence on the site; show it, and
        // show the thread under it, because neither is decoration.
        if (cancelled) return;
        settle();
        setThreadDrawn(true);
      });

    return () => {
      cancelled = true;
      timeline?.kill();
    };
  }, [reduce, headline, accent]);

  // Whitespace, or nothing at all. Rendering an empty `<h1>` would put a rung in the document
  // outline with no words in it, which a screen-reader user meets as a blank entry in the list of
  // headings they navigate by. `sectionsOwnPageTitle` in SectionRenderer.tsx answers the same
  // question with `headline.trim()`, and the two agree by construction: a headline with any
  // non-space character produces at least one word here.
  if (words.length === 0) return null;

  return (
    <Fragment>
      <h1 ref={headingRef} className={className}>
        {words.map((word, index) => (
          <Fragment key={`${index}-${word.text}`}>
            <span
              data-hero-word
              // `relative` on every word, not only the accented ones: the thread is positioned
              // against its own word's box, and a uniform class string is one fewer thing that can
              // differ between two renders.
              className={cn("relative inline-block opacity-0", word.accent && "text-gold-gradient")}
            >
              {word.text}
              {word.accent ? (
                <Thread
                  gradientId={`${idStem}-${word.accentIndex}`}
                  order={word.accentIndex}
                  drawn={threadDrawn}
                />
              ) : null}
            </span>
            {/*
              OUTSIDE the span, deliberately. A space inside an `inline-block` word stops the line
              breaking, and a space inside a `.text-gold-gradient` span paints as a visible gap in
              the gradient.
            */}{" "}
          </Fragment>
        ))}
      </h1>

      {/*
        The one reader the shared `opacity: 0` initial state and the undrawn thread would both fail.
        It costs four lines and it is the difference between a headline and an empty screen.

        DELIBERATELY WITHOUT `!important`. These rules and Tailwind's `.opacity-0` have identical
        specificity, so the later one in source order wins and this element is later — but GSAP
        writes the opacity INLINE, and React writes the dash offset inline, and an inline style beats
        any stylesheet rule that is not `!important`. So the reveal is untouched wherever JavaScript
        runs, and this only ever takes effect where nothing is going to animate at all.
      */}
      <noscript>
        <style>{"[data-hero-word]{opacity:1}[data-hero-thread]{stroke-dashoffset:0}"}</style>
      </noscript>
    </Fragment>
  );
}

interface ThreadProps {
  gradientId: string;
  /** Which word of the accent run this is. 0 draws first; the rest follow at one head start each. */
  order: number;
  drawn: boolean;
}

/**
 * One word's length of gold thread.
 *
 * An SVG rather than a `border-bottom` because the line is meant to read as embroidery: it wanders a
 * little off true, it is drawn rather than switched on, and it catches light along its length. A
 * border can do none of those things.
 *
 * Absolutely positioned against the word, so it adds nothing to the inline layout and cannot change
 * where the line breaks. `overflow-visible` because the stroke's round cap and the path's upper
 * curve both sit slightly outside the 100 × 8 box.
 */
function Thread({ gradientId, order, drawn }: ThreadProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 8"
      // The box is stretched to the word rather than fitted to it: a thread that kept the path's own
      // proportions would be a short mark in the middle of a long word.
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 -bottom-[0.06em] h-[0.2em] w-full overflow-visible"
    >
      <defs>
        {/*
          Gold-200 → gold-500 → gold-300, the same three rungs `--grad-gold` uses. A thread lit from
          one side reads as thread; a flat stroke reads as an underline.
        */}
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="oklch(0.9 0.08 88)" />
          <stop offset="45%" stopColor="oklch(0.7 0.145 80)" />
          <stop offset="100%" stopColor="oklch(0.85 0.11 86)" />
        </linearGradient>
      </defs>
      <path
        data-hero-thread
        d={THREAD_PATH}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={1.6}
        strokeLinecap="round"
        pathLength={100}
        style={{
          strokeDasharray: 100,
          strokeDashoffset: drawn ? 0 : 100,
          // ONE PASS, NOT A LOOP. A transition can only run once per change of state, which is the
          // cheapest possible way to guarantee that. The global reduced-motion rule in globals.css
          // zeroes both the duration and the delay with `!important`, and an important declaration
          // in a stylesheet beats a normal inline one — so a reader who asked for less motion finds
          // the thread already there without this file branching on the preference at all.
          transitionProperty: "stroke-dashoffset",
          transitionDuration: `${THREAD_DRAW_SECONDS}s`,
          transitionTimingFunction: HOUSE_CURVE,
          transitionDelay: `${order * WORD_OVERLAP_SECONDS}s`
        }}
      />
    </svg>
  );
}

/**
 * The headline, as words, with the accent run marked.
 *
 * The accent is matched CASE-SENSITIVELY and only on word boundaries. A match inside a word
 * ("cell" within "Excellence") would be split into its own word span and the surrounding letters
 * into others, so the headline would render with spaces inside a word — worse than no gold at all.
 * A miss of any kind renders the headline plainly rather than appending the accent to it.
 */
function headlineWords(headline: string, accent: string): HeadlineWord[] {
  const words: HeadlineWord[] = [];
  let accentSeen = 0;

  const push = (chunk: string, isAccent: boolean) => {
    for (const word of chunk.split(/\s+/)) {
      if (word.length === 0) continue;
      words.push({
        text: word,
        accent: isAccent,
        accentIndex: isAccent ? accentSeen++ : -1
      });
    }
  };

  const index = accent.length > 0 ? headline.indexOf(accent) : -1;
  if (index < 0) {
    push(headline, false);
    return words;
  }

  // `charAt` past either end returns "", which is why the fallbacks are a space: the start and the
  // end of the string are both word boundaries.
  const before = index > 0 ? headline.charAt(index - 1) : " ";
  const after = headline.charAt(index + accent.length) || " ";
  if (!/\s/.test(before) || !/\s/.test(after)) {
    push(headline, false);
    return words;
  }

  push(headline.slice(0, index), false);
  push(accent, true);
  push(headline.slice(index + accent.length), false);
  return words;
}
