/**
 * The social card for one research area.
 *
 * "Research area" is the Centre's own word for this record, and the eyebrow says it in full rather than
 * "Research" — the /research index is a listing of areas, and a card labelled only "Research" would be
 * indistinguishable from a card for a publication or a project. The design lives in `lib/og/card.tsx`;
 * this file is the query.
 *
 * THE PUBLICATION FILTER IS THE PAGE'S OWN, SPREAD UNCHANGED — `liveStatusWhere()` and `findFirst`, as
 * `loadArea` does it. `ResearchArea` carries only `status`, so `livePublishableWhere()` would name
 * columns this model does not have and throw at request time. A draft area's title rasterised into a PNG
 * is a leak that `npm run leak-check` cannot grep for (see lib/og/card.tsx).
 *
 * NO PROJECT OR PUBLICATION COUNT ON THE CARD, though the page shows both. They are filtered `_count`
 * aggregates, they change with every publication, and a platform's cache would keep "12 projects" alive
 * long after there were fifteen — a number a card cannot correct is a number better left to the page.
 *
 * `accentColor` IS IGNORED, ON PURPOSE. It is a data-encoding channel for the research graph, not a
 * second brand colour (schema comment, contract §1.1) — recolouring a share card by it would put an
 * editor-chosen accent on the institution's most public surface.
 */

import { ImageResponse } from "next/og";

import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteName } from "@/lib/env";
import { OG_CONTENT_TYPE, OG_SIZE, fallbackCard, loadCardRecord, recordCard } from "@/lib/og/card";

/**
 * Five minutes, the same window as the page beside it (and re-exported into the generated route by
 * Next's metadata loader, exactly as `runtime` is). It caps two things at once: how much of a busy
 * channel's preview traffic reaches the database, and how long a card can outlive the record it names.
 */
export const revalidate = 300;

export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt =
  "A Centre of Excellence share card naming one research area and the line that describes it.";

/**
 * ⚠ `params` ARRIVES ALREADY RESOLVED HERE, unlike a page's — Next's metadata-image route awaits the
 * segment params before calling this handler. Typed as the union and awaited so it is right either way.
 */
interface CardProps {
  params: Promise<{ slug: string }> | { slug: string };
}

export default async function ResearchAreaSocialCard({ params }: CardProps) {
  const { slug } = await params;

  const area = await loadCardRecord("research area", () =>
    prisma.researchArea.findFirst({
      where: { ...liveStatusWhere(), slug },
      // Two columns. The page falls back to the body's opening sentences for its description; parsing a
      // Tiptap document per crawler request, for a subtitle the card can do without, is not worth it.
      select: { title: true, summary: true }
    })
  );

  return new ImageResponse(
    area
      ? recordCard({
          kind: "Research area",
          title: area.title,
          subtitle: area.summary,
          siteName: siteName()
        })
      : fallbackCard(),
    OG_SIZE
  );
}
