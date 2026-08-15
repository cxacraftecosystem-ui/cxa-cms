/**
 * StatsSection — the row of headline figures.
 *
 * A Server Component. `CountUp` is the only client piece and it is mounted per figure, so a block
 * with the count-up turned off ships no JavaScript at all.
 *
 * ⚠ `value` IS A STRING AND IS NEVER COERCED. "1,240", "12+", "3 of 5" and "₹4.2 cr" are all real
 * answers an administrator has given; a number would force every one of them into a lie or into a
 * separate suffix field the animation would then have to reassemble. `CountUp` parses the leading
 * numeric run out of the string, animates that, and reprints everything around it untouched — and
 * its SSR output is the FINAL value, so the figure is correct with JavaScript disabled, before the
 * observer fires, and for a reader who has asked for reduced motion.
 *
 * THE PURPLE RULE ABOVE EACH FIGURE IS THE STATIC HALF OF THE SIGNAL. The count is motion, and
 * motion is what a reduced-motion reader is spared; the rule, the figure and its label are what
 * remain, and they carry the whole meaning on their own (contract §1.4).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CENSUS, AND THE BUG THAT PUT IT HERE.
 *
 * This block shipped on the homepage reading "0 Crafts documented", "0 Field records", "0
 * Publications", "0 Partner institutions", captioned "Figures update as records are published" —
 * over a database holding 42 crafts, 30 publications and 13 partners. Four false statements and then
 * a promise that they were live. They were 0 because nothing ever counted anything: `value` is a
 * hand-typed string, the seed typed "0", and a string in a JSON column does not update itself.
 *
 * So a figure may now name a `metric`, and this renderer resolves it. THE PRECEDENCE, in one place:
 *
 *   1. **A typed `value` wins.** An editor who typed a figure made a claim, possibly one no query can
 *      express ("3 of 5"), and a count that overwrote it would be the page contradicting the person
 *      answerable for it.
 *   2. **Otherwise the counted figure**, from `resolved.census` — filled in by lib/sections/resolve.ts
 *      inside the page's own batched read, so it is exactly as fresh as the page around it.
 *   3. **Otherwise the item is DROPPED**, and this is the decision the whole block turns on.
 *
 * ⚠ A COUNT OF NOUGHT IS DROPPED TOO, and that is not the same as hiding a bad number. A row of
 * headline figures exists to answer "how much is there"; a 0 in that position answers "there is none
 * of this", which above a research centre's showcases reads as a defunct institution rather than as
 * an empty table. The truthful place to say a collection is empty is that collection's own listing,
 * which says it in words. And the same rule is what protects the page when the database is
 * unreachable: `censusFigure` answers `null`, the item goes, and a true figure can never be replaced
 * by a false one. **A statistic that is wrong is worse than a statistic that is absent.**
 *
 * ⚠ NOTHING IS SAID ON SCREEN ABOUT A DROPPED FIGURE, and that is a deliberate reading of contract
 * §1.6 rather than an oversight. §1.6 is about a LIST that quietly stops — where the reader cannot
 * tell a truncated set from an empty place. These figures are independent claims, not a list: the
 * ones that remain are complete and correct on their own, and a reader who never knew a fourth was
 * authored learns nothing from being told it is missing. The people who DO need to know are the
 * editor and the operator, so a dropped figure is logged below. If every figure drops, the block
 * renders nothing at all — announcing evidence and then showing none is the failure §1.6 actually
 * guards against, and it is handled below.
 *
 * ⚠ THE SERVER LOG IS THE ONLY TRACE, AND THAT IS A GAP RATHER THAN A DESIGN. An earlier version of
 * this header claimed `lib/health.ts` reports the block as well. It does not: that report finds blocks
 * still carrying the studio's PROMPT text, and blocks whose payload is identical to their all-defaults
 * document — neither of which describes a fully authored STATS block whose every count came back nought
 * or unavailable. So the one case where this renderer deliberately publishes less than the editor wrote
 * is invisible on every screen in the studio. Recorded rather than papered over; the fix is a check in
 * lib/health.ts, which this change does not own.
 *
 * WHEN THE CENSUS IS SUSPENDED (Settings → Homepage → "Show a note instead of the counts"), every
 * counted figure is `null` and the administrator's note is rendered in place of the row. That switch
 * existed before this block could count anything and had no effect on any page; it does now. Where the
 * switch is on and the note was left empty, `SUSPENDED_WITHOUT_NOTE` below keeps the block from
 * vanishing — read its header before touching either half.
 *
 * ⚠ THE SUSPENSION IS A PROPERTY OF THE PAGE AND THE SENTENCE ABOUT IT IS A PROPERTY OF THE BLOCK. The
 * census is built once for the whole page, so a block whose figures are every one of them typed by hand
 * still sees `suspended: true` when some other block on the page counts something. Nothing this renderer
 * SAYS about a suspension may therefore be keyed on `suspended` alone — see `asksForACount` and the second
 * warning on `SUSPENDED_WITHOUT_NOTE`, which records the falsehood that reached the page before it was.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { PageSection } from "@prisma/client";

import { STAGGER } from "@/components/motion/constants";
import { CountUp } from "@/components/motion/CountUp";
import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { sectionLabel } from "@/lib/sections/registry";
import { censusFigure, type ResolvedSectionData } from "@/lib/sections/resolve";
import type { StatsSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface StatsSectionProps {
  data: StatsSectionData;
  section: PageSection;
  /**
   * The page's batched read, which carries the census.
   *
   * STATS is absent from the `EXTRAS` table in `SectionRenderer`, so it is already handed
   * `{ resolved }` like every other block that is not a showcase — this prop needed no wiring, only
   * declaring. See the note on `ExtraPropsOf`: a renderer may ask for fewer props than it is given,
   * which is why this compiled the moment it was added.
   */
  resolved: ResolvedSectionData;
}

/**
 * Complete literal class strings, chosen by how many figures there are.
 *
 * Four figures go two-up on a phone rather than one-up: a stat is short, and a column of four
 * single-figure rows reads as four separate statements instead of one row of evidence.
 *
 * ⚠ IT IS PASSED THE NUMBER OF FIGURES THAT WILL ACTUALLY RENDER, not `data.items.length`. A block
 * authored with four figures where one is a suspended count renders three, and a `lg:grid-cols-4`
 * chosen from the authored count would leave a visible hole in the row where the fourth used to be.
 */
function columnClass(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-1 sm:grid-cols-2";
  if (count === 3) return "grid-cols-1 sm:grid-cols-3";
  if (count === 4) return "grid-cols-2 lg:grid-cols-4";
  return "grid-cols-2 md:grid-cols-3 lg:grid-cols-4";
}

/** After this many figures the entrance delay stops growing, so the last one is never a straggler. */
const MAX_STAGGER_STEPS = 6;

/**
 * What the block says when an administrator has suspended the counts and written no note.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WITHOUT THIS SENTENCE THE ENTIRE BLOCK DISAPPEARS, WHICH IS THE ONE OUTCOME THIS FILE IS AGAINST.
 *
 * `homepage.censusOverride` has two halves — a switch and a note — and `lib/settings/schema.ts`
 * deliberately does NOT make the note conditionally required: convention 2 there forbids a top-level
 * `superRefine` on a settings group, because it would cost the whole group its contents on read when a
 * stored document is partly corrupt, and it says instead that a relationship between two fields is
 * "stated in the description and enforced where it is READ". This is where it is read.
 *
 * So: switch on, note left empty, every figure counted rather than typed → every count is `null`, every
 * item is dropped, and the block used to return null. A whole band of the homepage vanished because
 * somebody ticked a box and did not fill in the box beside it, with nothing anywhere saying so.
 *
 * ⚠ IT IS SHOWN ONLY WHEN NO FIGURE SURVIVED, AND THAT CONDITION IS LOAD-BEARING RATHER THAN TIDY. A
 * block mixing counted and hand-typed figures still renders the typed ones under a suspension, and
 * printing "these figures are not being shown" above three figures that plainly are would be a fresh
 * falsehood in the file that exists to remove one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ AND THE ADMINISTRATOR'S NOTE IS NOW GATED TOO — ON `asksForACount`, WHICH IS THE DEFECT THIS
 * PARAGRAPH RECORDS RATHER THAN THE RULE IT USED TO STATE.
 *
 * The paragraph above argued the `figures.length === 0` condition at length and then left the
 * administrator's note, in the same expression, applying to every block on the page. `resolved.census` is
 * built ONCE PER PAGE out of every metric every block names, so `suspended` is a property of the page:
 *
 *   A page carries two stats blocks. Block A counts crafts and people. Block B is entirely hand-typed —
 *   "1,240 Hours of fieldwork", "12+ Districts", source "Annual report, March 2026". An administrator
 *   switches on Settings → Homepage → "Show a note instead of the counts" and writes "The counts are
 *   paused while we complete a data migration." Block B then rendered its two typed figures, the
 *   administrator's sentence about paused counts, and the source line crediting them — a sentence that is
 *   false about that block, since not one of its figures is a count. Measured by SSR, not reasoned.
 *
 * So the note, the fallback and the operator log all now hang on `suspendedHere` — the switch AND a figure
 * in THIS block that actually asked to be counted. Two consequences worth stating plainly:
 *
 *   • a block of hand-typed figures says nothing about a suspension, on a page where other blocks do;
 *   • a MIXED block — one count suspended, one typed figure surviving — still prints the note, above the
 *     figure that survived. That is deliberate and it is not the falsehood above: the note explains why
 *     there are two figures where the editor authored three, which is the reader's actual question. The
 *     `SUSPENDED_WITHOUT_NOTE` fallback stays out of that case, because "these figures are not being
 *     shown" would be false about the one that is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The wording states a fact about the page and claims nothing on the institution's behalf — it is not a
 * placeholder, and it cannot become false, because it renders only while the switch is on AND while this
 * block has a suspended count to account for. The administrator's own note always wins over it: they can
 * say WHY, and this cannot.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const SUSPENDED_WITHOUT_NOTE = "These figures are not being shown at present.";

/**
 * A counted figure as it should read.
 *
 * `en-GB`, matching `describeStatus` in lib/content.ts and every other formatted value on the site.
 * ⚠ NOT `en-IN`, deliberately, even though the Centre is Indian: that locale groups in lakhs, so a
 * figure of 123456 would print "1,23,456" — correct for one audience and misread by the
 * international one an institutional site also addresses. The prose here is British throughout and
 * the numbers follow it rather than splitting the difference.
 */
function formatCount(count: number): string {
  return count.toLocaleString("en-GB");
}

/** One figure that has survived into the row, with the text it will actually print. */
interface RenderableFigure {
  /** Position in the authored list — a stable React key that two identical labels cannot collide on. */
  index: number;
  display: string;
  label: string;
  suffix: string;
  description: string;
}

export function StatsSection({ data, section, resolved }: StatsSectionProps) {
  const figures: RenderableFigure[] = [];
  /** Authored figures that could not be shown. Counted for the log below, never for the page. */
  let dropped = 0;

  data.items.forEach((item, index) => {
    // The typed value first, always — see the precedence in the header.
    const typed = item.value.trim();
    const counted = typed ? null : censusFigure(resolved, item.metric);

    // `> 0`, not `!== null`: nought is a true count and an untellable figure, both of which this row
    // is the wrong place for. The header argues it at length.
    const display = typed || (counted !== null && counted > 0 ? formatCount(counted) : "");

    if (!display) {
      dropped += 1;
      return;
    }

    figures.push({
      index,
      display,
      label: item.label.trim(),
      suffix: item.suffix.trim(),
      description: item.description.trim()
    });
  });

  /**
   * Has an administrator suspended the counts?
   *
   * `=== true` rather than truthiness because `census` is OPTIONAL, and it is `null` whenever this page
   * named no metric at all — in which case the switch is irrelevant, since nothing was being counted and
   * so nothing was suspended.
   *
   * ⚠ THIS IS A PROPERTY OF THE PAGE, NOT OF THIS BLOCK. `resolved.census` is built once per page from
   * every metric every block on it names (lib/sections/resolve.ts), so one counted block anywhere on the
   * page makes `suspended` true for ALL of them — including a block whose figures are every one of them
   * typed by hand. That is why `asksForACount` below exists, and it is the whole of the defect described
   * on `SUSPENDED_WITHOUT_NOTE`.
   */
  const suspended = resolved.census?.suspended === true;

  /**
   * Did any figure in THIS block actually ask the site to count it?
   *
   * ⚠ A METRIC BEHIND A TYPED VALUE DOES NOT COUNT, and that is the same precedence the render loop above
   * applies: a typed figure wins, so the metric on that item was never going to produce anything and
   * suspending it takes nothing away. Only a figure that names a metric AND leaves its value empty is a
   * figure this suspension can have removed — so this predicate is exactly "is there anything here for the
   * switch to have affected".
   */
  const asksForACount = data.items.some(
    (item) => item.metric !== "" && item.value.trim().length === 0
  );

  /**
   * The suspension, as it applies TO THIS BLOCK.
   *
   * Everything the reader is told about the suspension hangs off this rather than off `suspended`,
   * because a sentence about paused counts is false in a block that asked for none. See the demonstrated
   * failure on `SUSPENDED_WITHOUT_NOTE`.
   */
  const suspendedHere = suspended && asksForACount;

  /**
   * The administrator's own words, where they wrote them.
   *
   * An empty note with the switch on must never render an empty paragraph where the figures were — a
   * gap that looks like a broken block rather than a deliberate suspension. The switch and the note are
   * siblings in the settings schema precisely so this pairing is possible to check.
   *
   * ⚠ THE TEST IS REPEATED RATHER THAN REUSING `suspendedHere` ABOVE, and it has to be. That is a plain
   * `boolean`, and TypeScript does not carry a narrowing through one — `if (suspendedHere)` leaves
   * `resolved.census` as possibly null, so reading `.note` behind it would not compile. Writing the
   * optional chain again in the expression that reads `.note` is what narrows it, and it is cheaper than
   * a non-null assertion that would silently outlive the reason for it. `asksForACount` is repeated for
   * the same reason and in the same expression, so the two can never fall out of step.
   */
  const administratorNote =
    asksForACount && resolved.census?.suspended === true ? resolved.census.note.trim() : "";

  /**
   * What actually goes in place of the figures.
   *
   * The note if there is one; otherwise the plain statement of fact, and ONLY when the row would
   * otherwise be empty. See the header on `SUSPENDED_WITHOUT_NOTE` for all three halves of that
   * condition — the block must have asked for a count, the switch must be on, and nothing may have
   * survived to contradict the sentence.
   */
  const suspensionLine =
    administratorNote || (suspendedHere && figures.length === 0 ? SUSPENDED_WITHOUT_NOTE : "");

  if (dropped > 0) {
    // Server-side, in every environment, because this is the only trace an operator gets that a
    // figure an editor authored is not on the page. It is not rendered — see the header on §1.6.
    console.warn(
      `[sections] the STATS block ${section.id} on page ${section.pageId} rendered ${figures.length} of ` +
        `${data.items.length} figures. ${dropped} had no value: either nothing was typed and no count ` +
        `was asked for, or the count is suspended, unavailable, or nought.`
    );
  }

  if (suspendedHere && administratorNote.length === 0) {
    /*
     * The one thing an administrator can do to this block that nothing on screen would otherwise
     * explain. Named as a SETTING rather than as a block, because that is where the fix is.
     *
     * ⚠ `suspendedHere`, NOT `suspended`: a block that asked for no count has had nothing suspended, and
     * an operator log claiming it "cannot say why its figures are absent" about a block whose figures are
     * all present and all typed by hand would be the same untruth on the console that this file removes
     * from the page. On a page with several stats blocks that log would fire for every one of them.
     *
     * ⚠ THE CONSEQUENCE IS BRANCHED BECAUSE IT GENUINELY DIFFERS, and a log that claimed the wrong one
     * would be the same class of untruth this file exists to remove: the fallback appears only where no
     * figure survived, so a block still rendering a hand-typed figure says nothing about the
     * suspension at all — which is correct on the page and is the more surprising state to be in.
     */
    console.warn(
      `[sections] the counts are suspended (Settings → Homepage → "Show a note instead of the counts") ` +
        `and no note has been written, so the STATS block ${section.id} on page ${section.pageId} cannot ` +
        `say why its figures are absent. ` +
        (suspensionLine
          ? "It is showing a plain statement that they are not being shown; write the note to say why."
          : "Its hand-typed figures still render, so the page says nothing about the suspension at all.")
    );
  }

  /**
   * Nothing to show.
   *
   * A block with no figures is not a block with a heading — it is a block announcing evidence and
   * then showing none, which is the failure contract §1.6 exists to prevent. The suspension line is
   * the one thing worth rendering on its own: it is the page accounting for figures a reader might
   * expect, and dropping it would turn a deliberate decision into a blank space.
   */
  if (figures.length === 0 && !suspensionLine) return null;

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  /** Is any of the header visible? Only then does it take space above the figures. */
  const showsHeader = Boolean(heading || eyebrow);

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {/*
          ALWAYS RENDERED, and for a different reason from the FAQ and the timeline: nothing inside this
          block is a heading, so no level was being SKIPPED — but the old condition let an EMPTY `<h2>`
          through. An editor who filled in the eyebrow and nothing else produced a heading element with
          no words in it: a rung in the document outline that says nothing, which a screen-reader user
          meets as a blank entry in the list of headings they navigate by.

          Rendering it unconditionally also gives the row of figures a name in that outline. The fallback
          words are the block's own name from `SECTION_REGISTRY` — "Key figures" — taken off screen where
          the editor left the heading blank, and the margin is gated on there being something to see.
        */}
        <SectionHeading
          eyebrow={eyebrow || undefined}
          title={heading || sectionLabel(section.type)}
          titleClassName={heading ? undefined : "sr-only"}
          className={showsHeader ? "mb-12" : undefined}
        />

        {figures.length > 0 ? (
          <ul className={cn("grid gap-x-8 gap-y-10", columnClass(figures.length))}>
            {figures.map((figure, position) => (
              <Reveal
                as="li"
                key={figure.index}
                delay={Math.min(position, MAX_STAGGER_STEPS) * STAGGER.cards}
              >
                <span aria-hidden="true" className="block h-px w-10 bg-purple-700" />

                {/*
                  ⚠ `tabular-nums` IS ON THE PARAGRAPH, NOT LEFT TO `CountUp`, AND THAT IS A CORRECTION.

                  `CountUp` adds the class to its own span (see property 2 of its header — a rolling
                  readout whose digits change width jitters). This paragraph carried none, so the figures
                  were set with tabular digits when `data.countUp` was ON and with proportional digits
                  when it was OFF: the block silently RETYPESET itself when an editor flipped a motion
                  toggle. A motion setting decides whether something moves. It must not decide how type
                  is set — and of the two settings the figures reached, only one of them was right.

                  Tabular is right for both branches rather than a compromise for one: this is a row of
                  figures to be COMPARED, so the digits want equal widths and the eye wants to read down
                  the row. It is the same reasoning `globals.css` gives for `font-variant-numeric:
                  tabular-nums lining-nums` on `th`/`td`. `CountUp` keeps its own class as well — the two
                  are the same declaration, so the animated branch renders exactly as it did.

                  ON THE `<p>` RATHER THAN ON EACH BRANCH so everything inside it agrees: the suffix span
                  below, and `CountUp`'s no-numeric-run return ("Ongoing", "Since 1998" — its `!parsed`
                  branch passes `className` straight through, which is `undefined` here). Every path
                  through this paragraph now sets digits the same way, whatever the toggle says.
                */}
                <p className="display-title mt-5 text-4xl leading-none tabular-nums sm:text-5xl">
                  {data.countUp ? <CountUp value={figure.display} /> : figure.display}
                  {figure.suffix ? (
                    <span className="ml-1 align-baseline text-2xl text-ink-500">{figure.suffix}</span>
                  ) : null}
                </p>

                {figure.label ? (
                  <p className="mt-4 text-sm font-semibold uppercase tracking-[0.12em] text-ink-700">
                    {figure.label}
                  </p>
                ) : null}

                {figure.description ? (
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">{figure.description}</p>
                ) : null}
              </Reveal>
            ))}
          </ul>
        ) : null}

        {/*
          The suspension line — the administrator's note, or the plain statement of fact.

          Rendered as prose rather than as a warning card: it is the institution explaining itself to a
          reader, not an error. `ink-700` rather than `ink-500` because when it stands alone it IS the
          content of the block, and the small print colour would read as a footnote to nothing.

          Themed neutrals throughout, never a hardcoded grey (contract §1.2).
        */}
        {suspensionLine ? (
          <p
            className={cn(
              "max-w-prose text-base leading-relaxed text-ink-700",
              figures.length > 0 ? "mt-12" : undefined
            )}
          >
            {suspensionLine}
          </p>
        ) : null}

        {/*
          Printed exactly as the editor wrote it. A "Source: " prefix added here would read as
          "Source: Source: Annual report" the moment somebody typed the obvious thing into the field.

          Gated on there being figures: a source line under a suspension note would credit figures that
          are not on the page.
        */}
        {data.source && figures.length > 0 ? (
          <p className="mt-12 text-sm text-ink-500">{data.source}</p>
        ) : null}
      </div>
    </section>
  );
}
