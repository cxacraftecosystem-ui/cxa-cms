import { prisma } from "@/lib/db";
import { ok, route } from "@/lib/api";
import { liveStatusWhere } from "@/lib/content";
import { getSetting } from "@/lib/settings/service";

/**
 * The homepage census: how much of the Centre's work is actually published.
 *
 * TWO PROPERTIES THIS ENDPOINT IS BUILT AROUND.
 *
 *  1. **It is CACHED, and it says when it was counted.** `computedAt` is returned with the figures so
 *     the page can render "as counted on 30 July at 14:05" rather than four numbers that imply a live
 *     reading. They are not live: `revalidate` below means any given response can be up to an hour
 *     old, and a dated snapshot is honest where an undated one is a small lie repeated on every visit.
 *     Four `count(*)` queries per page view would also be four sequential scans of the busiest tables
 *     on the site's most-visited page.
 *  2. **It reads NOTHING from the request** — no IP, no headers, no rate limit. Touching any of those
 *     opts a route handler out of caching, which would defeat the point of the paragraph above. The
 *     cache IS the protection here: whatever the traffic, the database sees these four queries once an
 *     hour.
 *
 * Every figure is defined in `definitions`, in words, because "records: 3 412" invites a caption that
 * claims something the number does not. `records` in particular is a specific thing — items catalogued
 * in published gallery albums — and not a total of everything in the database.
 */

/**
 * ⚠ **BOTH EXPORTS ARE REQUIRED.** In Next 15 a GET route handler is NOT cached by default — that
 * changed from 14, and `revalidate` on its own leaves the handler dynamic, which would run four counts
 * on every request while looking cached in review. `force-static` is the documented opt-in; `revalidate`
 * then says how long a cached answer may live.
 *
 * Two consequences to know about:
 *
 *   • `force-static` means this handler runs during `next build`, so the build needs a reachable
 *     database. `app/sitemap.ts` already has that property, so it is not a new requirement.
 *   • If the counts DO fail at build time, `route()` turns the throw into a 500 body and that 500 is
 *     what gets cached, for up to `revalidate` seconds. **So the consumer must treat any non-200 from
 *     this endpoint as "no census to show" and render nothing** — four zeros under a heading reading
 *     "the Centre in numbers" is a claim, and it would be the wrong one.
 *
 * One hour: the figures move by a handful a week, so an hour of staleness is invisible — and it is
 * stated in the payload rather than hidden, which is the whole point of `computedAt`.
 */
export const dynamic = "force-static";
export const revalidate = 3600;

export const GET = route(async () => {
  // `Promise.all`, not a transaction: four independent counts do not need a consistent snapshot across
  // one another, and a read transaction would hold a connection for the length of the slowest of them.
  const [crafts, records, publications, partners, homepage] = await Promise.all([
    prisma.craft.count({ where: liveStatusWhere() }),
    // Items inside PUBLISHED albums. `GalleryItem` has no status of its own — an album is the unit an
    // editor publishes — so the filter goes through the relation.
    prisma.galleryItem.count({ where: { album: liveStatusWhere() } }),
    prisma.publication.count({ where: liveStatusWhere() }),
    // `Partner` carries neither `status` nor `publishedAt`, so `liveStatusWhere()` would be a Prisma
    // runtime error here. Visible and not deleted is the equivalent predicate.
    prisma.partner.count({ where: { deletedAt: null, isVisible: true } }),
    getSetting("homepage")
  ]);

  const computedAt = new Date();

  // No `Cache-Control` is set by hand. The policy is stated once, in the two exports above, and the
  // framework emits the headers that go with it; a second hand-written policy here would be a
  // different number to keep in step and the first thing to drift.
  return ok({
    computedAt: computedAt.toISOString(),
    /** So a renderer can say how stale the snapshot may be without hard-coding this route's policy. */
    revalidateSeconds: revalidate,
    figures: { crafts, records, publications, partners },
    definitions: {
      crafts: "Crafts with a published record in the Craft Explorer.",
      records: "Items catalogued in published gallery albums — photographs, video, panoramas and tours.",
      publications: "Published publication records of every kind, including datasets and patents.",
      partners: "Partner institutions currently shown on the site."
    },
    /**
     * The editor's override. Returned rather than applied, because suspending the census is a display
     * decision: the renderer shows `note` INSTEAD of the figures when this is on. Sending the numbers
     * anyway would let a careless consumer print them under a note explaining why they should not be
     * trusted.
     *
     * ⚠ It is inside the cached response, so flipping the switch takes up to `revalidateSeconds` to
     * appear here. The homepage reads settings directly and will be right immediately; this endpoint
     * catches up.
     */
    census: {
      suspended: homepage.censusOverride.enabled,
      note: homepage.censusOverride.note
    }
  });
});
