/**
 * /events/[slug] — one event.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY TIME ON THIS PAGE IS THE CENTRE'S TIME, AND THE PAGE SAYS SO.
 *
 * `startsAt` / `endsAt` and every agenda time are absolute instants rendered in the Centre's zone by
 * components/site/EventDateBlock.tsx. The zone is named in full in the date block and again above the
 * programme, because a reader in another country needs to convert and cannot do that from "10:30".
 *
 * ⚠ THE CALENDAR DOWNLOAD IS THE ONE PLACE THAT RULE IS SUSPENDED, AND THE PAGE SAYS SO BESIDE IT. The
 * `.ics` file carries UTC instants (lib/ical.ts), so the reader's own calendar will redraw the event on
 * the reader's clock — correct for a diary entry, and the opposite of what every time above it does. A
 * reader who is not told will read their own 07:00 as a contradiction of the Centre's 10:30 and conclude
 * one of the two is broken. It is a plain `<a href>` to a route handler, never `LinkButton`: the
 * destination answers with a file, and the client router would ask it for an RSC payload.
 *
 * REGISTRATION IS DECIDED HERE, NOT IN THE FORM. This page has the clock, the capacity and the
 * confirmed count; the client component has none of them. It is handed one of five states — not open
 * yet, open, full, closed, finished — so it never renders a form that the route handler is going to
 * refuse. See components/site/EventRegistration.tsx for the whole argument.
 *
 * ⚠ THE COUNT IS AS FRESH AS THE LAST REVALIDATION, AND THAT IS FINE. The page is prerendered and
 * refreshed on a timer, so the last place can go between this render and somebody's submit. The route
 * handler is the authority, and the form renders its refusal sentence verbatim (lib/api.ts guarantees
 * `message` is a plain human sentence). What the page must never do is show a form when registration is
 * definitely shut — a state that does not change on a timer.
 *
 * NO DOWNLOADS BLOCK. `CoeEvent` has no relation to `FileAsset` in prisma/schema.prisma — only
 * `Project` does (`ProjectFile`). Rather than guess at a join by matching a category string, there is
 * no downloads section; papers and slide decks reach this page through the description or through a
 * project. If event attachments are wanted, they need a relation first.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `features.events` gates the whole surface, matching what the setting promises: with it off, the
 * listing, the event pages and the navigation entry all go. `features.eventRegistration` gates only the
 * form, and switching it off is reported as a closed registration with a reason rather than as a
 * silently missing block.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { ArrowLeft, CalendarPlus, Images, MapPin, Video } from "lucide-react";

import { Reveal } from "@/components/motion";
import { DefinitionList, type DefinitionItem } from "@/components/site/DefinitionList";
import {
  EVENT_MODES,
  EventDateBlock,
  centreZoneName,
  describeEventDates,
  eventPhase,
  formatCentreDate,
  formatCentreTime,
  formatCentreTimeWithZone
} from "@/components/site/EventDateBlock";
import {
  EventRegistration,
  type RegistrationState
} from "@/components/site/EventRegistration";
import {
  LightboxTrigger,
  MediaLightboxProvider,
  type LightboxItem
} from "@/components/site/MediaLightbox";
import { PageHero } from "@/components/site/PageHero";
import { ProseArticle } from "@/components/site/ProseArticle";
import { SectionHeading } from "@/components/site/SectionHeading";
import { ShareRow } from "@/components/site/ShareRow";
import { TagList } from "@/components/site/TagList";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { MediaImage } from "@/components/ui/MediaImage";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { eventCalendarHref } from "@/lib/ical";
import { MEDIA_FIGURE_SELECT, MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { ogImageUrl } from "@/lib/media/url";
import { mailerConfigured } from "@/lib/newsletter/delivery";
import { richTextExcerpt, parseRichText } from "@/lib/richtext";
import { absoluteUrl, eventJsonLd, pageMetadata, serializeJsonLd } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { prerenderParams } from "@/lib/prerender";

/** Five minutes: short enough that "under way now" and the remaining places are close to true. */
export const revalidate = 300;

/**
 * How many events are prerendered at build time. A BUDGET, NOT A TRUNCATION — `dynamicParams` defaults
 * to true, so an event outside the window renders on its first request and is cached from then on.
 */
const PRERENDER_LIMIT = 300;

/**
 * Everything `<MediaImage>` needs, named locally because four selects in this file want it. The list
 * itself comes from lib/media/select.ts — a hand-written copy is how the crop columns came to be stored
 * and never rendered. `variants` is not optional — see components/ui/MediaImage.tsx.
 */
const MEDIA_SELECT = MEDIA_IMAGE_SELECT satisfies Prisma.MediaAssetSelect;

const eventSelect = {
  id: true,
  slug: true,
  title: true,
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
  publishedAt: true,
  updatedAt: true,
  cover: { select: MEDIA_SELECT },
  agenda: {
    // `position` is what the editor arranged; `startsAt` only breaks ties, so a programme with no times
    // still keeps the order somebody dragged it into.
    orderBy: [{ position: "asc" }, { startsAt: "asc" }],
    select: { id: true, title: true, detail: true, speaker: true, startsAt: true, endsAt: true }
  },
  speakers: {
    orderBy: { position: "asc" },
    select: {
      role: true,
      /**
       * `status` and `isVisible` come along so the page can decide whether to LINK a speaker rather
       * than whether to SHOW them. A speaker whose `Person` row is unpublished is still a fact about
       * the event — dropping the name would make the programme quietly incomplete — but linking to a
       * page that 404s is worse than not linking at all.
       */
      person: {
        select: {
          slug: true,
          name: true,
          designation: true,
          department: true,
          status: true,
          isVisible: true,
          deletedAt: true,
          photo: { select: MEDIA_SELECT }
        }
      }
    }
  },
  media: {
    orderBy: { position: "asc" },
    select: {
      assetId: true,
      caption: true,
      asset: { select: MEDIA_FIGURE_SELECT }
    }
  },
  tags: {
    orderBy: { tag: { name: "asc" } },
    select: { tag: { select: { slug: true, name: true } } }
  }
} satisfies Prisma.CoeEventSelect;

/** Registrations that occupy a place. A cancelled one has given its seat back; a waitlisted one never
 *  had it. Counting either would close an event that still has room. */
const OCCUPYING_STATES = ["PENDING", "CONFIRMED", "ATTENDED"] as const;

export async function generateStaticParams() {
  // Wrapped so an unreachable database at BUILD time does not fail the deploy — see
  // lib/prerender.ts for why an empty list is a complete fallback here and not a swallowed error.
  return prerenderParams("events/[slug]", async () => {
    const events = await prisma.coeEvent.findMany({
      where: liveStatusWhere(),
      orderBy: { startsAt: "desc" },
      take: PRERENDER_LIMIT,
      select: { slug: true }
    });
    return events.map((event) => ({ slug: event.slug }));
  });
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const event = await prisma.coeEvent.findFirst({
    where: { slug, ...liveStatusWhere() },
    select: {
      title: true,
      subtitle: true,
      summary: true,
      body: true,
      startsAt: true,
      endsAt: true,
      venue: true,
      publishedAt: true,
      updatedAt: true,
      cover: { select: MEDIA_SELECT }
    }
  });

  if (!event) {
    return pageMetadata({ title: "Event not found", path: `/events/${slug}`, noIndex: true });
  }

  const dates = describeEventDates(event.startsAt, event.endsAt);
  const description =
    event.summary?.trim() ||
    event.subtitle?.trim() ||
    richTextExcerpt(parseRichText(event.body), 200) ||
    // A date and a place is a better share card than nothing at all, and for many seminars it is
    // genuinely all the record holds.
    `${dates.sentence}${event.venue?.trim() ? ` · ${event.venue}` : ""}`;

  return pageMetadata({
    title: event.title,
    description,
    path: `/events/${slug}`,
    image: event.cover,
    type: "article",
    publishedTime: event.publishedAt,
    modifiedTime: event.updatedAt
  });
}

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const [features, branding] = await Promise.all([
    getSettingCached("features"),
    getSettingCached("branding")
  ]);
  if (!features.events) notFound();

  const event = await prisma.coeEvent.findFirst({
    where: { slug, ...liveStatusWhere() },
    select: eventSelect
  });

  // A missing row and an unpublished one are the same answer to a reader: this address holds nothing.
  if (!event) notFound();

  /**
   * ONE `now` for every date-dependent statement on the page — the phase badge, the registration state,
   * the wording of the gallery heading. Two `new Date()` calls a millisecond apart could produce a page
   * that says an event has finished and offers a place at it.
   */
  const now = new Date();
  const phase = eventPhase(event.startsAt, event.endsAt, now);
  const dates = describeEventDates(event.startsAt, event.endsAt);
  const mode = EVENT_MODES[event.mode];
  const path = `/events/${event.slug}`;

  /**
   * Does this event take registrations at all?
   *
   * A "Registration is closed" panel on a public lecture that never took bookings is noise dressed as
   * information. The block is rendered only when the record carries some registration intent.
   */
  const offersRegistration =
    event.isRegistrationOpen ||
    event.capacity !== null ||
    event.registrationOpensAt !== null ||
    event.registrationClosesAt !== null ||
    Boolean(event.registrationUrl?.trim());

  // Only counted when there is a capacity to compare it against. Without one, "full" is not a state this
  // event can be in and the query would be a round trip for a number nothing reads.
  const taken =
    offersRegistration && event.capacity !== null
      ? await prisma.eventRegistration.count({
          where: { eventId: event.id, state: { in: [...OCCUPYING_STATES] } }
        })
      : 0;

  /**
   * Whether the copy in the registration panel may promise an email — decided HERE, like the five
   * states below, because the client component must never guess. It is read from the mail seam
   * (lib/newsletter/delivery.ts), the same way app/studio/users/page.tsx hands `canSendEmail` to its
   * screen: the bare boolean crosses to the client, never a provider name or any other fact about the
   * environment. Until an adapter is registered from `instrumentation.ts` this is false in every
   * process, and the form's copy says a registration is RECORDED rather than promising a message
   * nothing can send.
   *
   * ⚠ AS FRESH AS THE LAST REVALIDATION, and wrong only in the safe direction: a build rendered before
   * the mailer registers under-promises for at most one revalidation window, which is honest; the
   * reverse — promising an email on a deployment that cannot send one — is the defect this exists to
   * prevent.
   */
  const canSendEmail = mailerConfigured();

  let registrationState: RegistrationState = "open";
  let waitlist = false;
  let placesLeft: number | null = null;
  let closedNote: string | null = null;

  if (phase === "finished") {
    registrationState = "finished";
  } else if (!features.eventRegistration) {
    registrationState = "closed";
    // Said out loud: an absent form with no explanation reads as a broken page, and the person who can
    // fix it is the administrator who switched the feature off.
    closedNote = "Registration is switched off across the site at the moment.";
  } else if (event.registrationOpensAt && event.registrationOpensAt.getTime() > now.getTime()) {
    registrationState = "not-open";
  } else if (event.registrationClosesAt && event.registrationClosesAt.getTime() <= now.getTime()) {
    registrationState = "closed";
  } else if (!event.isRegistrationOpen) {
    registrationState = "closed";
  } else if (event.capacity !== null && taken >= event.capacity) {
    registrationState = "full";
    // A full event still records arrivals, as WAITLISTED — the copy promises a place on the list and
    // nothing more, because that is all the route handler can honour.
    waitlist = true;
  } else {
    registrationState = "open";
    if (event.capacity !== null) placesLeft = Math.max(0, event.capacity - taken);
  }

  const gallery: LightboxItem[] = event.media.map((item) => ({
    id: item.assetId,
    objectKey: item.asset.objectKey,
    width: item.asset.width,
    height: item.asset.height,
    altText: item.asset.altText,
    blurDataUrl: item.asset.blurDataUrl,
    // Copied across one by one because this object is hand-built: an omitted crop column here would lose
    // the editor's rectangle again, one layer above the select.
    cropX: item.asset.cropX,
    cropY: item.asset.cropY,
    cropWidth: item.asset.cropWidth,
    cropHeight: item.asset.cropHeight,
    variants: item.asset.variants,
    // The PLACEMENT's caption wins over the asset's: the same photograph carries a different caption in
    // an album than it does on an event page.
    caption: item.caption ?? item.asset.caption,
    credit: item.asset.credit
  }));

  const tags = event.tags.map((link) => ({
    label: link.tag.name,
    href: `/news/tag/${link.tag.slug}`
  }));

  const showOnlineLink =
    phase !== "finished" && Boolean(event.onlineUrl?.trim()) && event.mode !== "IN_PERSON";

  const details: DefinitionItem[] = [
    { term: "Format", value: mode.label },
    { term: "Venue", value: event.venue },
    { term: "Address", value: event.address },
    ...(event.latitude !== null && event.longitude !== null
      ? [
          {
            term: "On a map",
            value: "Open the location",
            // OpenStreetMap needs no key and no consent banner. The coordinates are the Centre's own
            // data, so nothing about the reader is sent anywhere by rendering the link — only by
            // following it.
            href: `https://www.openstreetmap.org/?mlat=${event.latitude}&mlon=${event.longitude}#map=17/${event.latitude}/${event.longitude}`
          }
        ]
      : []),
    ...(showOnlineLink && event.onlineUrl
      ? [{ term: "Joining link", value: "Open the online room", href: event.onlineUrl }]
      : []),
    {
      term: "Capacity",
      // `0` would be a value, not an absence, which is why DefinitionList tests for null rather than
      // falsiness — a capacity of 0 is a data error worth seeing rather than hiding.
      value: event.capacity !== null ? `${event.capacity} places` : null,
      note:
        event.capacity !== null && phase !== "finished"
          ? `${taken} taken as of the last update to this page`
          : undefined
    }
  ];

  const jsonLd = eventJsonLd({
    title: event.title,
    description: event.summary?.trim() || event.subtitle?.trim() || null,
    path,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    venue: event.venue,
    address: event.address,
    onlineUrl: event.onlineUrl,
    mode: event.mode,
    imageUrl: ogImageUrl(event.cover),
    organiserName: branding.siteName
  });

  const zoneShort = centreZoneName(event.startsAt);
  const zoneLong = centreZoneName(event.startsAt, "long");

  /**
   * What the calendar download actually does, in sentences.
   *
   * ⚠ THE ZONE SENTENCE IS THE POINT OF THIS PARAGRAPH, not politeness. Every time on this page is the
   * Centre's; the times inside the file are absolute instants, so a subscriber in London sees 07:00
   * where the page says 12:30. Both are right, and a reader told neither will assume one is a bug.
   *
   * The other two clauses exist because the file is not a faithful copy of the panel above it: a
   * multi-day event loses its clock to an all-day span (lib/ical.ts writes the hours into the entry's
   * notes instead), and a finished event still downloads, landing in the past rather than the diary.
   */
  const calendarNote = [
    "Downloads a small .ics file holding this one event, which Apple Calendar, Outlook, Google " +
      "Calendar and Thunderbird all open.",
    `It records the exact instants rather than the wording above, so your own calendar will redraw ` +
      `the event on your clock — the times on this page are ${zoneLong}` +
      `${zoneShort ? ` (${zoneShort})` : ""}, the Centre's own.`,
    dates.multiDay
      ? // Deliberately "the times" rather than "the opening and closing times": a record whose end
        // precedes its start gets a different, franker sentence from lib/ical.ts, and this line must not
        // promise something the file will not contain.
        "Because the record covers more than one day it is entered as an all-day span rather than a " +
        "timed block, with the times written into the entry's notes."
      : "",
    phase === "finished"
      ? "This event has already finished, so the entry lands in the past — useful as a record, not as a " +
        "reminder."
      : ""
  ]
    .filter((sentence) => sentence.length > 0)
    .join(" ");

  return (
    <>
      <script
        type="application/ld+json"
        // `serializeJsonLd` escapes `<`, `>` and `&` so a title containing "</script>" cannot close this
        // element early and have the rest of the page parsed as HTML (lib/seo.ts).
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      <PageHero
        eyebrow="Event"
        title={event.title}
        description={event.subtitle ?? undefined}
        media={event.cover}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Events", href: "/events" },
          { name: event.title, href: path }
        ]}
        meta={
          <>
            <Badge tone={mode.tone} icon={mode.icon} size="sm">
              {mode.label}
            </Badge>
            <time dateTime={event.startsAt.toISOString()}>{dates.sentence}</time>
            {dates.time ? <span className="tabular-nums">{dates.time}</span> : null}
            {event.venue?.trim() ? <span>{event.venue}</span> : null}
          </>
        }
      />

      <div className="shell pb-24">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-16">
          <div className="flex min-w-0 flex-col gap-14">
            {/*
              THE "WHEN" PANEL AND THE CALENDAR DOWNLOAD ARE ONE GROUP, held at a tighter gap than the
              column's own. The download is something to do with the dates immediately beside it; pushed
              3.5rem down by the column's `gap-14` it would read as an unrelated action further along the
              page, which is how a control ends up never being seen.
            */}
            <div className="flex flex-col gap-4">
              <EventDateBlock startsAt={event.startsAt} endsAt={event.endsAt} phase={phase} />

              <div>
                {/*
                  A PLAIN `<a>`, NEVER `LinkButton` OR `next/link`. `/events/calendar.ics` is a route
                  handler that answers with a file and `Content-Disposition: attachment`; the client
                  router would ask it for an RSC payload and get iCalendar text, and `next/link` would
                  prefetch a deliberately uncached database read on hover. Being a bare anchor is also
                  what makes it work with no JavaScript at all.

                  The href comes from `eventCalendarHref` rather than being spelled out here, because
                  nothing typechecks a route-handler path (contract §13b) and one spelling cannot drift
                  from the route the way two can.
                */}
                <a href={eventCalendarHref(event.slug)} className="field-button-secondary">
                  <CalendarPlus aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span>Add this event to your calendar</span>
                </a>

                <p className="prose-measure mt-2.5 text-xs leading-relaxed text-ink-500">
                  {calendarNote}
                </p>
              </div>
            </div>

            <section>
              <SectionHeading level={2} title="About this event" />
              <div className="mt-6">
                {/*
                  ONE RENDERER, AND THERE IS NO SECOND BRANCH TO CHOOSE FROM: `CoeEvent` has no `mdx`
                  column (only `Post` does), so this is always the Tiptap document in `body` rendered by
                  `RichText`. The summary stands in when the body is empty, which for a seminar announced
                  in two lines is the usual case rather than an error.
                */}
                <ProseArticle
                  value={event.body}
                  fallback={
                    event.summary?.trim() ? (
                      <p className="text-base leading-relaxed text-ink-700">{event.summary}</p>
                    ) : (
                      <p className="text-base leading-relaxed text-ink-500">
                        No description has been published for this event yet. The dates and the venue
                        above are the whole of the record.
                      </p>
                    )
                  }
                />
              </div>
            </section>

            {event.agenda.length > 0 ? (
              <section>
                <SectionHeading
                  level={2}
                  title="Programme"
                  description={`Session times are in ${zoneLong}${zoneShort ? ` (${zoneShort})` : ""}.`}
                />

                {/* An ordered list, because the programme has an order and "list, 9 items" is the
                    fastest way to know how long the day is. */}
                <ol className="mt-6 divide-y divide-line-200 border-t border-line-200">
                  {event.agenda.map((item) => {
                    const from = item.startsAt ? formatCentreTime(item.startsAt) : null;
                    const to = item.endsAt ? formatCentreTime(item.endsAt) : null;
                    // A session on a different day from the event's opening needs its date as well, or
                    // "09:30" on day three reads as day one.
                    const sameDay =
                      item.startsAt === null ||
                      formatCentreDate(item.startsAt) === formatCentreDate(event.startsAt);

                    return (
                      <li key={item.id} className="flex flex-col gap-3 py-5 sm:flex-row sm:gap-6">
                        <p className="shrink-0 text-sm tabular-nums text-ink-500 sm:w-36">
                          {from ? (
                            <time dateTime={item.startsAt?.toISOString()}>
                              {to && to !== from ? `${from}–${to}` : from}
                            </time>
                          ) : (
                            // Not an em dash in a time column: a session with no time is a session
                            // whose time has not been decided, and saying so is shorter than a symbol
                            // a reader has to interpret.
                            <span className="text-ink-300">Time to be confirmed</span>
                          )}
                          {!sameDay && item.startsAt ? (
                            <span className="mt-0.5 block text-xs">
                              {formatCentreDate(item.startsAt)}
                            </span>
                          ) : null}
                        </p>

                        <div className="min-w-0 flex-1">
                          <h3 className="display-title text-base leading-snug">{item.title}</h3>
                          {item.speaker?.trim() ? (
                            <p className="mt-1 text-sm text-ink-700">{item.speaker}</p>
                          ) : null}
                          {item.detail?.trim() ? (
                            <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-500">
                              {item.detail}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}

            {event.speakers.length > 0 ? (
              <section>
                <SectionHeading level={2} title="Speakers" />

                <ul className="mt-6 grid gap-6 sm:grid-cols-2">
                  {event.speakers.map((entry) => {
                    const person = entry.person;
                    // Linkable only when the profile is genuinely public. See the select for why an
                    // unpublished speaker is still named.
                    const linkable =
                      person.deletedAt === null && person.isVisible && person.status === "PUBLISHED";

                    return (
                      <li
                        key={person.slug}
                        className="flex items-start gap-4 rounded-lg border border-line-200 bg-card p-4"
                      >
                        {person.photo ? (
                          <MediaImage
                            media={person.photo}
                            // Decorative: the name is spelled out immediately beside it, and
                            // "photograph of Anita Rao, Anita Rao" is one announcement too many.
                            alt=""
                            aspect={1}
                            rounded="full"
                            sizes="64px"
                            targetWidth={320}
                            className="h-14 w-14 shrink-0 border border-line-200"
                          />
                        ) : null}

                        <div className="min-w-0">
                          <h3 className="display-title text-base leading-snug">
                            {linkable ? (
                              <Link
                                href={`/people/${person.slug}`}
                                className="rounded transition-colors hover:text-purple-700"
                              >
                                {person.name}
                              </Link>
                            ) : (
                              person.name
                            )}
                          </h3>
                          {entry.role?.trim() ? (
                            <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-purple-700">
                              {entry.role}
                            </p>
                          ) : null}
                          {person.designation?.trim() ? (
                            <p className="mt-1 text-sm leading-snug text-ink-500">
                              {person.designation}
                              {person.department?.trim() ? `, ${person.department}` : ""}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {gallery.length > 0 ? (
              <section>
                <SectionHeading
                  level={2}
                  title={phase === "finished" ? "From the event" : "Pictures"}
                  description={
                    phase === "finished"
                      ? "Photographs taken on the day."
                      : "Pictures published with the announcement."
                  }
                />

                {/*
                  The grid stays on the SERVER. `MediaLightboxProvider` holds which picture is open and
                  takes the already-rendered thumbnails as children, so `next/image` and every caption
                  are not shipped to the browser for the sake of one click handler
                  (components/site/MediaLightbox.tsx).
                */}
                <MediaLightboxProvider items={gallery} label={event.title}>
                  <ul className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
                    {gallery.map((item, index) => {
                      const described = item.altText?.trim() || item.caption?.trim() || "";
                      return (
                        <li key={item.id}>
                          {/*
                            THE TRIGGER IS AN OVERLAY AND THE DOM ORDER IS LOAD-BEARING: the picture
                            first, the button after it. `MediaImage` renders a positioned frame and
                            nothing here carries a z-index, so a button declared BEFORE the picture
                            would be painted over by it and a press would hit nothing.
                          */}
                          <div className="group relative overflow-hidden rounded-md bg-surface-100">
                            <MediaImage
                              media={item}
                              aspect="4 / 3"
                              rounded="none"
                              sizes="(min-width: 768px) 20vw, 45vw"
                              className="w-full"
                              imageClassName="transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                            />
                            <LightboxTrigger
                              index={index}
                              label={
                                described
                                  ? `Open image ${index + 1} of ${gallery.length} full screen: ${described}`
                                  : `Open image ${index + 1} of ${gallery.length} full screen`
                              }
                              className="absolute inset-0 h-full w-full"
                            />
                          </div>

                          {item.caption ? (
                            <p className="mt-2 text-xs leading-relaxed text-ink-500">
                              {item.caption}
                              {item.credit ? (
                                <span className="text-ink-300"> — {item.credit}</span>
                              ) : null}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </MediaLightboxProvider>
              </section>
            ) : null}
          </div>

          {/* The rail. Registration first — it is the one thing on this page a reader may need to act
              on, and burying it under the facts would put a decision below a description. */}
          <aside className="flex min-w-0 flex-col gap-10">
            {offersRegistration ? (
              <section>
                <SectionHeading level={2} title="Registration" titleClassName="sr-only" />
                <EventRegistration
                  slug={event.slug}
                  eventTitle={event.title}
                  state={registrationState}
                  opensOn={
                    event.registrationOpensAt
                      ? `${formatCentreDate(event.registrationOpensAt)} at ${formatCentreTimeWithZone(event.registrationOpensAt)}`
                      : null
                  }
                  closesOn={
                    event.registrationClosesAt
                      ? `${formatCentreDate(event.registrationClosesAt)} at ${formatCentreTimeWithZone(event.registrationClosesAt)}`
                      : null
                  }
                  waitlist={waitlist}
                  capacity={event.capacity}
                  placesLeft={placesLeft}
                  externalUrl={event.registrationUrl}
                  note={closedNote}
                  canSendEmail={canSendEmail}
                />
              </section>
            ) : null}

            <section>
              <SectionHeading level={2} title="Details" titleClassName="text-xl" />
              <div className="mt-5">
                <DefinitionList items={details} />
              </div>

              {showOnlineLink && event.onlineUrl ? (
                <div className="mt-6">
                  <LinkButton href={event.onlineUrl} icon={Video} newTab variant="secondary">
                    Join online
                  </LinkButton>
                </div>
              ) : null}

              {event.address?.trim() && event.mode !== "ONLINE" ? (
                <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-ink-500">
                  <MapPin aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Arrive a few minutes early — the address above is the building, not the room.
                  </span>
                </p>
              ) : null}
            </section>

            {tags.length > 0 ? (
              <section>
                <SectionHeading level={2} title="Topics" titleClassName="text-xl" />
                {/* The chips point at the NEWSROOM archive for the topic: `Tag` is shared between posts
                    and events (prisma/schema.prisma), and the news archive is the page that exists for
                    one. That page links onward to the events carrying the same tag. */}
                <TagList tags={tags} label="Topics" className="mt-4" />
              </section>
            ) : null}

            <section>
              <SectionHeading level={2} title="Share" titleClassName="text-xl" />
              <ShareRow
                className="mt-4"
                url={absoluteUrl(path)}
                title={event.title}
                text={event.summary?.trim() || dates.sentence}
                label="Share this event"
              />
            </section>
          </aside>
        </div>

        <Reveal as="div" className="mt-16 flex flex-wrap gap-3">
          <LinkButton href="/events" variant="secondary" icon={ArrowLeft}>
            All events
          </LinkButton>
          {phase === "finished" ? (
            <LinkButton href="/gallery" variant="ghost" icon={Images}>
              Browse the photograph albums
            </LinkButton>
          ) : null}
        </Reveal>
      </div>
    </>
  );
}
