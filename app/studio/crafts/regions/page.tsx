import type { Metadata } from "next";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { RegionCreateForm } from "./RegionCreateForm";
import { RegionMapManager, type RegionAnchor, type RegionRowData } from "./RegionMapManager";

/**
 * Regions on the map — where each craft region sits, and which ones sit nowhere yet.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageResearch)` IS THE FIRST STATEMENT, and it throws rather than
 * rendering (contract §1.8) — the same predicate as the craft archive this screen belongs to, and the
 * same one `app/api/studio/crafts/regions/[id]/route.ts` requires, so nobody is offered a screen whose
 * saves would then refuse them (contract §1.7).
 *
 * WHY THIS SCREEN EXISTS. The homepage map pins a region only when it has coordinates, and until this
 * screen there was nowhere in the studio to give it any — regions were seeded and then read-only, so
 * a craft documented from a new place could never surface a pin. The map now rolls counts up to the
 * nearest PLACED ancestor (components/sections/IndiaMapSection.tsx), and each row here states its
 * region's fate in the same terms, computed by the SAME walk over the same tree: on the map, counting
 * under a named parent, or reported as not yet placed.
 *
 * AND A REGION CAN BE RECORDED HERE NOW, which the paragraph above predates: "seeded and then read-only"
 * left an editor documenting a craft from an unlisted place with no move to make. `RegionCreateForm.tsx`
 * (and `app/api/studio/crafts/regions/route.ts` behind it) closes that, and its header says why a new region
 * is deliberately created WITHOUT coordinates — this screen is where a region gets placed, so requiring a
 * pin at creation time would reintroduce the same hole one step earlier.
 *
 * AND IT HAS A MAP ON IT NOW. Every row opens `components/studio/RegionMapPicker.tsx` — the same
 * outline at the same `VIEW_BOX`, through the same projection, as the picture on the homepage — so a
 * region can be placed by clicking where it is instead of by looking its decimal degrees up first.
 * The two number fields stay, and the two are one value: see RegionMapManager.tsx's header for why
 * that means the coordinates are held by the list rather than by each row.
 *
 * ⚠ FILING A CRAFT UNDER A REGION IS NOT DONE HERE AND MUST NOT BE ADDED HERE. `Craft.regionId` is a
 * single optional foreign key, and the studio already writes it on the craft's own editor
 * (app/studio/crafts/[id]/CraftEditor.tsx, "Where it comes from"). A second writer for one column is
 * two screens that can silently overwrite each other; this screen signposts that one instead.
 *
 * ⚠ THIS SEGMENT IS STATIC AND `[id]` IS DYNAMIC, so `/studio/crafts/regions` resolves here rather
 * than to the craft editor with `id="regions"` — the same routing fact the news taxonomy screens rest
 * on (contract §13b). No `loading.tsx` may be added above this segment for the reason the craft
 * editor's header gives.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Regions on the map"
};

/**
 * A safety bound, not a page size — the gazetteer holds tens of regions, not thousands. When it bites
 * it is stated on screen, and the anchor phrases are computed over the fetched rows only, which the
 * truncation notice covers: an unlisted region changes nothing about what a LISTED row's stored
 * coordinates do.
 */
const REGION_LIMIT = 1000;

export default async function StudioCraftRegionsPage() {
  await requireStudioCapability(
    canManageResearch,
    "Placing regions on the map needs researcher access or higher. An administrator can raise yours."
  );

  const rows = await prisma.craftRegion.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      level: true,
      parentId: true,
      latitude: true,
      longitude: true,
      // Published only, because that is the number the homepage map counts. The archive list linked
      // from each row is filtered the same way, so the number can be checked against it.
      _count: { select: { crafts: { where: { status: "PUBLISHED", deletedAt: null } } } }
    },
    orderBy: { name: "asc" },
    take: REGION_LIMIT + 1
  });

  /**
   * Live crafts per region, in one round trip.
   *
   * ⚠ A SECOND COUNT, AND NOT A DUPLICATE OF THE ONE ABOVE. The `_count` in the select is PUBLISHED crafts,
   * because that is the number the homepage map pins and the number each row prints. What a DELETE would
   * un-file is every live craft, drafts included — so a row that says "nothing published here" can still be
   * one the removal is refused for. Two different questions need two different numbers, and offering a
   * delete against the published count would be a menu that disagrees with the route it calls
   * (app/api/studio/crafts/regions/[id]/route.ts counts exactly this set).
   *
   * `groupBy` rather than a filtered `_count` beside the first: Prisma takes one `_count` block per query,
   * and two filters on the same relation cannot live in it.
   */
  const liveCraftRows = await prisma.craft.groupBy({
    by: ["regionId"],
    where: { deletedAt: null, regionId: { not: null } },
    _count: { _all: true }
  });
  const liveCrafts = new Map<string, number>(
    liveCraftRows.flatMap((row) => (row.regionId === null ? [] : [[row.regionId, row._count._all]]))
  );

  const truncated = rows.length > REGION_LIMIT;
  const regions = rows.slice(0, REGION_LIMIT);

  /**
   * How many regions sit directly under each one.
   *
   * Counted over the FETCHED rows, which is exact whenever the list is not truncated and is stated on
   * screen when it is. It matters because `parentId` is `onDelete: SetNull`: deleting a state would promote
   * its districts to the top of the tree rather than refusing, so the row has to know before it offers.
   */
  const childCounts = new Map<string, number>();
  for (const region of regions) {
    if (region.parentId === null) continue;
    childCounts.set(region.parentId, (childCounts.get(region.parentId) ?? 0) + 1);
  }

  type Row = (typeof regions)[number];
  const byId = new Map<string, Row>(regions.map((region) => [region.id, region]));

  /**
   * The SAME walk the homepage map performs: up the `parentId` chain to the first region with
   * coordinates. The visited set makes a cyclic chain (bad data, not a schema state) read as
   * unplaced instead of hanging the screen.
   */
  function anchorFor(region: Row): RegionAnchor {
    const visited = new Set<string>();
    let current: Row | undefined = region;
    while (current !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.latitude !== null && current.longitude !== null) {
        return current.id === region.id ? { kind: "self" } : { kind: "ancestor", name: current.name };
      }
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return { kind: "none" };
  }

  const data: RegionRowData[] = regions.map((region) => ({
    id: region.id,
    slug: region.slug,
    name: region.name,
    level: region.level,
    parentName: region.parentId === null ? null : (byId.get(region.parentId)?.name ?? null),
    craftCount: region._count.crafts,
    liveCraftCount: liveCrafts.get(region.id) ?? 0,
    childCount: childCounts.get(region.id) ?? 0,
    // Text, so the inputs can hold a half-typed value; "" is "not set".
    latitude: region.latitude === null ? "" : String(region.latitude),
    longitude: region.longitude === null ? "" : String(region.longitude),
    anchor: anchorFor(region)
  }));

  const placed = regions.filter(
    (region) => region.latitude !== null && region.longitude !== null
  ).length;

  return (
    <div className="mx-auto w-full max-w-[72rem] space-y-6">
      <StudioPageHeader
        title="Regions on the map"
        back={{ href: "/studio/crafts", label: "Craft archive" }}
        breadcrumb={[{ label: "Craft archive", href: "/studio/crafts" }, { label: "Regions on the map" }]}
        description="The homepage map pins every region that has coordinates. Give a region its own by opening its map and clicking where the place is, or by typing the two numbers. A region without them is not lost — its crafts count under the nearest parent region that has coordinates, and if no parent has any, the map says so out loud. A place the list does not name yet can be added; it arrives unplaced and is placed here like any other."
        actions={
          /*
            The form shares this page's own predicate (`canManageResearch`), the same one
            app/api/studio/crafts/regions/route.ts requires, so the control needs no gate of its own —
            nobody who can stand here is refused by it (contract §1.7).
          */
          <RegionCreateForm
            parents={regions.map((region) => ({
              id: region.id,
              name: region.name,
              level: region.level
            }))}
          />
        }
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {placed} of {regions.length === 1 ? "1 region" : `${regions.length} regions`} on the map
          </span>
        }
      />

      <RegionMapManager regions={data} truncated={truncated} limit={REGION_LIMIT} />
    </div>
  );
}
