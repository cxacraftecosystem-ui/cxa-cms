/**
 * The social card for one project.
 *
 * A project link is shared with funders, partners and candidates, and what they need first is the title,
 * the tagline and which research area it belongs to. The design lives in `lib/og/card.tsx`; this file is
 * the query and the two choices below.
 *
 * THE PUBLICATION FILTER IS THE PAGE'S OWN, SPREAD UNCHANGED — `liveStatusWhere()` and `findFirst`, as
 * `loadProject` does it. `Project` carries only `status`, so `livePublishableWhere()` would name columns
 * this model does not have and throw at request time. A draft project's title rasterised into a PNG is a
 * leak that `npm run leak-check` cannot grep for (see lib/og/card.tsx).
 *
 * NEITHER THE STATE NOR THE PROGRESS IS ON THE CARD. "Active, 40%" is true at the moment the crawler
 * asks and stays in a platform's cache for weeks afterwards, so a completed project would go on
 * previewing as half-finished long after the closing report. The research area does not move.
 *
 * `fundingAmount` IS NOT ON THE CARD EITHER, and not because it would not fit: it is a string with a
 * separate currency column (see the page header), and a share card is the last place to start abbreviating
 * somebody's grant.
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
  "A Centre of Excellence share card naming one project, its tagline and the research area it sits in.";

/**
 * ⚠ `params` ARRIVES ALREADY RESOLVED HERE, unlike a page's — Next's metadata-image route awaits the
 * segment params before calling this handler. Typed as the union and awaited so it is right either way.
 */
interface CardProps {
  params: Promise<{ slug: string }> | { slug: string };
}

export default async function ProjectSocialCard({ params }: CardProps) {
  const { slug } = await params;

  const project = await loadCardRecord("project", () =>
    prisma.project.findFirst({
      where: { ...liveStatusWhere(), slug },
      select: {
        title: true,
        tagline: true,
        summary: true,
        researchArea: { select: { title: true } }
      }
    })
  );

  return new ImageResponse(
    project
      ? recordCard({
          kind: "Project",
          title: project.title,
          // The tagline is written to be read in one breath; the summary is the fallback for a project
          // whose editor never wrote one, and the card's own word-boundary cut keeps it to a line.
          subtitle: project.tagline?.trim() || project.summary,
          meta: project.researchArea?.title ?? null,
          siteName: siteName()
        })
      : fallbackCard(),
    OG_SIZE
  );
}
