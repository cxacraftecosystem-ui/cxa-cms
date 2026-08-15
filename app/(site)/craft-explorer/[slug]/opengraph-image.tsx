/**
 * The social card for one craft.
 *
 * Names the craft, its one-line summary and the region it was recorded in, so a link into a WhatsApp
 * group about Punjabi metalwork previews as that craft rather than as the Centre's front door. The
 * design is not here — `lib/og/card.tsx` owns it, and this file is only the query and the choices
 * below.
 *
 * THE PUBLICATION FILTER IS THE PAGE'S OWN, SPREAD UNCHANGED. `liveStatusWhere()` and `findFirst`,
 * exactly as `page.tsx` loads the record: `Craft` has no `publishAt`/`unpublishAt` columns, so
 * `livePublishableWhere()` would reference a column the model does not have and throw at request time.
 * A card is a public surface — a draft craft's name rasterised into a PNG is a leak with no HTML for
 * `npm run leak-check` to grep (see the note in lib/og/card.tsx).
 *
 * THE FEATURE FLAG GATES THIS ROUTE TOO. `/craft-explorer` and every page under it call `notFound()`
 * when `features.craftExplorer` is off (contract §13a), so a craft's card must not go on previewing a
 * surface the Centre has switched off. It costs no extra query: `getSettingCached` reads all seven
 * groups once per request and memoises them.
 *
 * ⚠ THE LOCAL NAME IS DELIBERATELY ABSENT, though it sits under the craft's name everywhere on the
 * site. See lib/og/card.tsx: the font `next/og` bundles covers Latin only, and Satori draws a glyph it
 * has no coverage for as nothing at all — Devanagari or Gurmukhi would arrive as a row of blanks.
 */

import { ImageResponse } from "next/og";

import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteName } from "@/lib/env";
import { OG_CONTENT_TYPE, OG_SIZE, fallbackCard, loadCardRecord, recordCard } from "@/lib/og/card";
import { getSettingCached } from "@/lib/settings/service";

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
  "A Centre of Excellence share card naming one craft, its summary and the region it was recorded in.";

/**
 * ⚠ `params` ARRIVES ALREADY RESOLVED HERE, unlike a page's.
 *
 * Next's metadata-image route awaits the segment params before it calls this handler
 * (`handler({ params: restParams, id })` in next-metadata-route-loader), so this is a plain object even
 * in Next 15, where every page and `generateMetadata` receives a promise. Typed as the union and
 * awaited so it is right either way — `await` on a plain value yields the value.
 */
interface CardProps {
  params: Promise<{ slug: string }> | { slug: string };
}

export default async function CraftSocialCard({ params }: CardProps) {
  const { slug } = await params;

  const features = await getSettingCached("features");

  const craft = features.craftExplorer
    ? await loadCardRecord("craft", () =>
        prisma.craft.findFirst({
          where: { ...liveStatusWhere(), slug },
          // Four fields, because this runs once per crawler request per shared link. No cover, no
          // body, no media placements: none of them can appear on a typographic card.
          select: {
            name: true,
            summary: true,
            region: { select: { name: true } },
            school: { select: { name: true } }
          }
        })
      )
    : null;

  return new ImageResponse(
    craft
      ? recordCard({
          kind: "Craft",
          title: craft.name,
          subtitle: craft.summary,
          // The region is what places a craft for a reader; the school is the next best placing when
          // no region has been recorded, and both are already on the page's hero.
          meta: craft.region?.name ?? craft.school?.name ?? null,
          siteName: siteName()
        })
      : fallbackCard(),
    OG_SIZE
  );
}
