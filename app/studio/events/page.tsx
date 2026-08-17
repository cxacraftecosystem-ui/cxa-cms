import type { Metadata } from "next";
import { CalendarPlus } from "lucide-react";
import type { ContentStatus, EventMode, Prisma, RegistrationStatus } from "@prisma/client";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/env";
import { framingAssets, withBaseAsset } from "@/lib/media/framing";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { pictureFromMap, type ScreenFraming } from "@/lib/media/screens";
import { canManageContent, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { CENTRE_TIME_ZONE, centreZoneName, describeEventDates, eventPhase } from "@/components/site/EventDateBlock";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { EventsTable, type StudioEventRow } from "./EventsTable";

/**
 * The events list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageContent)` — the same predicate `StudioNav` hides the sidebar entry with and
 * the `/api/studio/events/*` handlers enforce. A sidebar offering a screen the screen then refuses is the
 * failure contract §1.7 exists to prevent.
 *
 * THE DATES ARE FORMATTED HERE, WITH THE SAME FUNCTION THE PUBLIC EVENT PAGES USE. `describeEventDates`
 * lives in `components/site/EventDateBlock` and reads every instant in the CENTRE's zone; formatting in
 * the browser instead would mean the studio and the site disagreeing about what day an event is on, and
 * a hydration mismatch on top.
 *
 * "STILL TO COME" MEANS NOT YET FINISHED, and it is the same rule in the filter and in the badge:
 * `(endsAt ?? startsAt) >= now`. Using `startsAt` alone would file a three-day conference as finished on
 * its first evening, which is the point at which most people are still deciding whether to attend the rest.
 *
 * THE REGISTRATION NUMBERS ARE ONE `groupBy`, NOT ONE QUERY PER ROW. Three different counts are needed per
 * event — everybody, the people holding a place, and the waiting list — and asking per event would be
 * seventy-five round trips for a page of twenty-five.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Events"
};

const PAGE_SIZE = 25;

const STATUSES: readonly ContentStatus[] = [
  "DRAFT",
  "IN_REVIEW",
  "SCHEDULED",
  "PUBLISHED",
  "ARCHIVED"
];

const MODES: readonly EventMode[] = ["IN_PERSON", "ONLINE", "HYBRID"];

const SORT_COLUMNS: Record<string, keyof Prisma.CoeEventOrderByWithRelationInput> = {
  title: "title",
  status: "status",
  starts: "startsAt"
};

/** The states that hold a place. A cancelled registration frees one; a pending one has not claimed one. */
const HOLDING_STATES: readonly RegistrationStatus[] = ["CONFIRMED", "ATTENDED"];

function firstValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

export default async function StudioEventsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canManageContent,
    "Events need editor access or higher. An administrator can raise yours."
  );

  const raw = await searchParams;
  const query = firstValue(raw.q).trim();
  const statusRaw = firstValue(raw.status);
  const status = STATUSES.find((value) => value === statusRaw) ?? null;
  const modeRaw = firstValue(raw.mode);
  const mode = MODES.find((value) => value === modeRaw) ?? null;
  const when = firstValue(raw.when);
  const sortKey = firstValue(raw.sort);
  const direction = firstValue(raw.dir) === "asc" ? "asc" : "desc";
  const requestedPage = Number.parseInt(firstValue(raw.page), 10);
  const currentPage = Number.isFinite(requestedPage) && requestedPage > 1 ? requestedPage : 1;

  const now = new Date();

  /**
   * "Not yet finished" and its exact negation, spelled out rather than written as a `NOT`.
   *
   * An event with no `endsAt` finishes when it starts, so both halves need the null case. Writing one of
   * them as `NOT` of the other would leave rows with a null `endsAt` matching neither filter, and an event
   * would vanish from both lists with nothing on screen to explain it.
   */
  const unfinished: Prisma.CoeEventWhereInput = {
    OR: [{ endsAt: { gte: now } }, { endsAt: null, startsAt: { gte: now } }]
  };
  const finished: Prisma.CoeEventWhereInput = {
    OR: [{ endsAt: { lt: now } }, { endsAt: null, startsAt: { lt: now } }]
  };

  const where: Prisma.CoeEventWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(mode ? { mode } : {}),
    ...(when === "upcoming" ? unfinished : when === "past" ? finished : {}),
    ...(query.length > 0
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" as const } },
            { subtitle: { contains: query, mode: "insensitive" as const } },
            { venue: { contains: query, mode: "insensitive" as const } },
            { address: { contains: query, mode: "insensitive" as const } },
            { slug: { contains: query, mode: "insensitive" as const } }
          ]
        }
      : {})
  };

  const column = SORT_COLUMNS[sortKey] ?? "startsAt";
  // A second key so the order is total — two events on the same day would otherwise come back in whatever
  // order the planner chose, and a list that reshuffles between requests looks like data changing.
  const orderBy: Prisma.CoeEventOrderByWithRelationInput[] = [
    { [column]: direction } as Prisma.CoeEventOrderByWithRelationInput,
    { title: "asc" }
  ];

  const [total, eventRows] = await prisma.$transaction([
    prisma.coeEvent.count({ where }),
    prisma.coeEvent.findMany({
      where,
      orderBy,
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
        publishedAt: true,
        deletedAt: true,
        isFeatured: true,
        mode: true,
        venue: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        isRegistrationOpen: true,
        // The cover's id and its framing beside the photograph. `coverId` because a framing resolves the
        // base picture BY ID (lib/media/screens.ts), and `coverScreens` because a list that fetched the
        // picture without its framing would show every framed cover unframed on this screen alone.
        coverId: true,
        coverScreens: true,
        cover: { select: MEDIA_IMAGE_SELECT }
      }
    })
  ]);

  const eventIds = eventRows.map((row) => row.id);

  const registrationCounts =
    eventIds.length === 0
      ? []
      : await prisma.eventRegistration.groupBy({
          by: ["eventId", "state"],
          where: { eventId: { in: eventIds } },
          _count: { _all: true }
        });

  const tally = new Map<string, { all: number; holding: number; waiting: number }>();
  for (const entry of registrationCounts) {
    const current = tally.get(entry.eventId) ?? { all: 0, holding: 0, waiting: 0 };
    const count = entry._count._all;
    current.all += count;
    if (HOLDING_STATES.includes(entry.state)) current.holding += count;
    if (entry.state === "WAITLISTED") current.waiting += count;
    tally.set(entry.eventId, current);
  }

  const mayPublish = canPublish(user);

  /**
   * The alternate covers the shown framings name, in ONE query.
   *
   * Unconditional, because it costs NO query at all when nobody has framed a cover, which is the common
   * case — guarding it per row is how one row ends up guarded wrongly (lib/media/framing.ts). The cast is
   * deliberate: `Prisma.JsonValue` carries no shape, this studio's own route validates the value with
   * `screenFramingField()` on the way in, and the resolver reads every bucket defensively.
   */
  const framings = eventRows.map((row) => (row.coverScreens ?? null) as unknown as ScreenFraming | null);
  const framingMedia = await framingAssets(...framings);

  const rows: StudioEventRow[] = eventRows.map((row, index) => {
    const dates = describeEventDates(row.startsAt, row.endsAt);
    const counts = tally.get(row.id) ?? { all: 0, holding: 0, waiting: 0 };
    const live = isLive(row, now);

    return {
      id: row.id,
      title: row.title,
      path: `/events/${row.slug}`,
      status: row.status,
      isLive: live,
      isFeatured: row.isFeatured,
      mode: row.mode,
      whenLabel: dates.sentence,
      timeLabel: dates.time,
      phase: eventPhase(row.startsAt, row.endsAt, now),
      place:
        row.mode === "ONLINE"
          ? "Online only"
          : (row.venue?.trim().length ?? 0) > 0
            ? (row.venue ?? "")
            : "No venue set yet",
      cover: row.cover,
      // One band when nobody framed this cover, which `MediaImage` ignores — so an unframed thumbnail
      // draws exactly as it did before the column existed.
      picture: pictureFromMap(
        row.coverId,
        framings[index],
        withBaseAsset(framingMedia, row.coverId, row.cover)
      ),
      registrationCount: counts.all,
      placesTaken: counts.holding,
      waitlistCount: counts.waiting,
      capacity: row.capacity,
      isRegistrationOpen: row.isRegistrationOpen,
      // Deleting is stricter than editing, and taking a live event off the site is a publishing act.
      canDelete: canManageContent(user) && (!live || mayPublish)
    };
  });

  return (
    <div className="mx-auto w-full max-w-[90rem] space-y-6">
      <StudioPageHeader
        title="Events"
        description="Seminars, workshops and conferences, their programmes, their speakers and the people who have registered. Every time on these screens is the Centre's own time."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 event" : `${total} events`}
          </span>
        }
        actions={
          <LinkButton href="/studio/events/new" icon={CalendarPlus}>
            New event
          </LinkButton>
        }
      />

      <EventsTable
        rows={rows}
        total={total}
        page={currentPage}
        pageSize={PAGE_SIZE}
        siteOrigin={siteUrl().replace(/\/+$/, "")}
        filtersActive={query.length > 0 || status !== null || mode !== null || when.length > 0}
        timeZoneLabel={centreZoneName(now, "long") || CENTRE_TIME_ZONE}
      />
    </div>
  );
}
