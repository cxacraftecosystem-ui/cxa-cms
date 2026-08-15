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
 * The geometry is the OFFICIAL depiction of India — components/map/indiaGeometry.ts carries the
 * provenance and the warning against substituting any Western dataset. Do not "optimise" it away.
 */

import type { PageSection } from "@prisma/client";

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
          _count: { select: { crafts: { where: { status: "PUBLISHED", deletedAt: null } } } }
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

    if (anchor !== null) totals.set(anchor, (totals.get(anchor) ?? 0) + count);
    else unplacedTotal += count;
  }

  const points: MapPoint[] = [...totals.entries()]
    .map(([region, total]) => ({
      key: region.slug,
      name: region.name,
      // An anchor is placed by construction — `isPlaced` is the only way into `totals`.
      latitude: region.latitude as number,
      longitude: region.longitude as number,
      total
    }))
    // Largest first, so the list's ordinals lead with the places holding the most work — and the
    // map's hover label numbers agree, because both read this one order.
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
