/**
 * ActionStepsSection — "How to apply", "What to bring", "Submission checklist".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NOTHING IS EVER DROPPED FROM A CHECKLIST.
 *
 * A step whose closing date has passed is STATED AS PASSED and stays exactly where it was. The
 * tempting alternative — hide it, or quietly grey it out — is the single worst thing this block could
 * do, because the reader who needed that step is precisely the reader who cannot discover it is
 * missing: they see a five-step process, complete all five, and are told at the end that they were
 * meant to have sent references in August. A list that quietly stops is indistinguishable from a
 * shorter list (contract §1.6), and a shortened process is indistinguishable from the whole one.
 *
 * The same rule settles the awkward case where an editor has marked a step "Open" and its deadline has
 * since passed. The two facts are BOTH rendered — the status the editor set, and the deadline stated as
 * passed. Silently overriding one of them would mean the page and the studio disagree about what it
 * says, and the editor would have no way to see the override.
 *
 * The ONE thing left out is a row with nothing in any of its fields, which is not a step: it is a row an
 * editor added and has not typed into yet. That is the same filter `TimelineSection` applies, and it is
 * the opposite case to the one above — there is no content to lose and nothing a reader could act on.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A Server Component. `Reveal` is the only client piece, so a sixteen-step process ships no JavaScript
 * of its own.
 *
 * ⚠ THE RELATIVE SENTENCE IS COMPUTED ON THE SERVER, and that is on purpose. The pages built out of
 * blocks (`app/(site)/page.tsx`, `[...slug]`, `about`) carry `export const revalidate = 300`, so "closes
 * in 9 days" can be at most five minutes out of step — and it is never the only thing on screen: the
 * ABSOLUTE date is always printed beside it, in a `<time>`, so a reader can check the arithmetic
 * themselves. Computing it in the browser instead would make the sentence differ per reader's clock and
 * per reader's timezone, which for a deadline is worse than five minutes of staleness.
 *
 * THE SPINE IS STATIC. It is a hairline and a node per step, drawn in CSS with no scroll instrument
 * behind it — unlike `TimelineSection`, which has a `ScrollProgress` fill because a chronology is
 * something you travel through. A checklist is something you work down while looking away at a form,
 * so a line that animates as you scroll would be decoration competing with the content. Static also
 * means the structure survives reduced motion intact (contract §1.4), because there is nothing to
 * reduce.
 *
 * ONE ZONE FOR EVERY READER. Deadlines are read in the CENTRE's timezone, not the visitor's: "closes on
 * 30 September" must mean one day for everybody, or two applicants comparing notes disagree about when
 * the door shuts. The constant below is the same one `EventShowcaseSection` uses and must move with it
 * when the timezone becomes a setting.
 */

import type { PageSection } from "@prisma/client";
import { CalendarClock, CircleAlert, CircleCheck, CircleSlash, Clock, type LucideIcon } from "lucide-react";

import { STAGGER } from "@/components/motion/constants";
import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { sectionLabel } from "@/lib/sections/registry";
import type { ActionStep, ActionStepsSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

/** See the header — the Centre's zone, and the one place it is decided for this block. */
const CENTRE_TIME_ZONE = "Asia/Kolkata";

const FMT_DEADLINE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: CENTRE_TIME_ZONE
});

/** The calendar date in the Centre's zone, as `YYYY-MM-DD`. The basis of every day count below. */
const FMT_CENTRE_DAY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: CENTRE_TIME_ZONE
});

/**
 * A status, as a word AND a glyph AND a tone — never a tone alone (contract §11).
 *
 * The words are the ones an applicant reads rather than the code words in the payload: "Not open yet"
 * says something actionable, where "coming" is a developer's abbreviation.
 */
const STATUS: Record<
  Exclude<ActionStep["status"], "">,
  { label: string; icon: LucideIcon; tone: BadgeTone }
> = {
  open: { label: "Open now", icon: CircleCheck, tone: "success" },
  closed: { label: "Closed", icon: CircleSlash, tone: "neutral" },
  coming: { label: "Not open yet", icon: Clock, tone: "info" }
};

interface DeadlineFacts {
  /** For `<time dateTime>` — the calendar day in the Centre's zone, machine readable. */
  iso: string;
  /** "30 September 2026". */
  date: string;
  /** "closes in 9 days", "this deadline passed 3 days ago". Always a complete clause. */
  relative: string;
  passed: boolean;
}

/** Days since the epoch for a `YYYY-MM-DD` string, via UTC so no daylight-saving shift can creep in. */
function dayIndex(isoDay: string): number | null {
  const parts = isoDay.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * Turn the editor's stored date into the two things a reader needs, or null.
 *
 * Null covers both "no deadline" and "the stored value is not a date the browser can read" — the schema
 * refuses the second on save, but a payload can predate the rule, and a step is never dropped over it:
 * the rest of the step renders and the deadline line is simply absent.
 *
 * A bare `2026-09-30` is read as UTC midnight and then formatted in the Centre's zone, which is 5½ hours
 * AHEAD of UTC and therefore lands on the same calendar day. A full ISO instant is honoured as an
 * instant, which is what somebody who pasted one meant.
 */
function describeDeadline(raw: string, now: Date): DeadlineFacts | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;

  const isoDay = FMT_CENTRE_DAY.format(parsed);
  const deadlineIndex = dayIndex(isoDay);
  const todayIndex = dayIndex(FMT_CENTRE_DAY.format(now));
  const date = FMT_DEADLINE.format(parsed);

  // No arithmetic possible: the date is still shown, without a relative clause. Saying nothing is
  // better than saying "closes in NaN days".
  if (deadlineIndex === null || todayIndex === null) {
    return { iso: isoDay, date, relative: "", passed: false };
  }

  const days = deadlineIndex - todayIndex;

  if (days > 1) return { iso: isoDay, date, relative: `closes in ${days} days`, passed: false };
  if (days === 1) return { iso: isoDay, date, relative: "closes tomorrow", passed: false };
  if (days === 0) return { iso: isoDay, date, relative: "closes today", passed: false };
  if (days === -1) return { iso: isoDay, date, relative: "this deadline passed yesterday", passed: true };
  return { iso: isoDay, date, relative: `this deadline passed ${-days} days ago`, passed: true };
}

/** Is there anything in this step at all, or is it a row an editor added and has not filled in? */
function isFilledIn(step: ActionStep): boolean {
  return (
    step.title.length > 0 ||
    step.detail.length > 0 ||
    step.href.length > 0 ||
    step.deadline.length > 0 ||
    step.status.length > 0
  );
}

/** `/path` and `#anchor` are ours; anything else leaves the site and should open beside it. */
function leavesTheSite(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** The entrance delay stops growing here; sixteen steps at a full stagger arrive half a second apart. */
const MAX_STAGGER_STEPS = 8;

export interface ActionStepsSectionProps {
  data: ActionStepsSectionData;
  section: PageSection;
}

export function ActionStepsSection({ data, section }: ActionStepsSectionProps) {
  const steps = data.steps.filter(isFilledIn);
  // Consistent with `FeatureGridSection` and `TimelineSection`: a content block with nothing in it
  // renders nothing. A freshly added block is seeded with three steps, so an empty one is only reachable
  // by deliberately deleting every row — which is an editor saying "not this block".
  if (steps.length === 0) return null;

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  /** Is any of the header visible? Only then does it take space above the steps. */
  const showsHeader = Boolean(heading || eyebrow || body);

  const now = new Date();

  const rows = steps.map((step, index) => {
    const isLast = index === steps.length - 1;
    const title = step.title.trim();
    const detail = step.detail.trim();
    const href = step.href.trim();
    const ctaLabel = step.ctaLabel.trim();
    const deadline = describeDeadline(step.deadline, now);
    const status = step.status === "" ? null : STATUS[step.status];
    const newTab = leavesTheSite(href);

    return (
      <Reveal
        as="li"
        key={`${index}-${title}`}
        delay={Math.min(index, MAX_STAGGER_STEPS) * STAGGER.rows}
        className="relative pb-10 pl-16 last:pb-0"
      >
        {/*
          THE SPINE. A hairline from just below this step's node to the top of the next one's, so the
          line reads as joining two steps rather than as running off the end of the list. `left-[1.375rem]`
          is half of the 44px node, which is what puts the line through its centre. Omitted on the last
          step, which has nothing below it to join.
        */}
        {!isLast ? (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-[1.375rem] top-12 w-px bg-line-200"
          />
        ) : null}

        {/*
          `aria-hidden` on the numeral, and that is not an oversight: the `<ol>` below already tells a
          screen reader "item 3 of 7", so reading the printed 3 as well would announce the same ordinal
          twice. In the unnumbered variant the glyph is a plain dot with no information in it at all.
        */}
        <span
          aria-hidden="true"
          className="absolute left-0 top-0 flex h-11 w-11 items-center justify-center rounded-full border border-line-200 bg-card shadow-sm"
        >
          {data.numbered ? (
            <span className="display-title text-base leading-none text-purple-700">{index + 1}</span>
          ) : (
            <span className="block h-2 w-2 rounded-full bg-purple-700" />
          )}
        </span>

        {title ? <h3 className="display-title text-balance text-lg sm:text-xl">{title}</h3> : null}

        {detail ? (
          <p className={cn("prose-measure text-sm leading-relaxed text-ink-500", title && "mt-2")}>
            {detail}
          </p>
        ) : null}

        {status || deadline ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {status ? (
              <Badge tone={status.tone} icon={status.icon} size="sm">
                {status.label}
              </Badge>
            ) : null}

            {deadline ? (
              /*
                A tinted strip rather than plain coloured text. `amber-100` with `amber-800` is a PAIR —
                the status ramps are literal hex and do not invert, so amber-800 sitting straight on the
                page background would be a dark brown on a dark canvas (contract §3). The glyph and the
                words carry the meaning; the tint only draws the eye to it.
              */
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs leading-tight",
                  deadline.passed
                    ? "bg-amber-100 text-amber-800"
                    : "bg-surface-100 text-ink-700"
                )}
              >
                {deadline.passed ? (
                  <CircleAlert aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <CalendarClock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                )}
                <span>
                  Closing date:{" "}
                  <time dateTime={deadline.iso} className="font-medium">
                    {deadline.date}
                  </time>
                  {deadline.relative ? ` — ${deadline.relative}` : null}
                </span>
              </span>
            ) : null}
          </div>
        ) : null}

        {href ? (
          <div className="mt-4">
            {/*
              EVERY step's button is `secondary`, deliberately. The steps are peers, and sixteen purple
              buttons down one page is sixteen controls each claiming to be the most important thing on
              it — which leaves the reader with no hierarchy at all. The page's one primary action is the
              form, not the instructions for reaching it.

              A step that leaves the site opens beside the page: a reader sent to a ministry circular in
              the same tab has lost the checklist they were working through. `LinkButton` pairs that with
              `rel="noopener noreferrer"` and a spoken "(opens in a new tab)".
            */}
            <LinkButton href={href} variant="secondary" newTab={newTab}>
              {ctaLabel || "Open this step"}
              {/* Several "Open this step" buttons on one page need distinguishable accessible names.
                  Added only when the editor left the label generic — a label they wrote is already
                  specific, and appending the title to it would read as a stutter. */}
              {!ctaLabel && title ? <span className="sr-only"> — {title}</span> : null}
            </LinkButton>
          </div>
        ) : null}
      </Reveal>
    );
  });

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {/*
          ALWAYS RENDERED. Every step's title is an `<h3>`, so a checklist with no `<h2>` of its own takes
          the page from `<h1>` straight to `<h3>` — a level missing from the outline a screen-reader user
          navigates by (contract §11). A heading an editor cleared is taken OFF SCREEN rather than
          invented, and the fallback words are the block's own name from `SECTION_REGISTRY` so they come
          from one place.
        */}
        <SectionHeading
          eyebrow={eyebrow || undefined}
          title={heading || sectionLabel(section.type)}
          titleClassName={heading ? undefined : "sr-only"}
          description={body || undefined}
          className={showsHeader ? "mb-12" : undefined}
        />

        {/*
          `<ol>` when the steps are in order and `<ul>` when they are not, and the difference is not
          cosmetic: an ordered list is what makes a screen reader say "item 3 of 7", which is the whole of
          what "step 3" means. Written as two concrete branches rather than a `const Tag = numbered ?
          "ol" : "ul"`, because TypeScript intersects the props of a union of intrinsic elements and
          collapses `children` to `never` — the same trap `components/ui/Heading.tsx` documents at length.

          `list-none` because the markers are the nodes on the spine — and `role="list"` because Safari
          and VoiceOver DROP list semantics entirely when `list-style: none` is set, taking the "N items"
          count and every item's position with them. The role is what puts them back; the browser's
          own bullets would sit outside them.
        */}
        {data.numbered ? (
          <ol role="list" className="list-none">{rows}</ol>
        ) : (
          <ul role="list" className="list-none">{rows}</ul>
        )}
      </div>
    </section>
  );
}
