"use client";

/**
 * CineLine — a statement whose words rise out of a mask, one after another.
 *
 * The entrance that makes display type feel SET rather than pasted: each word is clipped by its
 * own `overflow-hidden` wrapper and rises into place as the line scrolls into view — the same
 * masked-line reveal the hero's `HeroHeadline` performs with GSAP, rebuilt here with framer
 * because this is an ENTRANCE, and entrances are framer's half of the contract (§8; GSAP's word
 * reveal exists for the `<h1>`'s overlapping timeline, which `staggerChildren` genuinely cannot
 * express — a plain stagger is exactly what it CAN express, so no second GSAP system here).
 *
 * `accent` is a run inside `text` painted with the house gold gradient, matched on word
 * boundaries the way `HeroHeadline` matches its own — the two features should agree about what an
 * accent is. A miss simply renders the line ungilded, never broken.
 *
 * Reduced motion: displacement and stagger collapse to zero, opacity still resolves — the
 * variants speak the exact dialect of variants.ts (opacity 0 in the hidden state of BOTH
 * branches; zeroed interval rather than a shortened one).
 *
 * ⚠ Words are wrapped in `inline-block` spans, so the browser still breaks LINES between words
 * exactly as it would for plain text — nothing here decides line breaks, only word entrances.
 */

import { motion, type Variants } from "framer-motion";
import { createElement, type ReactNode } from "react";

import { EASE_OUT, STAGGER } from "@/components/motion/constants";
import { useReducedMotionPreference } from "@/components/motion/useReducedMotionPreference";
import { cn } from "@/lib/utils";

function parentVariants(reduce: boolean): Variants {
  return {
    hidden: {},
    visible: {
      transition: { staggerChildren: reduce ? 0 : STAGGER.tight, delayChildren: 0 }
    }
  };
}

function wordVariants(reduce: boolean): Variants {
  return {
    hidden: { opacity: 0, y: reduce ? 0 : "112%" },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: reduce ? 0 : 0.62, ease: EASE_OUT }
    }
  };
}

export interface CineLineProps {
  text: string;
  /** A run inside `text` to paint in the gold gradient. Matched on word boundaries. */
  accent?: string;
  /** The rendered element — pick what the outline needs; the motion is identical. */
  as?: "h2" | "h3" | "p";
  className?: string;
}

export function CineLine({ text, accent, as = "p", className }: CineLineProps) {
  const reduce = useReducedMotionPreference();

  const words = text.split(/\s+/).filter(Boolean);
  const accentWords = accent ? accent.split(/\s+/).filter(Boolean) : [];

  // First word-boundary match of the accent run, exactly one, case-sensitive — HeroHeadline's
  // matching rule. -1 (no match) paints nothing gold and harms nothing else.
  let accentStart = -1;
  if (accentWords.length > 0) {
    for (let index = 0; index <= words.length - accentWords.length; index += 1) {
      if (accentWords.every((word, offset) => words[index + offset] === word)) {
        accentStart = index;
        break;
      }
    }
  }

  const children: ReactNode = (
    <>
      {words.map((word, index) => {
        const inAccent =
          accentStart !== -1 && index >= accentStart && index < accentStart + accentWords.length;
        return (
          // `display: contents`: this wrapper exists to carry the key and the between-words space;
          // it must not generate a box of its own or it would become the very inline-block trap
          // the note below describes.
          <span key={`${word}-${index}`} className="contents">
            {/* The mask. `pb-[0.08em]` keeps descenders from being sheared by the clip — the same
                allowance HeroSection's masked lines carry. */}
            <span className="inline-block overflow-hidden pb-[0.08em] align-bottom">
              <motion.span
                data-cine-word=""
                variants={wordVariants(reduce)}
                className={cn("inline-block", inAccent && "text-gold-gradient")}
              >
                {word}
              </motion.span>
            </span>
            {/* ⚠ THE SPACE LIVES BETWEEN THE MASKS, NOT INSIDE ONE. Whitespace trailing inside an
                inline-block does nothing between neighbouring blocks — the first render of this
                component printed every statement as one unbroken word ("CRAFTISMORETHAN…"), which
                a screenshot caught and no static check ever would. A real text node out here is
                what lets the line space, justify and WRAP as ordinary text. */}
            {index < words.length - 1 ? " " : null}
          </span>
        );
      })}
    </>
  );

  return createElement(
    motion[as],
    {
      variants: parentVariants(reduce),
      initial: "hidden",
      whileInView: "visible",
      viewport: { once: true, amount: 0.5 },
      className
    },
    children
  );
}
