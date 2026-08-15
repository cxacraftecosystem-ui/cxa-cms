import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Prisma, RegistrationStatus } from "@prisma/client";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CENTRE_TIME_ZONE, centreZoneName, describeEventDates } from "@/components/site/EventDateBlock";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { RegistrationsManager, type RegistrationRow } from "./RegistrationsManager";

/**
 * Who has registered for one event.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COUNTS ARE FOR THE WHOLE EVENT; THE ROWS OBEY THE FILTERS. Those are two different questions and
 * conflating them is what makes a capacity line lie: filter to "waitlisted" and a count taken from the
 * rows on screen would read "0 of 60 places taken". So the counts come from a `groupBy` over every
 * registration and the rows come from a filtered `findMany`.
 *
 * THE ROW LIST IS CAPPED, AND THE CAP IS STATED — on the table and again beside the export, because the
 * export can only contain what was loaded. A spreadsheet that quietly stopped at a thousand rows is the
 * same bug class as a list that quietly stops (contract §1.6).
 *
 * EVERY DATE IS FORMATTED HERE, IN THE CENTRE'S ZONE. The same rule as the rest of the events screens: an
 * event's times mean one instant for everybody, and a date formatted in the browser would differ from the
 * one rendered into the HTML.
 *
 * `notFound()` IS CALLED HERE, so no `loading.tsx` may be added to this segment or above it (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many attendees are loaded at once.
 *
 * High enough that almost every event fits in one screenful of scrolling, low enough that a conference with
 * four thousand registrations does not send four thousand rows to a browser. When it bites, the screen says
 * so and the filters are the way through.
 */
const ROW_CAP = 500;

const STATES: readonly RegistrationStatus[] = [
  "PENDING",
  "CONFIRMED",
  "WAITLISTED",
  "CANCELLED",
  "ATTENDED"
];

const SORT_COLUMNS: Record<string, keyof Prisma.EventRegistrationOrderByWithRelationInput> = {
  name: "name",
  state: "state",
  registered: "createdAt"
};

function firstValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

/** `cache()` so `generateMetadata` and the page body cost one query rather than two. */
const loadEvent = cache(async (id: string) => {
  return prisma.coeEvent.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
      startsAt: true,
      endsAt: true,
      capacity: true,
      isRegistrationOpen: true
    }
  });
});

export async function generateMetadata({
  params
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const event = await loadEvent(id);
  return { title: event ? `Registrations — ${event.title}` : "Event not found" };
}

export default async function StudioEventRegistrationsPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStudioCapability(
    canManageContent,
    "The attendee list needs editor access or higher, because it holds people's names, addresses and telephone numbers. An administrator can raise yours."
  );

  const { id } = await params;
  const event = await loadEvent(id);
  if (!event) notFound();

  const raw = await searchParams;
  const query = firstValue(raw.q).trim();
  const stateRaw = firstValue(raw.state);
  const state = STATES.find((value) => value === stateRaw) ?? null;
  const sortKey = firstValue(raw.sort);
  const direction = firstValue(raw.dir) === "asc" ? "asc" : "desc";

  const where: Prisma.EventRegistrationWhereInput = {
    eventId: event.id,
    ...(state ? { state } : {}),
    ...(query.length > 0
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" as const } },
            { email: { contains: query, mode: "insensitive" as const } },
            { organisation: { contains: query, mode: "insensitive" as const } }
          ]
        }
      : {})
  };

  const column = SORT_COLUMNS[sortKey] ?? "createdAt";
  // A second key so the order is total: two people who registered in the same second would otherwise come
  // back in whatever order the planner chose, and a list that reshuffles looks like data changing.
  const orderBy: Prisma.EventRegistrationOrderByWithRelationInput[] = [
    { [column]: direction } as Prisma.EventRegistrationOrderByWithRelationInput,
    { email: "asc" }
  ];

  /**
   * All four reads in ONE transaction, so the list and the capacity figures below it describe the same
   * instant. Without it, a registration confirmed between two queries makes the table and the sentence
   * above it disagree, which reads as a bug in the count rather than as a race.
   *
   * ⚠ THE INTERACTIVE FORM (a callback), NOT THE ARRAY FORM, and that is a typing constraint rather
   * than a preference. `groupBy` has one of the most elaborate signatures Prisma generates — its return
   * type is inferred from the literal `by` and `_count` arguments through several conditional types.
   * Inside `$transaction([...])` the array's contextual type erases that inference, and `_count` comes
   * back as `true | { id?: number, … } | undefined` instead of a number. In a callback each call sits in
   * an ordinary position and infers correctly.
   *
   * The cost is that these run in sequence rather than in one batched round trip. Four indexed reads on
   * a studio screen is not a figure worth optimising against a type assertion that would hide the shape.
   */
  const { registrationRows, matching, totalRegistrations, grouped } = await prisma.$transaction(
    async (tx) => {
      const registrationRows = await tx.eventRegistration.findMany({
        where,
        orderBy,
        take: ROW_CAP,
        select: {
          id: true,
          name: true,
          email: true,
          organisation: true,
          phone: true,
          notes: true,
          state: true,
          certificateCode: true,
          certificateIssuedAt: true,
          createdAt: true
        }
      });

      const matching = await tx.eventRegistration.count({ where });
      const totalRegistrations = await tx.eventRegistration.count({ where: { eventId: event.id } });

      // Every state's count for the WHOLE event, whatever the filters say — see the header.
      //
      // `_count: true` rather than `_count: { _all: true }`. The nested form asks for a per-column count
      // object; the boolean form counts ROWS IN THE GROUP and types as a plain number, which is the only
      // figure this screen wants.
      const grouped = await tx.eventRegistration.groupBy({
        by: ["state"],
        where: { eventId: event.id },
        _count: true
      });

      return { registrationRows, matching, totalRegistrations, grouped };
    }
  );

  /**
   * A total record, seeded with zeros.
   *
   * `groupBy` returns rows only for states that occur, and a missing key would render as "undefined on the
   * waiting list". Seeding every state means the capacity sentence can always be written.
   */
  const counts: Record<RegistrationStatus, number> = {
    PENDING: 0,
    CONFIRMED: 0,
    WAITLISTED: 0,
    CANCELLED: 0,
    ATTENDED: 0
  };
  for (const entry of grouped) counts[entry.state] = entry._count;

  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: CENTRE_TIME_ZONE
  });

  const rows: RegistrationRow[] = registrationRows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    organisation: row.organisation,
    phone: row.phone,
    notes: row.notes,
    state: row.state,
    certificateCode: row.certificateCode,
    certificateIssuedLabel: row.certificateIssuedAt ? formatter.format(row.certificateIssuedAt) : null,
    registeredLabel: formatter.format(row.createdAt),
    // The raw instant for the spreadsheet, which needs something sortable rather than a sentence.
    registeredIso: row.createdAt.toISOString()
  }));

  const now = new Date();
  const dates = describeEventDates(event.startsAt, event.endsAt);
  const zoneShort = centreZoneName(now);
  const timeZoneLabel = `${centreZoneName(now, "long") || CENTRE_TIME_ZONE}${zoneShort ? ` (${zoneShort})` : ""}`;

  return (
    <div className="mx-auto w-full max-w-[90rem] space-y-6">
      <StudioPageHeader
        title="Registrations"
        back={{ href: `/studio/events/${encodeURIComponent(event.id)}`, label: event.title }}
        breadcrumb={[
          { label: "Events", href: "/studio/events" },
          { label: event.title, href: `/studio/events/${encodeURIComponent(event.id)}` },
          { label: "Registrations" }
        ]}
        description={
          <>
            Everybody who has registered for <span className="font-medium text-ink-700">{event.title}</span>,{" "}
            {dates.sentence}
            {dates.time ? `, ${dates.time}` : ""}. This screen holds people&rsquo;s names, email addresses
            and telephone numbers — treat the export as you would any other list of personal details.
          </>
        }
        meta={
          <>
            <StatusBadge status={event.status} size="sm" />
            <span className="text-xs tabular-nums text-ink-500">
              {totalRegistrations === 1 ? "1 registration" : `${totalRegistrations} registrations`}
            </span>
          </>
        }
      />

      <RegistrationsManager
        eventId={event.id}
        eventTitle={event.title}
        rows={rows}
        // Two different numbers, and the screen needs both: `matching` is what the filters found (what
        // "select all" covers, and what the cap is measured against) and `totalRegistrations` is everybody
        // who has registered.
        totalRegistrations={totalRegistrations}
        matchingCount={matching}
        capped={matching > rows.length}
        cap={ROW_CAP}
        counts={counts}
        capacity={event.capacity}
        filtersActive={query.length > 0 || state !== null}
        timeZoneLabel={timeZoneLabel}
      />
    </div>
  );
}
