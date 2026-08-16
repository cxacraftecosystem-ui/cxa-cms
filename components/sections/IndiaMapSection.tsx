/**
 * IndiaMapSection — where the work is: the country, with the archive counted onto it.
 *
 * A SERVER COMPONENT that reads Prisma directly (contract §9): every craft region, each counted by
 * its PUBLISHED crafts. The picture (`IndiaMap`) is aria-hidden decoration and the list beside it is
 * the real interface — every row a link into the craft explorer filtered to that region — so the
 * block is fully usable by keyboard, screen reader, and a browser with no JavaScript at all... with
 * one honest asterisk: the hover coupling between pin and row is the client stage's, and without
 * JavaScript the map is simply a still picture above a working list.
 *
 * ⚠ COUNTS ROLL UP TO THE NEAREST PLACED ANCESTOR — a craft is never dropped because its region lacks
 * a pin, and never counted twice. A craft points at the most specific region the record knows
 * (usually a district or cluster). When that region has coordinates, that is its pin; when it does
 * not, its count climbs the `parentId` chain to the FIRST region that does and is added there — each
 * region's count lands on exactly one anchor, so the map never claims more work than the archive
 * holds. A count whose whole chain is unplaced is not silently dropped either: it is stated in the
 * sr-only sentence under the map (contract §1.6 — the honest absence).
 *
 * EACH PIN ALSO CARRIES ONE CRAFT AND A PICTURE OF THAT KIND OF WORK, which is what the hover card
 * over the map shows. The craft is read alongside the count (`take: 1` per region, featured first)
 * and rolled up on the same chain, so the pin that stands for the most work is never the pin with
 * nothing to show. The picture is one of the Centre's own contact sheets, matched to the craft's
 * technique where the record allows and picked by a stable hash of its slug where it does not — see
 * components/map/craftSheetFor.ts, which also explains why a plate is never captioned as a photograph
 * OF the named craft.
 *
 * ⚠ NOTHING BELOW RENDERS WITHOUT DATA, AND THAT IS ON PURPOSE (see the guard at the end of the
 * roll-up). To see this section at all, the database needs at least one `CraftRegion` with BOTH
 * `latitude` and `longitude` set, and at least one PUBLISHED, undeleted `Craft` pointing at that
 * region or at a descendant of it. `prisma/corpus/crafts.ts` seeds exactly that — placed regions and
 * published crafts with `materials`/`techniques` filled in, which is also what the plate matcher
 * reads. A production database with no craft records draws nothing, correctly.
 *
 * The geometry is the OFFICIAL depiction of India — components/map/indiaGeometry.ts carries the
 * provenance and the warning against substituting any Western dataset. Do not "optimise" it away.
 */

import type { PageSection } from "@prisma/client";

import { craftSheetFor } from "@/components/map/craftSheetFor";
import { IndiaMapStage } from "@/components/map/IndiaMapStage";
import type { MapPoint } from "@/components/map/layout";
import { Reveal } from "@/components/motion/Reveal";
import { prisma } from "@/lib/db";
import { prerenderSafe } from "@/lib/prerender";
import type { IndiaMapSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface IndiaMapSectionProps {
  data: IndiaMapSectionData;
  section: PageSection;
}

export async function IndiaMapSection({ data, section }: IndiaMapSectionProps) {
  /*
   * Guarded like every layout-adjacent read (lib/prerender.ts): this block sits on the homepage,
   * which is in the database-less Docker image build's path — an unguarded read here would fail
   * the whole image the way AnnouncementBar's once did. The fallback is an empty list, and the
   * block renders nothing rather than an empty country (contract §1.6 — the honest absence), then
   * repairs itself at the next revalidation.
   *
   * ALL regions are fetched, not only the placed or counted ones: a counted region's anchor can be
   * any ancestor, and an ancestor with no crafts of its own would be missing from a query filtered
   * by `crafts: { some: … }` — which would break the very chain the roll-up walks.
   */
  const regions = await prerenderSafe(
    "IndiaMapSection",
    () =>
      prisma.craftRegion.findMany({
        select: {
          id: true,
          slug: true,
          name: true,
          parentId: true,
          latitude: true,
          longitude: true,
          _count: { select: { crafts: { where: { status: "PUBLISHED", deletedAt: null } } } },
          /*
           * ONE craft per region, to stand for the work at its pin in the map's hover card.
           *
           * ⚠ `take: 1` IS WHAT MAKES THIS AFFORDABLE, and the ordering is what makes it stable. The
           * alternative — reading every published craft and grouping in JavaScript — pulls the whole
           * archive into the homepage's render to use one row of it. Featured first, because "the one
           * an editor chose to feature" is the best answer available to "which craft stands for this
           * place"; then by name, so the pick never depends on insertion order and the same reader
           * sees the same craft on every visit.
           *
           * ⚠ THE `where` MUST MATCH `_count`'s EXACTLY. If the two ever drift, a region can report a
           * count with no craft to show for it — a pin whose card is a name and a blank.
           */
          crafts: {
            where: { status: "PUBLISHED", deletedAt: null },
            orderBy: [{ isFeatured: "desc" }, { name: "asc" }],
            take: 1,
            select: { slug: true, name: true, materials: true, techniques: true }
          }
        }
      }),
    []
  );

  type Region = (typeof regions)[number];

  const byId = new Map<string, Region>(regions.map((region) => [region.id, region]));
  const isPlaced = (region: Region): boolean =>
    region.latitude !== null && region.longitude !== null;

  /*
   * The roll-up. Each region's direct count is added to exactly one anchor: itself when it has
   * coordinates, otherwise the nearest ancestor that does. The `visited` set makes a cyclic
   * `parentId` chain — bad data, not a state the schema can promise away — end as "unplaced"
   * instead of hanging the homepage; a `parentId` that resolves to nothing ends the walk the same
   * way.
   */
  const totals = new Map<Region, number>();
  let unplacedTotal = 0;

  /*
   * The craft each anchor shows a picture of, and the claim it beat.
   *
   * ⚠ AN ANCHOR'S EXEMPLAR IS NOT NECESSARILY ITS OWN CRAFT. Counts climb the `parentId` chain, so a
   * pin on Gujarat can be standing for crafts recorded against Ajrakhpur and Nirona and nothing at
   * all against Gujarat itself; the picture has to climb with the count or the pin with the most
   * work on the map would be the one pin with no picture. The contributor holding the most crafts
   * wins, ties broken by slug — a total order that does not depend on the order rows came back in, so
   * the same archive always produces the same forty pictures.
   */
  type Claim = { count: number; slug: string; craft: Region["crafts"][number] };
  const exemplars = new Map<Region, Claim>();

  for (const region of regions) {
    const count = region._count.crafts;
    if (count === 0) continue;

    let anchor: Region | null = null;
    const visited = new Set<string>();
    let current: Region | undefined = region;
    while (current !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      if (isPlaced(current)) {
        anchor = current;
        break;
      }
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }

    if (anchor === null) {
      unplacedTotal += count;
      continue;
    }

    totals.set(anchor, (totals.get(anchor) ?? 0) + count);

    // `crafts` is a `take: 1` list, so this is the region's exemplar or nothing —
    // `noUncheckedIndexedAccess` is right that a first element is not a promise the type can make.
    const craft = region.crafts[0];
    if (craft === undefined) continue;

    const held = exemplars.get(anchor);
    if (
      held === undefined ||
      count > held.count ||
      (count === held.count && region.slug < held.slug)
    ) {
      exemplars.set(anchor, { count, slug: region.slug, craft });
    }
  }

  const points: MapPoint[] = [...totals.entries()]
    .map(([region, total]) => {
      const exemplar = exemplars.get(region);
      return {
        key: region.slug,
        name: region.name,
        // An anchor is placed by construction — `isPlaced` is the only way into `totals`.
        latitude: region.latitude as number,
        longitude: region.longitude as number,
        total,
        /*
         * The plate is chosen HERE, on the server, and travels with the point. The manifest is
         * forty-three entries each carrying a base64 blur placeholder; resolving on the client would
         * put all of it in the bundle to look one slug up. See components/map/layout.ts.
         */
        craft: exemplar
          ? { name: exemplar.craft.name, sheet: craftSheetFor(exemplar.craft) }
          : undefined
      };
    })
    // Largest first, so the list's ordinals lead with the places holding the most work — and the
    // map's hover card numbers agree, because both read this one order.
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  // No anchors at all — a fresh install before the corpus, or an archive whose regions were entered
  // without positions. Nothing to draw is nothing to render; the unplaced sentence below would be a
  // sentence about a map that is not on the page.
  if (points.length === 0) return null;

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {data.eyebrow || data.heading || data.body ? (
          <Reveal className="mx-auto max-w-3xl text-center">
            {data.eyebrow ? <p className="eyebrow">{data.eyebrow}</p> : null}
            {data.heading ? (
              <h2 className={cn("display-title text-balance text-3xl sm:text-4xl", data.eyebrow && "mt-3")}>
                {data.heading}
              </h2>
            ) : null}
            {data.body ? (
              <p className="mt-5 text-base leading-relaxed text-ink-700">{data.body}</p>
            ) : null}
          </Reveal>
        ) : null}

        <Reveal className="mt-12 md:mt-16">
          <IndiaMapStage points={points} hrefBase="/craft-explorer?region=" />
        </Reveal>

        {/*
          The crafts whose whole region chain has no coordinates. There is no honest way to draw
          them — a pin needs a place — so the absence is said in words instead of being dropped
          (contract §1.6). Screen-reader only: visually the map already shows exactly what it can
          place, and this sentence is the part the picture cannot carry.
        */}
        {unplacedTotal > 0 ? (
          <p className="sr-only">
            {unplacedTotal === 1
              ? "1 craft comes from a place not yet on the map."
              : `${unplacedTotal} crafts come from places not yet on the map.`}
          </p>
        ) : null}
      </div>
    </section>
  );
}
