"use client";

/**
 * HeroHeadline — the page's `<h1>`, revealed one word at a time, with the accent phrase in gold.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY GSAP OWNS EXACTLY THIS AND NOTHING ELSE
 *
 * Each word must start moving WHILE THE PREVIOUS ONE IS STILL MOVING. framer's `staggerChildren` is
 * a fixed delay BETWEEN siblings, so a word can only begin once the previous delay has elapsed; the
 * overlap this headline needs is an offset measured from a sibling's START, which is a timeline
 * primitive. That is the whole of GSAP's remit in this product (contract §8), and it is loaded by a
 * dynamic `import("gsap")` so ~70 KB does not sit in the bundle of every other page.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THERE IS NO RULE UNDER THE ACCENT ANY MORE, AND ITS ABSENCE IS THE DESIGN RATHER THAN A LOSS.
 *
 * What stood here was an "embroidered thread": a per-word SVG stroke on a hand-drawn wandering path,
 * `pathLength`-normalised so `stroke-dasharray: 100` was one full pass whatever the word, drawn by a
 * CSS transition on `stroke-dashoffset` that one piece of React state flipped when the GSAP timeline
 * reported completion. It was careful work and it was wrong for the sentence it ended up under.
 *
 * It was designed for a two- or three-word accent, where a single stitch pulled through the words
 * reads as embroidery. The Centre's live headline accents the WHOLE SECOND CLAUSE — "for unified
 * AI-enabled craft ecosystem platform", seven words and most of the line — so the thread was no
 * longer a mark under a phrase, it was a rule under half the heading. At that length a horizontal
 * line beneath coloured words in a heading is read as one thing and one thing only, which is a
 * hyperlink; and a hyperlink that cannot be clicked is worse than no ornament at all. The gold
 * gradient already says which words are the accent, in a heading nobody can mistake for body copy.
 *
 * WHAT WENT WITH IT, so nobody hunts for the other half: the `threadDrawn` state and the boolean
 * hand-off from `onComplete`, the `useId()` gradient id stem (each word needed its own `url(#…)`),
 * the `HOUSE_CURVE` literal that the transition rode, the per-word `accentIndex` that staggered the
 * draw, the `relative` that every word carried so the SVG had a box to position against, and the
 * two `[data-hero-thread]` rules that kept it visible where nothing runs — one in the `<noscript>`
 * block at the foot of this file, one in the print stylesheet in app/globals.css, both of which had
 * to say `stroke-dashoffset` because the thread was held back by an inline dash offset rather than by
 * opacity. Nothing else consumed any of it. The GSAP reveal, the gold, the once-only dataset flag and
 * the `<noscript>` rescue are untouched.
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

import { Fragment, useEffect, useRef } from "react";

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
}

/**
 * How long after a word STARTS the next one starts — the overlap, and the whole reason GSAP is here.
 *
 * `DURATION.words` (0.62s) is longer than this, which is what makes the tweens overlap rather than
 * queue: at 0.28s each word is a little under halfway through its own travel when the next one
 * leaves. A figure at or past the duration would produce a plain stagger, which framer could express
 * — and this file would then have no reason to exist.
 *
 * It is deliberately NOT in constants.ts: that file's `STAGGER` map is `staggerChildren` intervals,
 * a delay BETWEEN siblings, and this is an offset measured from a sibling's START. There is no framer
 * animation that could ever use it, so it has no place in the shared vocabulary — it belongs to the
 * one timeline that can express it.
 *
 * ⚠ IT USED TO HAVE A SECOND CONSUMER and the comment here was mostly about keeping the two in step:
 * the thread under each accented word took the same figure as its `transition-delay`, so that one
 * stitch appeared to be pulled through several words. With the thread gone this is a single number
 * with a single reader, which is why the coupling note that stood here has gone with it rather than
 * being left to describe a mechanism that is no longer there.
 */
const WORD_OVERLAP_SECONDS = 0.28;

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
 * more slowly and settles later. It is stated here as the brand curve rather than as whichever GSAP
 * default reads acceptably, because this is the one animation on the site a first-time visitor is
 * guaranteed to watch from its first frame.
 */
const HOUSE_EASE = "expo.out";

export function HeroHeadline({ headline, accent, className }: HeroHeadlineProps) {
  const reduce = useReducedMotionPreference();
  const headingRef = useRef<HTMLHeadingElement>(null);

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
    // sentence.
    //
    // ⚠ BOTH TESTS, AND THEY ARE NOT THE SAME TEST. `reduce` is the mount-gated hook and is what
    // answers a reader who flips the toggle later — it must stay in the dependency list for that. But
    // it reports `false` for the first render BY DESIGN (contract §8: the value must not change what
    // is in the prerendered HTML), and the first render is the one whose effect starts the download.
    // Without the synchronous read, every reader who asked for less motion still fetches GSAP —
    // above the fold, on the homepage, against the hero photograph's own bytes — to then not use it.
    if (reduce || prefersLessMotionNow()) {
      settle();
      return;
    }

    // The flag is set by `onComplete`, not on start, so a run that was killed part-way (React's
    // development double-mount, or the reader toggling the motion preference mid-reveal) can still
    // play — while a headline somebody has already watched arrive never plays twice.
    if (heading.dataset.heroWordsPlayed === "true") {
      settle();
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
            // never an offset measured from a sibling's start.
            index === 0 ? 0 : `<${WORD_OVERLAP_SECONDS}`
          );
        });
        timeline = created;
      })
      .catch(() => {
        // The chunk did not arrive. This is the most important sentence on the site; show it, because
        // it is not decoration.
        if (cancelled) return;
        settle();
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
            {/*
              `inline-block` is what gives GSAP a box to translate: an inline `<span>` cannot be
              transformed at all. It is also why the space below is outside this element.
            */}
            <span
              data-hero-word
              className={cn("inline-block opacity-0", word.accent && "text-gold-gradient")}
            >
              {word.text}
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
        The one reader the shared `opacity: 0` initial state would fail. It costs four lines and it is
        the difference between a headline and an empty screen.

        DELIBERATELY WITHOUT `!important`. This rule and Tailwind's `.opacity-0` have identical
        specificity, so the later one in source order wins and this element is later — but GSAP
        writes the opacity INLINE, and an inline style beats any stylesheet rule that is not
        `!important`. So the reveal is untouched wherever JavaScript runs, and this only ever takes
        effect where nothing is going to animate at all.
      */}
      <noscript>
        <style>{"[data-hero-word]{opacity:1}"}</style>
      </noscript>
    </Fragment>
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

  const push = (chunk: string, isAccent: boolean) => {
    for (const word of chunk.split(/\s+/)) {
      if (word.length === 0) continue;
      words.push({ text: word, accent: isAccent });
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
