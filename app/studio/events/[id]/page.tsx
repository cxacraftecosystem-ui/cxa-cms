import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ExternalLink } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteUrl, storageConfigured } from "@/lib/env";
import { canManageContent } from "@/lib/permissions";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CENTRE_TIME_ZONE, centreZoneName } from "@/components/site/EventDateBlock";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { EventEditor, type AgendaItemValue, type EventValue } from "./EventEditor";

/**
 * The event editor — and, when the address is `/studio/events/new`, the new-event screen.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ `new` IS HANDLED BY THIS ROUTE RATHER THAN BY A SEGMENT OF ITS OWN.
 *
 * The form is identical either way — an event has no child records that must exist before it does, unlike
 * a page and its blocks — so a second route file would be a second copy of every prop, and the copy that
 * gets forgotten is always the one somebody is using. A cuid can never be the word "new", so the two cases
 * can never collide. (`/studio/pages/new` and `/studio/news/new` DO have their own segments, because those
 * screens differ from their editors: a page cannot have blocks until it exists.)
 *
 * TWO GUARDS' WORTH OF WORK IN ONE: `requireStudioCapability(canManageContent)` is the first statement and the
 * same predicate the sidebar and the `/api/studio/events/*` handlers use. It throws rather than rendering
 * a screen of controls that would be refused (contract §1.8).
 *
 * EVERY INSTANT IS HANDED DOWN AS AN ISO STRING, and the zone is handed down beside it. The editor reads
 * and writes every time in the Centre's zone; the LABEL for that zone is built here, on the server,
 * because `Intl`'s zone names depend on the runtime's ICU data and a label computed in the browser could
 * differ from the one rendered into the HTML.
 *
 * `notFound()` IS CALLED HERE, so no `loading.tsx` may be added to this segment or above it: it would
 * flush the status line as `200 OK` before the body is decided (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** How many tag names the editor offers as suggestions. The cap is stated on screen. */
const TAG_SUGGESTION_LIMIT = 60;

/** The address that means "make a new one". See the header. */
const NEW_SEGMENT = "new";

const mediaSelect = {
  objectKey: true,
  width: true,
  height: true,
  altText: true,
  blurDataUrl: true,
  variants: { select: { label: true, format: true, objectKey: true, width: true } }
} as const;

/** `cache()` so `generateMetadata` and the page body cost one query rather than two. */
const loadEvent = cache(async (id: string) => {
  if (id === NEW_SEGMENT) return null;
  return prisma.coeEvent.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      title: true,
      slug: true,
      subtitle: true,
      summary: true,
      body: true,
      mode: true,
      venue: true,
      address: true,
      latitude: true,
      longitude: true,
      onlineUrl: true,
      startsAt: true,
      endsAt: true,
      registrationUrl: true,
      registrationOpensAt: true,
      registrationClosesAt: true,
      capacity: true,
      isRegistrationOpen: true,
      coverId: true,
      status: true,
      publishedAt: true,
      deletedAt: true,
      isFeatured: true,
      cover: { select: mediaSelect },
      agenda: {
        orderBy: { position: "asc" },
        select: { title: true, detail: true, speaker: true, startsAt: true, endsAt: true }
      },
      // `EventSpeaker` carries a `role` and a `position`; the picker only orders people, so the position is
      // what is read back and the role is left to whatever set it. Stated on screen beside the field.
      speakers: { orderBy: { position: "asc" }, select: { personId: true } },
      media: { orderBy: { position: "asc" }, select: { assetId: true } },
      tags: { select: { tag: { select: { name: true } } } },
      _count: { select: { registrations: true } }
    }
  });
});

export async function generateMetadata({
  params
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (id === NEW_SEGMENT) return { title: "New event" };
  const event = await loadEvent(id);
  return { title: event ? event.title : "Event not found" };
}

/** A blank event. Every optional string is `""`, and nothing is guessed — see the note on `startsAt`. */
function blankEvent(): EventValue {
  return {
    title: "",
    slug: "",
    subtitle: "",
    summary: "",
    body: null,
    mode: "IN_PERSON",
    venue: "",
    address: "",
    latitude: null,
    longitude: null,
    onlineUrl: "",
    /**
     * Deliberately empty rather than "tomorrow at ten".
     *
     * A guessed date is a date somebody publishes without reading, and an event announced at the wrong
     * hour is worse than one that refuses to save until the hour is known. The save bar says exactly that.
     */
    startsAt: null,
    endsAt: null,
    registrationUrl: "",
    registrationOpensAt: null,
    registrationClosesAt: null,
    capacity: null,
    isRegistrationOpen: false,
    coverId: null,
    galleryIds: [],
    speakerIds: [],
    tags: [],
    agenda: [],
    status: "DRAFT",
    publishedAt: null,
    isFeatured: false
  };
}

export default async function StudioEventPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireStudioCapability(
    canManageContent,
    "Editing an event needs editor access or higher. An administrator can raise yours."
  );

  const { id } = await params;
  const creating = id === NEW_SEGMENT;
  const event = await loadEvent(id);
  if (!creating && !event) notFound();

  const tagRows = await prisma.tag.findMany({
    // Most used first, so the suggestions are the labels the site actually files under.
    orderBy: [{ events: { _count: "desc" } }, { name: "asc" }],
    take: TAG_SUGGESTION_LIMIT + 1,
    select: { name: true }
  });

  const initial: EventValue = event
    ? {
        title: event.title,
        slug: event.slug,
        // Nullable columns arrive as `""`: a controlled input handed null switches to uncontrolled, and it
        // then stops tracking what is typed into it.
        subtitle: event.subtitle ?? "",
        summary: event.summary ?? "",
        body: event.body as unknown,
        mode: event.mode,
        venue: event.venue ?? "",
        address: event.address ?? "",
        latitude: event.latitude,
        longitude: event.longitude,
        onlineUrl: event.onlineUrl ?? "",
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt?.toISOString() ?? null,
        registrationUrl: event.registrationUrl ?? "",
        registrationOpensAt: event.registrationOpensAt?.toISOString() ?? null,
        registrationClosesAt: event.registrationClosesAt?.toISOString() ?? null,
        capacity: event.capacity,
        isRegistrationOpen: event.isRegistrationOpen,
        coverId: event.coverId,
        galleryIds: event.media.map((entry) => entry.assetId),
        speakerIds: event.speakers.map((entry) => entry.personId),
        tags: event.tags.map((entry) => entry.tag.name),
        agenda: event.agenda.map(
          (item): AgendaItemValue => ({
            title: item.title,
            detail: item.detail ?? "",
            speaker: item.speaker ?? "",
            startsAt: item.startsAt?.toISOString() ?? null,
            endsAt: item.endsAt?.toISOString() ?? null
          })
        ),
        status: event.status,
        publishedAt: event.publishedAt?.toISOString() ?? null,
        isFeatured: event.isFeatured
      }
    : blankEvent();

  const origin = siteUrl().replace(/\/+$/, "");
  const live = event ? isLive(event) : false;
  const now = new Date();
  /**
   * The zone's own name, built here rather than in the browser.
   *
   * `Intl`'s `timeZoneName` depends on the runtime's ICU data, so a label computed on both sides of
   * hydration can differ — and this label is load-bearing: it is the sentence that tells an administrator
   * which clock the date boxes belong to.
   */
  const zoneShort = centreZoneName(now);
  const timeZoneLabel = `${centreZoneName(now, "long") || CENTRE_TIME_ZONE}${zoneShort ? ` (${zoneShort})` : ""}`;

  return (
    <div className="mx-auto w-full max-w-[96rem] space-y-6">
      <StudioPageHeader
        title={creating ? "New event" : event ? event.title : "Event"}
        back={{ href: "/studio/events", label: "Events" }}
        breadcrumb={[
          { label: "Events", href: "/studio/events" },
          { label: creating ? "New event" : (event?.title ?? "Event") }
        ]}
        description={
          creating
            ? `Give the event a title, a date and a place. Every time you type is read as ${timeZoneLabel}, whatever time zone your own computer is in.`
            : undefined
        }
        meta={event ? <StatusBadge status={event.status} size="sm" /> : undefined}
        actions={
          live && event ? (
            <a
              href={`${origin}/events/${event.slug}`}
              target="_blank"
              rel="noreferrer"
              // Opted out of the unsaved-changes guard: a new tab takes neither the reader nor their
              // typing off this screen.
              data-allow-unsaved=""
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
              View on the site
            </a>
          ) : null
        }
      />

      {creating ? (
        <HelpText>
          Nothing is created until you choose &ldquo;Create this event&rdquo;. It starts as a draft, so it
          will not appear on the public site until it is published.
        </HelpText>
      ) : null}

      <EventEditor
        mode={creating ? "create" : "edit"}
        eventId={event?.id ?? null}
        initial={initial}
        initialCover={event?.cover ?? null}
        tagSuggestions={tagRows.slice(0, TAG_SUGGESTION_LIMIT).map((tag) => tag.name)}
        tagSuggestionsTruncated={tagRows.length > TAG_SUGGESTION_LIMIT}
        timeZone={CENTRE_TIME_ZONE}
        timeZoneLabel={timeZoneLabel}
        registrationCount={event?._count.registrations ?? 0}
        user={user}
        storageReady={storageConfigured()}
        siteOrigin={origin}
      />
    </div>
  );
}
