/**
 * /events — the calendar, split at now.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * "UPCOMING" MEANS NOT YET FINISHED, AND THE BOUNDARY IS STATED IN WORDS.
 *
 * An event happening TODAY is upcoming until it ENDS, not until it starts: a conference on its second
 * morning is still something a reader can attend the rest of, and filing it under "already happened"
 * would send them away. The rule is `endsAt ?? startsAt`, and it is written once in
 * components/site/EventDateBlock.tsx — the SQL below and the badge on an event's own page read the same
 * rule, so the two cannot disagree about which half of the page an event belongs in.
 *
 * The split is also SAID, not implied by the order of two lists: "Upcoming" with no date beside it
 * leaves a reader working out for themselves whether today counts.
 *
 * ONE ZONE FOR EVERY READER, NAMED ON SCREEN. Every time here is formatted on the server in the
 * Centre's zone and carries its abbreviation. "The seminar is at 4pm" has to mean one time for
 * everyone; rendering in the viewer's locale is how an international audience misses it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * PAGINATION WALKS THE PAST ONLY. The upcoming list is inherently short and is shown whole (up to a cap
 * that says so when it bites); the archive grows without bound, so it is paged. That asymmetry is
 * stated on screen beside the pager rather than left for a reader to deduce from a page 2 that still
 * has the same events at the top of it.
 *
 * `features.events` GATES THE WHOLE SURFACE. With it switched off this page is a 404, matching what the
 * setting promises in lib/settings/schema.ts: the listing, the event pages and the navigation entry all
 * go together. A surface that is switched off but still reachable is worse than one that is on.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { CalendarDays, SearchX } from "lucide-react";

import { Reveal } from "@/components/motion";
import { CardGrid } from "@/components/site/CardGrid";
import { EntityCard } from "@/components/site/EntityCard";
import {
  EVENT_MODES,
  centreYear,
  centreZoneName,
  describeEventDates,
  formatCentreDate
} from "@/components/site/EventDateBlock";
import { FilterBar, type FilterGroup } from "@/components/site/FilterBar";
import { PageHero } from "@/components/site/PageHero";
import { ResultSummary } from "@/components/site/ResultSummary";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { framingAssets, withBaseAsset } from "@/lib/media/framing";
import { pictureFromMap, type ScreenFraming } from "@/lib/media/screens";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import type { MediaLike } from "@/lib/media/url";
import { pageMetadata } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { truncateWords, unique } from "@/lib/utils";
import { prerenderSafe } from "@/lib/prerender";

/** How many of the events still to come are listed before the page says it has stopped. */
const UPCOMING_CAP = 24;
/** One page of the archive. */
const PAST_PAGE_SIZE = 12;

const NOUN = { singular: "event", plural: "events" } as const;

const DESCRIPTION =
  "Conferences, seminars, workshops and public lectures at the Centre — what is still to come, and " +
  "the archive of what has already happened.";

/**
 * `CoeEvent` carries only `status` (no publishAt/unpublishAt columns), so the publication filter is
 * `liveStatusWhere()`. They are two functions on purpose: referencing a column a model does not have is
 * a Prisma runtime error, not a type error (lib/content.ts).
 */
const eventCardSelect = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  summary: true,
  mode: true,
  venue: true,
  startsAt: true,
  endsAt: true,
  coverId: true,
  // The framing rides in the same select as the relation it frames. A query that fetched one without the
  // other is how the single stored crop came to be rendered by nothing — scripts/media-select-check.ts.
  coverScreens: true,
  // `isRegistrationOpen` is deliberately NOT selected. A "Registration open" chip on a card would be
  // read as "there is a place for me", and this query has not counted the registrations — a full event
  // would advertise itself as available. Whether a place exists is answered on the event's own page,
  // where the count is.
  cover: { select: MEDIA_IMAGE_SELECT }
} satisfies Prisma.CoeEventSelect;

type EventCardRow = Prisma.CoeEventGetPayload<{ select: typeof eventCardSelect }>;

/**
 * The stored framing, typed.
 *
 * Prisma answers a JSONB column as `JsonValue` and the shape belongs to lib/media/screens.ts, so the cast
 * is where the two meet. Nothing downstream trusts it: `resolvePicture` reads each bucket defensively and
 * an unusable rectangle degrades to "no crop", so a hand-edited row is a plain photograph rather than a
 * broken frame.
 */
function coverFraming(event: EventCardRow): ScreenFraming | null {
  return (event.coverScreens ?? null) as unknown as ScreenFraming | null;
}

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

function many(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((entry) => entry.length > 0);
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function pageFrom(value: string | string[] | undefined): number {
  const raw = one(value);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 1 ? Math.floor(parsed) : 1;
}

/** The listing path carrying the current filters, for `Pagination` to hang `?page=` off. */
function listHref(year: string | null, tags: string[]): string {
  const params = new URLSearchParams();
  if (year) params.set("year", year);
  for (const tag of tags) params.append("tag", tag);
  const query = params.toString();
  return query.length > 0 ? `/events?${query}` : "/events";
}

export async function generateMetadata({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const year = one(params.year);
  const tags = many(params.tag);
  const page = pageFrom(params.page);
  const filtered = year !== null || tags.length > 0;

  return pageMetadata({
    title: year ? `Events in ${year}` : page > 1 ? `Events — page ${page}` : "Events",
    description: year
      ? `Everything the Centre held or has planned in ${year}.`
      : DESCRIPTION,
    path: page > 1 ? `/events?page=${page}` : "/events",
    // A filtered view is a view, not a destination: there is no page for it to be the canonical copy
    // of, so it stays out of the index rather than competing with /events for the same words.
    noIndex: filtered,
    keywords: ["events", "seminars", "conferences", "workshops"]
  });
}

/**
 * Refreshed every five minutes rather than frozen at build time.
 *
 * ⚠ REQUIRED BY THE `prerenderSafe` GUARD BELOW, not merely nice to have: a page whose data read fell
 * back at build time is prerendered EMPTY, and without a revalidation window that snapshot would be
 * served until the next deploy. It is also right on its own terms — this page lists content an editor
 * publishes without a deploy, so an unlimited lifetime is the wrong default regardless.
 */
export const revalidate = 300;

export default async function EventsIndexPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const year = one(params.year);
  const tags = many(params.tag);
  const page = pageFrom(params.page);
  const filtered = year !== null || tags.length > 0;

  const features = await getSettingCached("features");
  if (!features.events) notFound();

  // ONE `now` for the whole render: the two queries, the boundary sentence and the group each event
  // lands in all answer to the same instant. Two `new Date()` calls a millisecond apart could put an
  // event that is ending right now in neither list.
  const now = new Date();

  /**
   * Every live event's id and start, for two jobs at once: the year options, and the id set for a
   * chosen year.
   *
   * ⚠ THE YEAR IS DECIDED IN THE CENTRE'S ZONE, AND THE SAME FUNCTION DECIDES IT FOR BOTH. A SQL date
   * range would have to reconstruct the zone's offset for 1 January, and any drift between that
   * reconstruction and `centreYear()` would show an event under a year the filter list does not offer.
   * Filtering by id makes the option and the filter the same computation by construction. The query is
   * one narrow column over a table with hundreds of rows, not millions.
   */
  const calendar = await prisma.coeEvent.findMany({
    where: liveStatusWhere(),
    select: { id: true, startsAt: true }
  });

  // Newest year first: an archive is read backwards.
  const years = unique(calendar.map((entry) => centreYear(entry.startsAt))).sort().reverse();
  const yearIds = year
    ? calendar.filter((entry) => centreYear(entry.startsAt) === year).map((entry) => entry.id)
    : null;

  const base: Prisma.CoeEventWhereInput[] = [liveStatusWhere()];
  // ANY of the chosen topics, not all of them — a reader ticking two tags is widening the net.
  if (tags.length > 0) base.push({ tags: { some: { tag: { slug: { in: tags } } } } });
  // An empty id list is a real answer ("no events that year"), not a missing filter.
  if (yearIds) base.push({ id: { in: yearIds } });

  /** Not yet finished. The null branch is for an event with no end time, where the start is the end. */
  const notFinished: Prisma.CoeEventWhereInput = {
    OR: [{ endsAt: { gte: now } }, { endsAt: null, startsAt: { gte: now } }]
  };
  const finished: Prisma.CoeEventWhereInput = {
    OR: [{ endsAt: { lt: now } }, { endsAt: null, startsAt: { lt: now } }]
  };

  const upcomingWhere: Prisma.CoeEventWhereInput = { AND: [...base, notFinished] };
  const pastWhere: Prisma.CoeEventWhereInput = { AND: [...base, finished] };

  const [upcomingTotal, upcoming, pastTotal, past, tagRows] = await prerenderSafe(
    "events",
    () =>
      Promise.all([
          prisma.coeEvent.count({ where: upcomingWhere }),
          prisma.coeEvent.findMany({
            where: upcomingWhere,
            // Soonest first: the next thing a reader could attend is the thing they came for.
            orderBy: { startsAt: "asc" },
            take: UPCOMING_CAP,
            select: eventCardSelect
          }),
          prisma.coeEvent.count({ where: pastWhere }),
          prisma.coeEvent.findMany({
            where: pastWhere,
            orderBy: { startsAt: "desc" },
            skip: (page - 1) * PAST_PAGE_SIZE,
            take: PAST_PAGE_SIZE,
            select: eventCardSelect
          }),
          // Only topics that are on a live event. A chip that returns nothing is a dead control.
          prisma.tag.findMany({
            where: { events: { some: { event: liveStatusWhere() } } },
            orderBy: { name: "asc" },
            select: { slug: true, name: true }
          })
      ]),
    [0, [], 0, [], []]
  );

  /**
   * The alternate photographs every card's framing names, in ONE query for the whole page.
   *
   * `framingAssets` is variadic and issues no query at all when nothing on the page is framed — see its
   * header — so both lists are handed to it unconditionally rather than each card fetching for itself,
   * which would be one round trip per card. The base cover is added per card below, because
   * `pictureFromMap` looks the base photograph up by id like any other.
   */
  const framingMedia = await framingAssets(
    ...upcoming.map(coverFraming),
    ...past.map(coverFraming)
  );

  const groups: FilterGroup[] = [];
  if (years.length > 1) {
    groups.push({
      key: "year",
      label: "Year",
      control: "select",
      placeholder: "Every year",
      options: years.map((value) => ({ value, label: value }))
    });
  }
  if (tagRows.length > 0) {
    groups.push({
      key: "tag",
      label: "Topics",
      multiple: true,
      control: "chips",
      allLabel: "Every topic",
      options: tagRows.map((tag) => ({ value: tag.slug, label: tag.name }))
    });
  }

  const boundary = formatCentreDate(now);
  const zoneShort = centreZoneName(now);
  const zoneLong = centreZoneName(now, "long");
  const href = listHref(year, tags);
  const nothingAtAll = upcomingTotal === 0 && pastTotal === 0;

  return (
    <>
      <PageHero
        eyebrow="Diary"
        title="Events"
        description={DESCRIPTION}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Events", href: "/events" }
        ]}
      />

      <div className="shell pb-24">
        {groups.length > 0 ? (
          <FilterBar
            label="Filter the diary"
            groups={groups}
            className="border-y border-line-200 py-6"
          />
        ) : null}

        {/*
          THE BOUNDARY AND THE ZONE, IN WORDS, BEFORE EITHER LIST. Both sentences answer a question a
          reader would otherwise have to guess the answer to: where "today" falls, and whose clock the
          times are on.
        */}
        <div className="mt-10 flex flex-col gap-1.5 text-sm leading-relaxed text-ink-500">
          <p>
            Split at {boundary}. An event counts as still to come until it FINISHES, so a conference on
            its second day is above the line, not below it.
          </p>
          <p>
            All times are given in {zoneLong}
            {zoneShort ? ` (${zoneShort})` : ""} — the Centre&rsquo;s own time, not your
            device&rsquo;s.
          </p>
        </div>

        {nothingAtAll ? (
          <EmptyState
            className="mt-10"
            headingLevel={2}
            icon={filtered ? SearchX : CalendarDays}
            title={filtered ? "No events match these filters" : "There are no events yet"}
            description={
              filtered
                ? "Try another year, or fewer topics."
                : "Events appear here as soon as they are published in the studio."
            }
            action={
              filtered ? (
                <LinkButton href="/events" variant="secondary">
                  Clear the filters
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <div className="mt-14 flex flex-col gap-20">
            <section>
              <SectionHeading
                level={2}
                title="Still to come"
                description={
                  upcomingTotal === 0
                    ? "Nothing is in the diary for the moment. New events are announced here first."
                    : `Soonest first, from ${boundary} onwards.`
                }
              />

              {upcoming.length > 0 ? (
                <>
                  <div className="mt-8">
                    <CardGrid columns={3} stagger>
                      {upcoming.map((event) => (
                        <EventListCard
                          key={event.id}
                          event={event}
                          framingMedia={framingMedia}
                          headingLevel={3}
                        />
                      ))}
                    </CardGrid>
                  </div>

                  {/*
                    The one place a cap is declared. `truncated` is a FACT here — the count and the
                    number of rows on screen are both known — rather than a guess (contract §1.6).
                  */}
                  <ResultSummary
                    className="mt-6"
                    shown={upcoming.length}
                    total={upcomingTotal}
                    noun={NOUN}
                    truncated={upcoming.length < upcomingTotal}
                    cap={UPCOMING_CAP}
                    omitted={upcomingTotal - upcoming.length}
                    remedy="Filter by year to reach the rest of the diary."
                  />
                </>
              ) : (
                <div className="mt-8">
                  <EmptyState
                    headingLevel={3}
                    icon={CalendarDays}
                    title="Nothing in the diary yet"
                    description={
                      filtered
                        ? "No event still to come matches these filters. The archive below may."
                        : "The next event will be announced here."
                    }
                  />
                </div>
              )}
            </section>

            {pastTotal > 0 ? (
              <section>
                <SectionHeading
                  level={2}
                  title="Already happened"
                  description={`Events that finished before ${boundary}, most recent first. Photographs and papers from them are on each event's own page.`}
                />

                {/*
                  Either the rows or the "past the end" state, never both: `CardGrid` renders its OWN
                  empty state when it has no children, so leaving it mounted beside this one would print
                  two different explanations of the same blank space.
                */}
                {past.length > 0 ? (
                  <div className="mt-8">
                    <CardGrid columns={3} stagger>
                      {past.map((event) => (
                        <EventListCard
                          key={event.id}
                          event={event}
                          framingMedia={framingMedia}
                          headingLevel={3}
                        />
                      ))}
                    </CardGrid>
                  </div>
                ) : (
                  // A `?page=` past the end of the archive. Its remedy is page one, and saying so is the
                  // difference between a dead end and a dead end with a door.
                  <EmptyState
                    className="mt-8"
                    headingLevel={3}
                    icon={SearchX}
                    title="That page is past the end of the archive"
                    description={`The archive holds ${pastTotal} ${pastTotal === 1 ? NOUN.singular : NOUN.plural}, which is fewer than page ${page} would need.`}
                    action={
                      <LinkButton href={href} variant="secondary">
                        Back to the first page
                      </LinkButton>
                    }
                  />
                )}

                <Reveal as="div" className="mt-10 flex flex-col gap-3">
                  {/* Pagination owns the range sentence. The asymmetry between the two lists is stated
                      here rather than left to be inferred from a page 2 that still opens with the diary. */}
                  <p className="text-sm text-ink-500">
                    These pages walk the archive only. Everything still to come is listed above, whichever
                    page you are on.
                  </p>
                  <Pagination
                    page={page}
                    pageSize={PAST_PAGE_SIZE}
                    totalItems={pastTotal}
                    baseHref={href}
                    label="Past events"
                    itemNoun={NOUN}
                  />
                </Reveal>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * One event, as a card.
 *
 * The date sentence is the eyebrow rather than a line of meta, because for an event the WHEN is the
 * headline fact — a reader scanning the diary is looking for a date first and a title second.
 */
function EventListCard({
  event,
  framingMedia,
  headingLevel
}: {
  event: EventCardRow;
  /** The page's one batched read of the alternate photographs every framing names. */
  framingMedia: Record<string, MediaLike | undefined>;
  headingLevel: 3 | 4;
}) {
  const dates = describeEventDates(event.startsAt, event.endsAt);
  const mode = EVENT_MODES[event.mode];
  // A single band when nobody has framed this cover, which `MediaImage` ignores — so an unframed card is
  // the markup it always was.
  const picture = pictureFromMap(
    event.coverId,
    coverFraming(event),
    withBaseAsset(framingMedia, event.coverId, event.cover)
  );

  return (
    <EntityCard
      href={`/events/${event.slug}`}
      media={event.cover}
      picture={picture}
      variant="cover"
      headingLevel={headingLevel}
      eyebrow={dates.sentence}
      title={event.title}
      description={
        event.summary?.trim()
          ? truncateWords(event.summary, 170)
          : (event.subtitle?.trim() ?? undefined)
      }
      meta={
        <>
          <Badge tone={mode.tone} icon={mode.icon} size="sm">
            {mode.label}
          </Badge>
          {/* The time always carries its zone — a bare "16:00" on a card is the one thing this page is
              written to avoid. */}
          {dates.time ? <span className="tabular-nums">{dates.time}</span> : null}
          {event.venue?.trim() ? <span>{event.venue}</span> : null}
        </>
      }
    />
  );
}
