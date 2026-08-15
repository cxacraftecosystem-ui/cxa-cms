import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch } from "@/lib/permissions";
import { buildAuditContext, fieldProblem, found, parseStudioJson } from "@/lib/studio/crud";

/**
 * One craft region: place it on the homepage map, move it, or take it off.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FIRST WRITE SURFACE REGIONS HAVE. Regions were seeded (prisma/corpus/seed-corpus.ts) and then
 * read-only: the craft editor could FILE a craft under one, but nobody in the studio could give a
 * region coordinates — so a craft documented from an unplaced region simply never appeared on the
 * homepage map. `components/sections/IndiaMapSection.tsx` now rolls counts up to the nearest placed
 * ancestor, and this route is the other half of the fix: the screen where an editor decides which
 * regions ARE placed. Only the coordinates are editable here; a region's name, level and parent are
 * the corpus's structure and still change only with the corpus.
 *
 * ⚠ THE RANGE IS INDIA'S BOX, NOT THE WORLD'S. The map draws the official outline of India and
 * nothing else, so a pin at 51°N is not a typo tolerated for later — it is a pin the map can never
 * draw. The whole-degree box (latitude 6–38 N, longitude 68–98 E) encloses `INDIA_BOUNDS` in
 * components/map/indiaGeometry.ts (6.756–37.082 N, 68.206–97.394 E); a value outside it is refused
 * as THAT FIELD's own 422 — `fieldErrors` names the box the editor is typing into — never a crash
 * and never a silent save of a pin in the sea.
 *
 * BOTH NUMBERS OR NEITHER. Half a coordinate can never be drawn — the map's query needs the pair —
 * so a latitude without a longitude would be a value that LOOKS saved and does nothing, which is the
 * most confusing state a form can produce. The refusal lands on the empty field.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const LATITUDE_ADVICE =
  "A latitude on this map is between 6 and 38 — decimal degrees, north positive. Jaipur is 26.9124.";
const LONGITUDE_ADVICE =
  "A longitude on this map is between 68 and 98 — decimal degrees, east positive. Jaipur is 75.7873.";

/**
 * `.nullable()` rather than `.optional()`: the screen always sends both keys, and `null` is the
 * deliberate "take it off the map". A missing key would be indistinguishable from a cleared box.
 */
const patchBody = z.object({
  latitude: z
    .number({ invalid_type_error: LATITUDE_ADVICE })
    .min(6, LATITUDE_ADVICE)
    .max(38, LATITUDE_ADVICE)
    .nullable(),
  longitude: z
    .number({ invalid_type_error: LONGITUDE_ADVICE })
    .min(68, LONGITUDE_ADVICE)
    .max(98, LONGITUDE_ADVICE)
    .nullable()
});

const REGION_SELECT = {
  id: true,
  slug: true,
  name: true,
  level: true,
  latitude: true,
  longitude: true
} as const satisfies Prisma.CraftRegionSelect;

type RegionRow = Prisma.CraftRegionGetPayload<{ select: typeof REGION_SELECT }>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — set, move or clear the coordinates
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Placing a region on the map needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, patchBody);

  // Both or neither — see the header. The error lands on the EMPTY field, because that is the box
  // the editor has to act on.
  if ((body.latitude === null) !== (body.longitude === null)) {
    throw fieldProblem(
      body.latitude === null ? "latitude" : "longitude",
      "A pin needs both numbers. Fill this one in as well, or clear both to take the region off the map."
    );
  }

  const existing = found(
    await prisma.craftRegion.findUnique({ where: { id }, select: REGION_SELECT }),
    "That region"
  );

  const wasPlaced = existing.latitude !== null && existing.longitude !== null;
  const willBePlaced = body.latitude !== null;

  if (body.latitude === existing.latitude && body.longitude === existing.longitude) {
    // Nothing was different. Answered as success rather than as an error: the screen has nothing to
    // fix, and a refusal would report a failure for a save that had nothing to do.
    return ok({
      region: existing,
      changed: false,
      message: "Nothing was different, so nothing has been changed."
    });
  }

  const updated = await mutateWithHistory<RegionRow>(
    buildAuditContext(request, user),
    {
      action: "UPDATE",
      entityType: "CraftRegion",
      entityLabel: existing.name,
      // The two columns only: this route changes nothing else, and the audit entry's before/after
      // pair is the whole story of the change.
      before: { latitude: existing.latitude, longitude: existing.longitude },
      /**
       * NO REVISION. A region is a small taxonomy row with no history screen in the studio, so a
       * revision would be a copy nobody can reach — the same reasoning as news categories. The audit
       * entry already carries the whole row in `after`.
       */
      revise: false
    },
    async (tx) =>
      tx.craftRegion.update({
        where: { id },
        data: { latitude: body.latitude, longitude: body.longitude },
        select: REGION_SELECT
      })
  );

  // The message says what the MAP does now, because that is the reason anybody is on this screen.
  const at = willBePlaced ? `${body.latitude}, ${body.longitude}` : "";
  const message = !willBePlaced
    ? `“${existing.name}” is off the map. Its crafts now count under the nearest parent region with coordinates — and if no parent has any, the map reports them as not yet placed.`
    : wasPlaced
      ? `“${existing.name}”'s pin has moved to ${at}.`
      : `“${existing.name}” is on the homepage map now, at ${at}. Its published crafts pin there, along with those of any child region that has no coordinates of its own.`;

  return ok({ region: updated, changed: true, message });
});
