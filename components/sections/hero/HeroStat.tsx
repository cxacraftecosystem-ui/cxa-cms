/**
 * HeroStat — one live figure at the foot of the hero: "1,240 crafts documented".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A ZERO PRINTS NOTHING AT ALL, AND THAT IS THE MOST IMPORTANT LINE IN THIS FILE.
 *
 * On a new installation every count is zero. "0 crafts documented" under the Centre's headline is
 * worse than silence: it is an advertisement that there is nothing here, on the one screen that is
 * meant to say the opposite. So a figure of zero — or one that is not a real number, because the
 * caller's count could not be read — renders `null` and the row simply has one fewer entry, or none.
 *
 * This is NOT the truncation rule in reverse (contract §1.6). That rule is about a list that quietly
 * stops part-way, where the reader cannot tell a shortened list from the whole corpus. A figure of
 * zero is not a shortened anything; it is a fact about an empty archive, and the honest place to say
 * it is the archive's own page, which states its emptiness properly.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FIGURE DOES NOT COUNT UP. THAT IS A DECISION, NOT AN OMISSION — DO NOT PUT IT BACK.
 *
 * Until now the number was wrapped in `components/motion/CountUp.tsx` and rolled from zero when the row
 * came into view. `.audit/MOTION-AUDIT.md` (framer-entrances, `[medium/overwhelming]` on HeroSection)
 * asked for it to come out, and its reason is the one worth keeping in the file: every other animation
 * in this hero is applied to `aria-hidden` DECORATION — the per-word headline timeline, the gold thread,
 * the pigment field, the chevron's five-pixel drift. The count was the only one applied to a FACT, on
 * the one screen the Centre uses to say how much it holds, and a statistic is more authoritative
 * standing still. It was also the third motion arriving on this one row, which already rises on
 * `riseItem` with its hairline appearing alongside it.
 *
 * Three things follow rather than being arranged, and together they are worth more than the animation:
 *
 *  1. **The accessibility tree now holds exactly one copy of the number, and it is the visible one.**
 *     `CountUp` mutates its readout imperatively sixty times a second, so it has to keep a separate
 *     `sr-only` span as the answer and hide the rolling stack behind `aria-hidden` (its own header
 *     explains this at length; it is a real fix for a real defect). Nothing here changes after paint, so
 *     none of that apparatus is needed: the figure a screen reader is handed is the figure on screen,
 *     and five spans per figure become one text node.
 *  2. **Nothing in this component moves**, so contract §1.4 — a signal that exists only as motion is a
 *     signal a reduced-motion reader never receives — is met by construction rather than by a branch.
 *     The row's entrance belongs to the caller and is already stood down there by `riseItem(reduce)`.
 *  3. **No observer and no animation clock per figure.** A hero with four figures was four
 *     `IntersectionObserver`s and four framer `animate()` calls, all of them competing for the frame in
 *     which the headline timeline and the particle field are doing their work.
 *
 * The figure was ALREADY correct without JavaScript — `CountUp`'s SSR output is the finished value by
 * design, never a zero a script counts up from — so nothing about correctness is bought here. What is
 * bought is quiet. The value below is still rendered on the server and is still the whole answer.
 *
 * ⚠ This is NOT a verdict on `CountUp`. `components/sections/StatsSection.tsx` and
 * `app/(site)/about/page.tsx` both count deliberately and both should keep doing it: a stats block is a
 * section the reader has scrolled to and is looking at, which is precisely what an entrance animation is
 * for. The hero is the surface that is already doing five other things the moment it arrives. So the cut
 * belongs to this CALLER and not to the layer, and nothing in `components/motion/` was touched.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO `"use client"`, and now nothing beneath it asks for one either. This component holds no state, no
 * handlers and no client children, so it is a Server Component wherever it is dropped — a bespoke page
 * that wants one figure without the whole hero pays nothing for the privilege. (Its only caller today,
 * `HeroSection`, is itself `"use client"` for framer's sake, so in practice this renders inside that
 * boundary. The point is that it does not require one.)
 *
 * It is drawn for a DARK GROUND only. Every hero backdrop now sits on `purple-950`, so the colours
 * here are the white ladder rather than the themed `ink-*` one; dropping this on a light panel would
 * render white type on white.
 */

import { cn } from "@/lib/utils";

/** One figure, as a caller supplies it. */
export interface HeroFigure {
  /** The count itself. Zero, negative and non-finite all render nothing — see the header. */
  value: number;
  /** What it counts, in the words a reader would use: "crafts documented", "research projects". */
  label: string;
}

/**
 * `HeroFigure` plus the one thing the ROW decides rather than the caller's data.
 *
 * ⚠ DELIBERATELY NOT EXPORTED, and the asymmetry with `HeroFigure` above is the point. `HeroFigure` is
 * exported because it is a DATA shape that callers build and pass along — `HeroSection` imports it as
 * `{ HeroStat, type HeroFigure }` and types its own `figures` array with it. This interface is only the
 * argument list of the function below, and nothing on this site imports it; a props type exported "in
 * case" is a public surface with no reader, which is the defect class this repo keeps finding (a symbol
 * that is complete, correct and reached by nothing). Export it the moment something outside this file
 * genuinely wraps `HeroStat` — and not before.
 */
interface HeroStatProps extends HeroFigure {
  /** Alignment within the row (`items-center`, `items-end`) and nothing else. */
  className?: string;
}

export function HeroStat({ value, label, className }: HeroStatProps) {
  // `Math.round` first, so 0.4 — which a caller could get from an average rather than a count — is
  // treated as the zero it would print as, and not as a figure worth showing.
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  if (rounded <= 0) return null;

  const words = label.trim();

  return (
    <div className={cn("flex flex-col", className)}>
      {/*
        A tick above the figure: it says "another one of these starts here", which is what makes two or
        three figures read as a row of measurements rather than as loose numbers. `aria-hidden` because
        it is a mark and not a word — the same shape `StatsSection` draws over its own figures, so a
        reader meeting both surfaces meets one vocabulary.

        This used to be described as "the static half of the signal", against the count that supplied the
        moving half. Nothing here moves any more (see the header), so the hairline is not standing in for
        an animation a reduced-motion reader was spared — it is simply part of the drawing, and every
        reader gets the identical thing.

        Gold rather than purple because purple-700 is invisible against purple-950 — and this is the
        hero, the one surface where gold is allowed (contract §1.1).
      */}
      <span aria-hidden="true" className="block h-px w-8 bg-gold-500/60" />

      {/*
        `.display-title` sets `text-ink-900`, which is dark type in the light theme. A utility always
        beats a `@layer components` recipe regardless of the order in the class string, so plain
        `text-white` is enough here and no `!` is needed (contract §5).

        The scale was `text-2xl sm:text-3xl` — 24px rising to 30px, which is smaller than the hero's own
        introduction and therefore reads as a footnote to it rather than as the figures an institution
        is showing off. A figure an institution quotes about itself is a display number: it is set at
        display size, in the display face.

        `tabular-nums` OUTLIVED THE COUNT, on a different argument. It was here so a rolling readout
        could not change the width of the row as it climbed; there is no readout any more, and it stays
        because a row of figures is a set of numbers to be COMPARED, which is the same reason
        `globals.css` gives tables `tabular-nums lining-nums` and running prose proportional digits. Two
        or three of these sit side by side under one hairline each, and Plus Jakarta Sans draws a narrow
        "1": with proportional figures "1,240" and "18" set to different rhythms and the row looks
        mis-measured rather than tabulated. It is not decorative and it is not a no-op, and the evidence
        for that is stated exactly as strong as it actually is: `tnum` and `pnum` appear in the
        DECOMPRESSED OpenType table bytes of `fonts/jakarta-latin-var.woff2` (whose table directory does
        include GSUB and GPOS), found by inflating the woff2 and searching those bytes for the tags —
        NOT by walking the GSUB FeatureList, so it is strong evidence that the face carries the feature
        rather than a proof that it is wired to a lookup. The probe does discriminate: the same run
        reports `liga` for Jakarta and no `liga` for Inter. `app/layout.tsx:91` points `--font-jakarta`
        at that exact file, so the probed font is the served font. And `.display-title`
        (`globals.css:346` — `font-display font-bold tracking-tight text-ink-900`) sets no
        `font-variant-numeric` of its own, so this class is the only thing on the element asking for it.
      */}
      <p className="display-title mt-4 text-3xl leading-none tabular-nums text-white sm:text-4xl">
        {groupIndian(rounded)}
      </p>

      {/*
        Capitals at 13px, tracked open, because that is what the rest of the site's labels do
        (`.eyebrow`, the craft record's region line) and a figure's caption is a label rather than a
        sentence. `white/70` and not the `white/60` this used to carry: 60% white over `purple-950`
        composites to roughly 4.4:1, which is under the 4.5:1 that text this size owes (WCAG 1.4.3),
        and 70% clears it at about 5.9:1.
      */}
      {words ? (
        <p className="mt-2 text-[0.8125rem] font-medium uppercase leading-snug tracking-[0.12em] text-white/70">
          {words}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Indian digit convention: the last three digits, then pairs. 1,240 · 12,40,000 · 1,00,00,000.
 *
 * Hand-written rather than `Intl.NumberFormat("en-IN")` on purpose, and this reasoning is untouched by
 * the count coming out. `HeroSection` is a client component, so this string is produced on the SERVER
 * and produced again when that tree hydrates; a Node build without the full ICU data groups `en-IN` the
 * American way, so the two renders would disagree about the one number the hero is showing off — a
 * hydration mismatch rather than a cosmetic difference. The principle behind it is the one
 * `components/motion/CountUp.tsx` states for its own grouping: the locale of the READER is not the
 * locale of the FIGURE.
 *
 * ⚠ Not `toLocaleString` with an explicit `"en-IN"` either, for exactly the same reason — the locale
 * argument is a request, and a runtime with no data for it silently falls back.
 */
function groupIndian(value: number): string {
  const digits = String(value);
  if (digits.length <= 3) return digits;
  const tail = digits.slice(-3);
  // Every position with an even number of digits still to its right, and not the very start.
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${tail}`;
}
