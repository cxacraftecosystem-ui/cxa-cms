/**
 * The social card for one publication.
 *
 * ⚠ THE EYEBROW IS THE KIND, NOT THE WORD "PUBLICATION", and that is the whole reason this card is
 * worth generating. A share of a dataset, a patent, a thesis and a journal article are four different
 * invitations, and the reader deciding whether to open the link is deciding largely on which of them
 * it is. `PUBLICATION_KIND_LABELS` comes from `../filters`, the same module the listing and the
 * detail page read, so the card cannot come to disagree with them about what a `BOOK_CHAPTER` is
 * called.
 *
 * THE STRAP IS THE AUTHOR LINE, NOT THE ABSTRACT. `authorLine` is the citation form — "Ranganathan,
 * M., Pal, S., & Mathai, J." — and it is what a researcher scans for; an abstract at this size is two
 * clauses of a paragraph cut mid-thought, which tells them less than the names do. The year and the
 * venue then go in the `meta` line, which is the slot the design gives to one qualifying fact.
 *
 * THE PUBLICATION FILTER IS THE PAGE'S OWN, SPREAD UNCHANGED — `liveStatusWhere()`. `Publication`
 * carries only `status`, so `livePublishableWhere()` would name columns this model does not have and
 * throw at request time (contract §9). A draft publication's title rasterised into a PNG is a leak
 * `npm run leak-check` cannot grep for, because it greps HTML and this returns an image.
 *
 * NO DOI ON THE CARD. It is the one string on this record a reader must be able to copy exactly, and a
 * social card is the one surface they cannot copy from — a truncated DOI is worse than no DOI, because
 * it looks complete.
 */

import { ImageResponse } from "next/og";

import { PUBLICATION_KIND_LABELS } from "../filters";
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
  "A Centre of Excellence share card naming one publication, its authors and where it appeared.";

/**
 * ⚠ `params` ARRIVES ALREADY RESOLVED HERE, unlike a page's — Next's metadata-image route awaits the
 * segment params before calling this handler. Typed as the union and awaited so it is right either way.
 */
interface CardProps {
  params: Promise<{ slug: string }> | { slug: string };
}

/**
 * "Journal of Craft and Material Culture, 2024" — or whichever half exists.
 *
 * Both are optional in practice: a preprint may have no venue, and while `year` is a required column a
 * defensive check costs one comparison and saves a card reading ", 0".
 */
function whereItAppeared(venue: string | null, year: number): string | null {
  const parts = [venue?.trim() || null, year > 0 ? String(year) : null].filter(
    (part): part is string => part !== null
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

export default async function PublicationSocialCard({ params }: CardProps) {
  const { slug } = await params;

  const publication = await loadCardRecord("publication", () =>
    prisma.publication.findFirst({
      where: { ...liveStatusWhere(), slug },
      select: { kind: true, title: true, authorLine: true, venue: true, year: true }
    })
  );

  return new ImageResponse(
    publication
      ? recordCard({
          kind: PUBLICATION_KIND_LABELS[publication.kind],
          title: publication.title,
          subtitle: publication.authorLine,
          meta: whereItAppeared(publication.venue, publication.year),
          siteName: siteName()
        })
      : fallbackCard(),
    OG_SIZE
  );
}
