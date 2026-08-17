import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, badRequest, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch } from "@/lib/permissions";
import { buildAuditContext, fieldProblem, isUniqueViolation, parseStudioJson } from "@/lib/studio/crud";
import { slugify } from "@/lib/utils";

/**
 * Create a craft region.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS DELIBERATELY REVERSES A DECISION THE SIBLING ROUTE STATES, and the reason is worth recording.
 * `regions/[id]/route.ts` says "a region's name, level and parent are the corpus's structure and still
 * change only with the corpus" — true when every region arrived from `prisma/corpus/seed-corpus.ts` and
 * the studio only had to place them. It left the product with no way to record a region at all: the craft
 * editor's field says "Regions are set up separately. Leave it empty if the place is not settled", and
 * there was nowhere that separate setting-up happened. An editor documenting a craft from a place the
 * corpus never listed had no move to make and no message telling them so.
 *
 * So a region can now be created here. What has NOT changed is that renaming or re-parenting an existing
 * one is still not offered: those are the corpus's own identifiers, other records point at them, and a
 * rename that silently re-pointed a seeded tree is a different and much larger decision.
 *
 * ⚠ THE SLUG IS DERIVED, NEVER TYPED. Every other taxonomy in this studio does the same. A hand-typed
 * slug on a tree is how two "Kutch"es appear at different levels, and `slug` is unique — so the collision
 * would surface as a raw P2002 rather than as a sentence. It is checked here AND caught below, because a
 * check is not a guarantee when two editors save at once.
 *
 * ⚠ THE COORDINATES ARE OPTIONAL ON CREATE, and that is not laziness. Naming a place and knowing where it
 * is are two different pieces of work, often done by two different people — the region screen exists
 * precisely to place regions that have no pin yet, and it reports each one's fate in words. Requiring a
 * pin here would mean an editor who does not have the decimal degrees to hand cannot record the place at
 * all, which is the hole this route is closing.
 *
 * The range is India's box for the reason the sibling route gives at length: the map draws India and
 * nothing else, so a pin outside it is one the map can never draw.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const LATITUDE_ADVICE =
  "A latitude on this map is between 6 and 38 — decimal degrees, north positive. Jaipur is 26.9124.";
const LONGITUDE_ADVICE =
  "A longitude on this map is between 68 and 98 — decimal degrees, east positive. Jaipur is 75.7873.";

/**
 * The four levels, as the corpus writes them.
 *
 * A tuple with `satisfies`, not a free string: `level` is read by the homepage map's roll-up walk
 * (components/sections/IndiaMapSection.tsx) and a fifth value invented here would be a region the walk
 * has no rule for. Spelled in capitals to match every seeded row.
 */
const LEVELS = ["NATION", "STATE", "DISTRICT", "CLUSTER"] as const satisfies readonly string[];

const createBody = z.object({
  name: z
    .string({ invalid_type_error: "Give the place a name." })
    .trim()
    .min(1, "Give the place a name.")
    .max(120, "Keep a region's name to 120 characters or fewer."),
  level: z.enum(LEVELS, {
    message: "Choose whether this is a nation, a state, a district or a cluster."
  }),
  /** Null is "top of the tree", which is what a NATION is and what an unfiled STATE may be for now. */
  parentId: z.string().trim().max(40).nullable().default(null),
  latitude: z
    .number({ invalid_type_error: LATITUDE_ADVICE })
    .min(6, LATITUDE_ADVICE)
    .max(38, LATITUDE_ADVICE)
    .nullable()
    .default(null),
  longitude: z
    .number({ invalid_type_error: LONGITUDE_ADVICE })
    .min(68, LONGITUDE_ADVICE)
    .max(98, LONGITUDE_ADVICE)
    .nullable()
    .default(null)
});

const REGION_SELECT = {
  id: true,
  slug: true,
  name: true,
  level: true,
  parentId: true,
  latitude: true,
  longitude: true
} as const satisfies Prisma.CraftRegionSelect;

type RegionRow = Prisma.CraftRegionGetPayload<{ select: typeof REGION_SELECT }>;

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Recording a region needs researcher access or higher. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, createBody);

  // Both or neither, exactly as the PATCH route requires — half a coordinate is a value that looks
  // saved and can never be drawn.
  if ((body.latitude === null) !== (body.longitude === null)) {
    throw fieldProblem(
      body.latitude === null ? "latitude" : "longitude",
      "A pin needs both numbers. Fill this one in as well, or leave both empty and place the region on the map afterwards."
    );
  }

  const slug = slugify(body.name);
  if (slug.length === 0) {
    throw fieldProblem(
      "name",
      "That name produces no web-safe address. Use at least one letter or number."
    );
  }

  if (body.parentId !== null) {
    const parent = await prisma.craftRegion.findUnique({
      where: { id: body.parentId },
      select: { id: true, name: true, level: true }
    });
    if (!parent) {
      throw fieldProblem(
        "parentId",
        "That parent region is no longer here. Reload the page and choose again."
      );
    }
    /**
     * ⚠ A REGION MAY NOT SIT UNDER SOMETHING NARROWER THAN ITSELF. A state filed under a district is a
     * tree the map's roll-up walk would climb the wrong way, and the count would surface under the
     * smaller place. The ladder is the order of `LEVELS`, so the parent's index must be strictly lower.
     */
    const parentRank = (LEVELS as readonly string[]).indexOf(parent.level);
    const ownRank = (LEVELS as readonly string[]).indexOf(body.level);
    if (parentRank === -1) {
      throw fieldProblem(
        "parentId",
        `“${parent.name}” has a level this studio does not recognise, so nothing can be filed under it.`
      );
    }
    if (parentRank >= ownRank) {
      throw fieldProblem(
        "parentId",
        `A ${body.level.toLowerCase()} cannot sit under “${parent.name}”, which is a ${parent.level.toLowerCase()}. Choose a wider place, or change the level above.`
      );
    }
  }

  const clash = await prisma.craftRegion.findUnique({ where: { slug }, select: { name: true, level: true } });
  if (clash) {
    throw conflict(
      `“${clash.name}” already uses that address (${clash.level.toLowerCase()}). Give this one a more specific name — "Kutch district" rather than "Kutch".`
    );
  }

  let created: RegionRow;
  try {
    created = await mutateWithHistory<RegionRow>(
      buildAuditContext(request, user),
      {
        action: "CREATE",
        entityType: "CraftRegion",
        entityLabel: body.name,
        /** NO REVISION, for the reason the sibling route gives: a taxonomy row has no history screen. */
        revise: false
      },
      async (tx) =>
        tx.craftRegion.create({
          data: {
            slug,
            name: body.name,
            level: body.level,
            parentId: body.parentId,
            latitude: body.latitude,
            longitude: body.longitude
          },
          select: REGION_SELECT
        })
    );
  } catch (error) {
    // `slug` is unique and the check above is a CHECK rather than a guarantee — two editors naming the
    // same place at the same moment both pass it. The index is the backstop, and the honest answer is
    // the same conflict rather than "something went wrong on our side".
    if (isUniqueViolation(error)) {
      throw conflict(
        "Another region took that address a moment ago. Reload the page and give this one a more specific name."
      );
    }
    throw error;
  }

  const placed = created.latitude !== null && created.longitude !== null;
  return ok({
    region: created,
    message: placed
      ? `“${created.name}” has been recorded and is on the homepage map at ${created.latitude}, ${created.longitude}.`
      : `“${created.name}” has been recorded. It has no pin yet, so its crafts count under the nearest parent with coordinates — place it on the map above when you know where it is.`
  });
});

/** Guarded so a mistyped method is a sentence rather than Next's bare 405. */
export const GET = route(async () => {
  throw badRequest(
    "This address records a new region. The list of regions is on the studio screen at /studio/crafts/regions."
  );
});
