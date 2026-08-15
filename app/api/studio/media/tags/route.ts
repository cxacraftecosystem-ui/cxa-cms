// `Prisma` is imported as a VALUE, not merely as a type: `Prisma.sql` is the tagged-template helper,
// and it is the only way anything reaches this file's SQL. Nothing here concatenates a query string.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";

/**
 * The media library's tag vocabulary, with a usage count for each one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE ANSWER SHAPE IS `MediaTagsResponse` from components/studio/media/MediaGrid.tsx —
 * `{ items: [{ tag, count }], truncated }` — and `app/studio/media/page.tsx` builds the IDENTICAL shape
 * from Prisma for the first paint. A field added here has to be added there too, or the seeded list and
 * every list after it will disagree.
 *
 * ⚠ WHY THIS FILE EXISTS AT ALL. `/api/studio/media/tags` was being swallowed by the sibling dynamic
 * segment `media/[id]/route.ts` with `id = "tags"`, which exports GET — so the tag filter was reading an
 * asset that does not exist and getting a 404 rather than a vocabulary. A STATIC segment always beats a
 * dynamic one in Next, so the existence of this file is the whole fix (contract §13b).
 *
 * THE COUNTING HAPPENS IN THE DATABASE, over `unnest`. `tags` is a Postgres array column, and counting
 * the distinct values of an array's members is a `GROUP BY` over `UNNEST` that Prisma's query builder
 * cannot express. The seeded first page works around that by reading one narrow column for up to 5,000
 * rows and counting in JavaScript — acceptable for a single render, and hopeless for this endpoint, which
 * drives an autocomplete and is asked the same question every time the filter bar opens.
 *
 * THE CAP IS REPORTED, NEVER SILENT. `truncated` is true when there are more distinct tags than the list
 * carries, and the filter prints it. A list that quietly stops is indistinguishable from a library with
 * exactly sixty tags (contract §1.6). The count itself is exact: unlike the seeded page there is no scan
 * limit here, because the whole job is one aggregate.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many tags the filter offers.
 *
 * ⚠ MIRRORS `TAG_LIMIT` in app/studio/media/page.tsx and the two must move together: that file seeds the
 * first render of the same control, and a different number in each place makes the list change length the
 * moment the browser refetches it. Past sixty a dropdown is a worse tool than the search box.
 */
const TAG_LIMIT = 60;

interface TagCountRow {
  tag: string;
  count: number;
}

export const GET = route(async () => {
  // A read, so no same-origin assertion. It is still gated: the vocabulary names work that has not been
  // published, and the media screen's own guard is not the boundary (contract §1.7).
  await requireCapability(
    canManageMedia,
    "The media library needs media manager access or higher. An administrator can raise yours."
  );

  /**
   * One aggregate over the unnested array.
   *
   * `btrim` on both the grouping key and the output, and the empty result excluded, so this agrees with
   * the write path: `PATCH /api/studio/media/[id]` trims every tag before storing it, and a stray
   * whitespace-only entry from an older row must not appear in the filter as a nameless option.
   *
   * `count(*)::int` — an un-cast `count(*)` is `bigint`, which Prisma hands back as a `BigInt` that
   * `JSON.stringify` throws on, so the endpoint would 500 with a message about serialisation.
   *
   * `LIMIT` is one MORE than the cap: getting the extra row is how "there are more than this" is known
   * without a second counting query.
   */
  const rows = await prisma.$queryRaw<TagCountRow[]>(Prisma.sql`
    SELECT btrim(t.tag) AS "tag",
           count(*)::int AS "count"
      FROM "media_assets" AS a,
           unnest(a."tags") AS t(tag)
     WHERE a."deletedAt" IS NULL
       AND btrim(t.tag) <> ''
     GROUP BY btrim(t.tag)
     ORDER BY count(*) DESC, btrim(t.tag) ASC
     LIMIT ${TAG_LIMIT + 1}
  `);

  // Most used first, ties broken alphabetically — a total order, so the list never reshuffles between
  // requests. An unstable sort renders a different set of options every time and reads as data changing.
  return ok({
    items: rows.slice(0, TAG_LIMIT),
    truncated: rows.length > TAG_LIMIT
  });
});
