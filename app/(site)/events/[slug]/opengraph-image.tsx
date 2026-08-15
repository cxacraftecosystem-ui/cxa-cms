/**
 * The social card for one event.
 *
 * AN EVENT CARD LIVES OR DIES ON ITS DATE. A share of "Indigo: a symposium" with no date is a share
 * nobody can act on, and the date is the one fact a reader needs before they decide whether to open
 * the link at all — so it goes in the `meta` line, which is the slot the design gives to a single
 * qualifying fact. The design lives in `lib/og/card.tsx`; this file is the query.
 *
 * ⚠ THE DATE SENTENCE COMES FROM `describeEventDates`, THE SAME FUNCTION THE PAGE AND THE CALENDAR
 * FEED USE. Formatting a date here would be a third opinion about the Centre's timezone and about
 * whether a multi-day event may state a start time — and that helper deliberately refuses to give a
 * clock time for a multi-day entry, because a single start time invites a reader to arrive on the
 * wrong day (see the note in components/site/EventDateBlock.tsx, and the same decision carried into
 * lib/ical.ts). A card that disagreed with the page about when something happens is worse than a card
 * with no date on it.
 *
 * THE PUBLICATION FILTER IS THE PAGE'S OWN, SPREAD UNCHANGED — `liveStatusWhere()`. `CoeEvent` carries
 * only `status`, so `livePublishableWhere()` would name columns this model does not have and throw at
 * request time (contract §9). A draft event's title rasterised into a PNG is a leak
 * `npm run leak-check` cannot grep for, because it greps HTML and this returns an image.
 *
 * NO VENUE ON THE CARD, though the page shows it. The `meta` line holds one fact and the date is the
 * more useful one; a venue that had to share the line would truncate the date, which is the half a
 * reader cannot infer.
 */

import { ImageResponse } from "next/og";

import { describeEventDates } from "@/components/site/EventDateBlock";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteName } from "@/lib/env";
import { OG_CONTENT_TYPE, OG_SIZE, fallbackCard, loadCardRecord, recordCard } from "@/lib/og/card";

/**
 * Five minutes, matching the page beside it. It caps how much of a busy channel's preview traffic
 * reaches the database, and how long a card can outlive the record it names.
 */
export const revalidate = 300;

export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt =
  "A Centre of Excellence share card naming one event, what it is about and when it takes place.";

/**
 * ⚠ `params` ARRIVES ALREADY RESOLVED HERE, unlike a page's — Next's metadata-image route awaits the
 * segment params before calling this handler. Typed as the union and awaited so it is right either way.
 */
interface CardProps {
  params: Promise<{ slug: string }> | { slug: string };
}

export default async function EventSocialCard({ params }: CardProps) {
  const { slug } = await params;

  const event = await loadCardRecord("event", () =>
    prisma.coeEvent.findFirst({
      where: { ...liveStatusWhere(), slug },
      // Four columns. `subtitle` is preferred over `summary` for the strap because it is the line the
      // page sets under the title; `summary` is a paragraph and would be cut mid-thought at this size.
      select: { title: true, subtitle: true, summary: true, startsAt: true, endsAt: true }
    })
  );

  return new ImageResponse(
    event
      ? recordCard({
          kind: "Event",
          title: event.title,
          subtitle: event.subtitle ?? event.summary,
          meta: describeEventDates(event.startsAt, event.endsAt).sentence,
          siteName: siteName()
        })
      : fallbackCard(),
    OG_SIZE
  );
}
