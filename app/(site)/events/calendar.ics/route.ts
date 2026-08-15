import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { notFound, parseQuery, route } from "@/lib/api";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import {
  ICS_CONTENT_TYPE,
  buildEventCalendar,
  icsFileName,
  type CalendarEvent
} from "@/lib/ical";
import { getSettingCached } from "@/lib/settings/service";

/**
 * GET /events/calendar.ics — the events feed, and any single event's own file.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE ROUTE, TWO JOBS, BECAUSE THEY MUST NOT DISAGREE. With no query string it answers the whole
 * published calendar, which a reader subscribes to once and then forgets about. With `?event=<slug>`
 * it answers a single VEVENT, which is what the "Add to calendar" control on `/events/[slug]` links
 * to. Both build their file with the same function from `lib/ical.ts`, so an event cannot describe
 * itself one way in the feed and another way in a download — two builders would eventually differ
 * over a UID, and a differing UID is a duplicate entry in somebody's calendar.
 *
 * PAST EVENTS ARE IN THE FEED, DELIBERATELY. A calendar is a record as much as a plan: a subscriber
 * looking back at last spring's symposium, or checking which day a workshop ran on, is asking a
 * question this file can answer and the listing page can only answer by scrolling. Dropping them would
 * also make the feed change under a subscriber — an event they had accepted would vanish from their
 * diary the morning after it happened, which reads as a cancellation, not as tidying up. The `/events`
 * page splits at now; a calendar client does its own splitting.
 *
 * ⚠ THE CAP IS ANNOUNCED IN THE CALENDAR'S OWN NAME. iCalendar has no comment syntax — there is
 * nowhere to write a footnote a person will see — so when the feed stops short, the fact goes in
 * `NAME`/`X-WR-CALNAME`, which every client renders in the sidebar beside the entries, and in the
 * calendar description. Contract §1.6: a list that quietly stops is indistinguishable from a place
 * with no records, and a calendar missing its oldest years quietly is exactly that. The cut is taken
 * from the OLD end (`startsAt: "desc"`, then the cap) because a feed that drops what is coming up is
 * useless in a way that a feed missing 2019 is not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `features.events` gates the whole surface — the listing, every event page and the navigation entry —
 * so it gates this too. A feed that keeps answering after an administrator has taken events off the
 * site is a copy of the calendar still being distributed from an address nobody can see any more.
 *
 * ⚠ THE `.ics` IN THE SEGMENT NAME CANNOT COLLIDE WITH AN EVENT SLUG. A static segment always beats a
 * dynamic sibling (contract §13b), so if an event could be slugged `calendar.ics` its page would be
 * unreachable — it cannot, because `slugify()` reduces everything to `[a-z0-9-]` and a full stop is
 * not in that set.
 *
 * No `assertSameOrigin`: this is a GET, it mutates nothing, and a calendar client subscribing to the
 * feed sends no Origin header at all. Only published, non-deleted events are ever readable —
 * `liveStatusWhere()` is on both queries below.
 */

/**
 * Never prerendered and never cached, matching `/api/public/publications/export`. The answer depends on
 * the query string AND on which events are published at this moment; publication state is resolved at
 * read time (lib/content.ts), so a cached file would keep handing out an event after it was retired.
 * Subscribers are told how often to come back by `REFRESH-INTERVAL` inside the file instead.
 */
export const dynamic = "force-dynamic";

/**
 * How many events one feed carries. Generous — the Centre would have to run one event a week for
 * nearly thirty years to reach it — and it is a real cap rather than a guess at a number nobody will
 * hit, because an unbounded query behind a public URL is a slow denial of service waiting for the
 * archive to grow. When it does bite, the file says so; see the header.
 */
const FEED_LIMIT = 1500;

/**
 * `?event=<slug>` and nothing else. Validated rather than trusted (contract §9) — the value goes into a
 * `where` clause and into the downloaded file's name, and `parseQuery` turns a malformed one into a 422
 * with a sentence instead of a Prisma error.
 */
const querySchema = z.object({
  event: z.string().trim().min(1).max(200).optional()
});

/** Every column `CalendarEvent` needs, and no more. `body` is only read when there is no summary. */
const calendarSelect = {
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
  updatedAt: true
} satisfies Prisma.CoeEventSelect;

function icsResponse(body: string, filename: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": ICS_CONTENT_TYPE,
      // `attachment` so a browser saves the file and hands it to the calendar application rather than
      // painting the raw text on screen. The name comes from `icsFileName`, which slugifies it — a
      // quotation mark from a database row would otherwise break out of this header (lib/ical.ts).
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

export const GET = route(async (request: Request) => {
  const { event: slug } = parseQuery(request, querySchema);

  const [features, branding] = await Promise.all([
    getSettingCached("features"),
    getSettingCached("branding")
  ]);

  if (!features.events) {
    throw notFound("Events are switched off on this site, so there is no calendar to download.");
  }

  /** ONE `now` for every DTSTAMP in the file, and for every "has this finished?" decision inside it. */
  const now = new Date();

  if (slug) {
    const event = await prisma.coeEvent.findFirst({
      where: { slug, ...liveStatusWhere() },
      select: calendarSelect
    });

    // The same answer the event page gives an unknown or unpublished slug: this address holds nothing.
    if (!event) {
      throw notFound("That event is not published, so there is nothing to add to a calendar.");
    }

    const body = buildEventCalendar([event satisfies CalendarEvent], {
      name: `${branding.siteName} — ${event.title}`,
      description: `${event.title}, published by ${branding.siteName}.`,
      now
    });

    return icsResponse(body, icsFileName(event.slug));
  }

  // Two queries rather than `take: FEED_LIMIT + 1`: the second only proves there is more, and the name
  // of the calendar is owed the real number of events that did not fit.
  const [total, events] = await Promise.all([
    prisma.coeEvent.count({ where: liveStatusWhere() }),
    prisma.coeEvent.findMany({
      where: liveStatusWhere(),
      // Newest first, so the cap below drops the oldest. See the header.
      orderBy: { startsAt: "desc" },
      take: FEED_LIMIT,
      select: calendarSelect
    })
  ]);

  const omitted = Math.max(0, total - events.length);

  if (omitted > 0) {
    // Loud on the server as well as in the file, exactly as app/sitemap.ts does with its URL limit: the
    // person who can raise the cap or split the feed does not subscribe to it.
    console.error(
      `[events/calendar.ics] ${total} published events exceeds the ${FEED_LIMIT} the feed carries, so ` +
        `the earliest ${omitted} are not in it. The file says so in its name; the fix is a paged or ` +
        "date-windowed feed."
    );
  }

  const name =
    omitted > 0
      ? `${branding.siteName} events (the earliest ${omitted} are not in this feed)`
      : `${branding.siteName} events`;

  const description =
    omitted > 0
      ? `Every published event, past and future, from ${branding.siteName} — except the earliest ` +
        `${omitted} of ${total}, which this feed does not carry. The full list is on the website.`
      : `Every published event, past and future, from ${branding.siteName}.`;

  return icsResponse(buildEventCalendar(events, { name, description, now }), icsFileName("events"));
});
