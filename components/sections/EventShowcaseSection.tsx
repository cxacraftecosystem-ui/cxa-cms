/**
 * EventShowcaseSection — the calendar, split at today.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE ZONE FOR EVERY READER, AND IT IS NAMED ON SCREEN.
 *
 * `CoeEvent.startsAt` is an absolute instant, and the schema is explicit that the site renders it in
 * the CENTRE's zone rather than the viewer's: "the seminar is at 4pm" must mean one time for
 * everyone, or two people comparing notes disagree about when to arrive. There is no timezone
 * setting yet, so the zone is the constant below — and every time carries its abbreviation, so a
 * reader in another country can convert rather than guess. When a setting exists, this constant is
 * the one place that changes.
 *
 * The dates are also formatted on the SERVER. These pages are prerendered, so there is no hydration
 * mismatch to guard against, and a date computed in the browser would silently differ per reader.
 *
 * THE BOUNDARY IS STATED IN WORDS, not implied by two lists. "Upcoming" with no date beside it makes
 * a reader work out for themselves whether an event happening today is in the list.
 *
 * "UPCOMING" MEANS NOT YET FINISHED. A three-day conference on its second morning is still upcoming
 * for anyone who might attend the rest of it; the same rule is applied in lib/sections/resolve.ts, so
 * the split here cannot disagree with the query that fetched the rows.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import Link from "next/link";
import type { EventMode, PageSection } from "@prisma/client";
import { ArrowRight, CalendarDays, ExternalLink, Globe, MapPin, Video, type LucideIcon } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { CardGrid } from "@/components/site/CardGrid";
import { EntityCard } from "@/components/site/EntityCard";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { pickShowcase, type EventRow, type ResolvedSectionData } from "@/lib/sections/resolve";
import type { EventShowcaseSectionData } from "@/lib/sections/schema";
import { cn, truncateWords } from "@/lib/utils";

export interface EventShowcaseSectionProps {
  data: EventShowcaseSectionData;
  section: PageSection;
  /** The whole batched read from `lib/sections/resolve.ts`; this block's rows are pulled out by id. */
  resolved?: ResolvedSectionData;
  /** The rows directly, for a studio preview or a bespoke page. Wins over `resolved` when given. */
  rows?: EventRow[];
  total?: number;
  droppedIds?: number;
}

/**
 * The Centre's zone. See the header — this is the single place it is decided, and the single place
 * that changes when it becomes a setting.
 */
const CENTRE_TIME_ZONE = "Asia/Kolkata";

const FMT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: CENTRE_TIME_ZONE });
const FMT_MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: CENTRE_TIME_ZONE });
const FMT_YEAR = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: CENTRE_TIME_ZONE });
const FMT_LONG = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: CENTRE_TIME_ZONE
});
const FMT_LONG_NO_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  timeZone: CENTRE_TIME_ZONE
});
const FMT_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: CENTRE_TIME_ZONE
});
const FMT_ZONE = new Intl.DateTimeFormat("en-GB", {
  timeZone: CENTRE_TIME_ZONE,
  timeZoneName: "short"
});
const FMT_BOUNDARY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: CENTRE_TIME_ZONE
});

/** "IST" — pulled out of a formatted string because `Intl` has no way to ask for the name alone. */
function zoneAbbreviation(date: Date): string {
  const part = FMT_ZONE.formatToParts(date).find((piece) => piece.type === "timeZoneName");
  return part?.value ?? "";
}

/** The calendar date IN THE CENTRE'S ZONE, as a sortable string — the basis of "is this multi-day". */
const FMT_ISO_DATE = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: CENTRE_TIME_ZONE
});

function calendarDay(date: Date): string {
  return FMT_ISO_DATE.format(date);
}

const MODE: Record<EventMode, { label: string; icon: LucideIcon; tone: BadgeTone }> = {
  IN_PERSON: { label: "In person", icon: MapPin, tone: "neutral" },
  ONLINE: { label: "Online", icon: Video, tone: "info" },
  HYBRID: { label: "Hybrid", icon: Globe, tone: "info" }
};

interface EventDates {
  /** True when the event spans more than one calendar day in the Centre's zone. */
  multiDay: boolean;
  /** The three lines of the date block. */
  block: { top: string; middle: string; bottom: string };
  /** The whole range in words, for the line under the title. */
  sentence: string;
  /** The time of day, or null for an all-day or multi-day entry where a start time means little. */
  time: string | null;
}

/**
 * Describe an event's dates so both shapes read correctly.
 *
 * A single-day event wants a day, a month and a time. A multi-day one wants a RANGE — showing only
 * its first day makes a four-day festival look like an afternoon, and showing "6 Aug" beside a title
 * that mentions the closing ceremony is the kind of small wrongness a reader notices immediately.
 */
function describeDates(startsAt: Date, endsAt: Date | null): EventDates {
  // The null test is inside the condition rather than beside it so `endsAt` narrows to `Date` for the
  // whole multi-day branch below — no cast, and no way for the two halves to disagree.
  if (!endsAt || calendarDay(endsAt) === calendarDay(startsAt)) {
    const zone = zoneAbbreviation(startsAt);
    const from = FMT_TIME.format(startsAt);
    const to = endsAt ? FMT_TIME.format(endsAt) : null;
    return {
      multiDay: false,
      block: {
        top: FMT_DAY.format(startsAt),
        middle: FMT_MONTH.format(startsAt),
        bottom: FMT_YEAR.format(startsAt)
      },
      sentence: FMT_LONG.format(startsAt),
      time: to && to !== from ? `${from}–${to} ${zone}` : `${from} ${zone}`
    };
  }

  const end = endsAt;
  const sameMonth = FMT_MONTH.format(end) === FMT_MONTH.format(startsAt);
  const sameYear = FMT_YEAR.format(end) === FMT_YEAR.format(startsAt);

  return {
    multiDay: true,
    block: sameMonth && sameYear
      ? {
          top: `${FMT_DAY.format(startsAt)}–${FMT_DAY.format(end)}`,
          middle: FMT_MONTH.format(startsAt),
          bottom: FMT_YEAR.format(startsAt)
        }
      : {
          top: `${FMT_DAY.format(startsAt)} ${FMT_MONTH.format(startsAt)}`,
          middle: `– ${FMT_DAY.format(end)} ${FMT_MONTH.format(end)}`,
          bottom: sameYear
            ? FMT_YEAR.format(startsAt)
            : `${FMT_YEAR.format(startsAt)}–${FMT_YEAR.format(end)}`
        },
    // "6 August – 9 August 2026" collapses to "6 – 9 August 2026" where the year is shared, which is
    // how a person writes it.
    sentence: sameYear
      ? `${FMT_LONG_NO_YEAR.format(startsAt)} – ${FMT_LONG_NO_YEAR.format(end)} ${FMT_YEAR.format(end)}`
      : `${FMT_LONG.format(startsAt)} – ${FMT_LONG.format(end)}`,
    // A start time on a multi-day entry invites a reader to arrive on the wrong day; the individual
    // sessions are on the event's own page, where the agenda is.
    time: null
  };
}

/** Not yet finished — the same rule the resolver's query uses. */
function isUpcoming(event: EventRow, now: Date): boolean {
  const boundary = event.endsAt ?? event.startsAt;
  return boundary.getTime() >= now.getTime();
}

export function EventShowcaseSection({
  data,
  section,
  resolved,
  rows: given,
  total: givenTotal,
  droppedIds: givenDropped
}: EventShowcaseSectionProps) {
  const { rows, total: matched, droppedIds } = pickShowcase(resolved?.events, section.id, {
    rows: given,
    total: givenTotal,
    droppedIds: givenDropped
  });

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const label = data.ctaLabel.trim();
  const href = data.ctaHref.trim();
  const link = label && href ? { href, label } : undefined;
  const showsHeader = Boolean(heading || eyebrow || body || link);
  const hidden = Math.max(0, matched - rows.length);

  const now = new Date();
  const upcoming = rows.filter((event) => isUpcoming(event, now));
  const past = rows.filter((event) => !isUpcoming(event, now));
  const bothGroups = upcoming.length > 0 && past.length > 0;
  /**
   * ⚠ ALWAYS 4, BECAUSE THE GROUP HEADING IS ALWAYS IN THE OUTLINE.
   *
   * `bothGroups` decides whether that heading is SEEN, not whether it exists: `EventGroup` renders its
   * `<h3>` either visibly or `sr-only`, on purpose, so a screen-reader user navigating by heading
   * always knows which half of the list they are in. Levelling the titles at 3 with one group would
   * therefore make them SIBLINGS of the heading that is there to scope them — the label would read as
   * an empty section followed by unrelated ones, which is the failure EmptyState's header names ("never
   * duplicate a rank they should sit under"). Levels still never skip (contract §11): h2 → h3 → h4.
   */
  const titleLevel: 3 | 4 = 4;

  const boundary = FMT_BOUNDARY.format(now);
  // Derived from WHAT IS ACTUALLY ON SCREEN rather than from `when`. A hand-curated block set to
  // "upcoming" can legitimately contain an event that has since passed, and a line reading "still to
  // come" above a finished seminar is the block contradicting itself.
  const boundaryLine = bothGroups
    ? `Split at ${boundary}: what is still to come, then what has already happened.`
    : past.length > 0
      ? `Events that finished before ${boundary}, most recent first.`
      : `Events still to come on or after ${boundary}, soonest first.`;

  const empty = {
    icon: CalendarDays,
    title:
      data.when === "past" ? "No past events to show yet" : "No upcoming events at the moment",
    description:
      data.when === "past"
        ? "Events move here once they have finished."
        : "New events appear here as soon as they are published in the studio.",
    headingLevel: 3 as const
  };

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <SectionHeading
            eyebrow={eyebrow || undefined}
            title={heading || "Events"}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            // ⚠ Withheld when the heading is off screen: `SectionHeading` gates its trailing link on
            // the link alone, so an `sr-only` title still paints it — and the row below would draw
            // the same call to action a second time. Exactly one of the two ever renders.
            link={heading ? link : undefined}
          />
        </Reveal>

        {/* The boundary, in words. Rendered even when only one group has anything in it — "upcoming"
            with no date beside it leaves a reader working out for themselves whether an event
            happening today counts. Suppressed when the list is empty, where the empty state says
            everything there is to say. */}
        {rows.length > 0 ? (
          <div className={showsHeader ? "mt-10" : undefined}>
            <p className="text-sm text-ink-500">{boundaryLine}</p>
          </div>
        ) : null}

        <div className="mt-8">
          {rows.length === 0 ? (
            <EmptyState {...empty} />
          ) : (
            <div className="flex flex-col gap-12">
              {upcoming.length > 0 ? (
                <EventGroup
                  title="Still to come"
                  showTitle={bothGroups}
                  events={upcoming}
                  layout={data.layout}
                  titleLevel={titleLevel}
                  allowRegistration
                />
              ) : null}

              {past.length > 0 ? (
                <EventGroup
                  title="Already happened"
                  showTitle={bothGroups}
                  events={past}
                  layout={data.layout}
                  titleLevel={titleLevel}
                  allowRegistration={false}
                />
              ) : null}
            </div>
          )}
        </div>

        <ShowcaseNote hidden={hidden} matched={matched} dropped={droppedIds} link={link} />

        {/* The CTA's one copy when the heading is off screen — see the note beside `SectionHeading`. */}
        {!heading && link ? (
          <div className="mt-10">
            <LinkButton href={link.href} variant="secondary" icon={ArrowRight} iconPosition="end">
              {link.label}
            </LinkButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function EventGroup({
  title,
  showTitle,
  events,
  layout,
  titleLevel,
  allowRegistration
}: {
  title: string;
  showTitle: boolean;
  events: EventRow[];
  layout: EventShowcaseSectionData["layout"];
  titleLevel: 3 | 4;
  /** Registration links are drawn for upcoming events only — a "Register" on a finished seminar is a
   *  dead end dressed as an invitation. */
  allowRegistration: boolean;
}) {
  return (
    <section>
      {/* Kept in the outline even when it is not shown, so a screen-reader user navigating by heading
          still knows which half of the list they are in. ⚠ That is exactly why `titleLevel` is 4
          whether or not this heading is visible — see the note where it is decided. */}
      <h3
        className={cn(
          showTitle
            ? "display-title text-sm font-semibold uppercase tracking-[0.14em] text-ink-500"
            : "sr-only"
        )}
      >
        {title}
      </h3>

      {layout === "grid" ? (
        <div className={showTitle ? "mt-5" : undefined}>
          <CardGrid columns={3} stagger>
            {events.map((event) => (
              <EventCard key={event.id} event={event} headingLevel={titleLevel} />
            ))}
          </CardGrid>
        </div>
      ) : (
        <ul
          className={cn(
            "divide-y divide-line-200 border-t border-line-200",
            showTitle ? "mt-5" : undefined
          )}
        >
          {events.map((event, index) => (
            <li key={event.id}>
              <Reveal delay={Math.min(index, 8) * 0.05}>
                <EventListRow
                  event={event}
                  titleLevel={titleLevel}
                  allowRegistration={allowRegistration}
                />
              </Reveal>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventCard({ event, headingLevel }: { event: EventRow; headingLevel: 3 | 4 }) {
  const dates = describeDates(event.startsAt, event.endsAt);
  const mode = MODE[event.mode];

  return (
    <EntityCard
      href={`/events/${event.slug}`}
      media={event.cover}
      variant="cover"
      headingLevel={headingLevel}
      eyebrow={dates.sentence}
      title={event.title}
      description={
        event.summary?.trim()
          ? truncateWords(event.summary, 180)
          : (event.subtitle ?? undefined)
      }
      meta={
        <>
          <Badge tone={mode.tone} icon={mode.icon} size="sm">
            {mode.label}
          </Badge>
          {dates.time ? <span className="tabular-nums">{dates.time}</span> : null}
          {event.venue ? <span>{event.venue}</span> : null}
        </>
      }
    />
  );
}

function EventListRow({
  event,
  titleLevel,
  allowRegistration
}: {
  event: EventRow;
  titleLevel: 3 | 4;
  allowRegistration: boolean;
}) {
  const dates = describeDates(event.startsAt, event.endsAt);
  const mode = MODE[event.mode];
  const registration = allowRegistration && event.isRegistrationOpen && event.registrationUrl?.trim();

  const titleLink = (
    <Link
      href={`/events/${event.slug}`}
      className="display-title text-balance text-lg leading-snug transition-colors hover:text-purple-700"
    >
      {event.title}
    </Link>
  );

  return (
    <div className="flex gap-5 py-5">
      {/*
        The date block. `aria-hidden` because the sentence beside the title says the same dates in
        words and in a machine-readable `<time>`; announcing "6 dash 9 Aug 2026" as three loose
        fragments first would be noise, not information.
      */}
      <div
        aria-hidden="true"
        className="flex w-20 shrink-0 flex-col items-center justify-center rounded-md border border-line-200 bg-surface-50 px-2 py-3 text-center"
      >
        <span
          className={cn(
            "display-title leading-none text-purple-700",
            dates.block.top.length > 5 ? "text-base" : "text-2xl"
          )}
        >
          {dates.block.top}
        </span>
        <span className="mt-1 text-xs font-semibold uppercase tracking-wide text-ink-700">
          {dates.block.middle}
        </span>
        <span className="mt-0.5 text-xs tabular-nums text-ink-500">{dates.block.bottom}</span>
      </div>

      <div className="min-w-0 flex-1">
        {titleLevel === 3 ? <h3>{titleLink}</h3> : <h4>{titleLink}</h4>}

        <p className="mt-1.5 text-sm text-ink-700">
          <time dateTime={event.startsAt.toISOString()}>{dates.sentence}</time>
          {dates.time ? <span className="tabular-nums"> · {dates.time}</span> : null}
        </p>

        {event.summary?.trim() ? (
          <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-500">
            {truncateWords(event.summary, 200)}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-ink-500">
          <Badge tone={mode.tone} icon={mode.icon} size="sm">
            {mode.label}
          </Badge>
          {event.venue ? <span>{event.venue}</span> : null}

          {registration ? (
            <a
              href={registration}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-purple-700 transition-colors hover:text-purple-800"
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
              Register
              <span className="sr-only"> for {event.title} (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The honest footnote — contract §1.6. */
function ShowcaseNote({
  hidden,
  matched,
  dropped,
  link
}: {
  hidden: number;
  matched: number;
  dropped: number;
  link?: { href: string; label: string };
}) {
  if (hidden === 0 && dropped === 0) return null;

  return (
    <p className="mt-8 text-sm text-ink-500">
      {hidden > 0 ? (
        <>
          Showing {matched - hidden} of {matched} events.{" "}
          {link ? (
            <Link href={link.href} className="font-medium text-purple-700 hover:text-purple-800">
              {link.label}
            </Link>
          ) : null}
        </>
      ) : null}
      {dropped > 0 ? (
        <>
          {hidden > 0 ? " " : null}
          {dropped} chosen {dropped === 1 ? "event is" : "events are"} no longer published and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
