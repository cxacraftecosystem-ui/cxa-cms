import type { Metadata } from "next";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
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

  const truncated = rows.length > REGION_LIMIT;
  const regions = rows.slice(0, REGION_LIMIT);

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
        description="The homepage map pins every region that has coordinates. Give a region its own by opening its map and clicking where the place is, or by typing the two numbers. A region without them is not lost — its crafts count under the nearest parent region that has coordinates, and if no parent has any, the map says so out loud."
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
