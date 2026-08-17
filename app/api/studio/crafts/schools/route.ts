import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch } from "@/lib/permissions";
import { buildAuditContext, fieldProblem, isUniqueViolation, parseStudioJson } from "@/lib/studio/crud";
import { slugify } from "@/lib/utils";

/**
 * Schools and traditions — the first write surface they have ever had.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ `CraftSchool` HAD NO ROUTE AND NO SCREEN AT ALL. The model existed, `Craft.schoolId` pointed at it,
 * the craft editor offered a picker and the craft page printed the name — and nothing anywhere could
 * create one. Every craft therefore read "No school recorded", the field's help said "Leave it empty if
 * the craft belongs to no named school", and an editor who DID have a named school had no way to say so.
 * A picker with an empty list and no route to fill it is worse than an absent field: it reads as a fault.
 *
 * `CraftRegion` was in the same state one step further along — it had a screen for placing seeded regions
 * but no way to create one. `app/api/studio/crafts/regions/route.ts` closes that half; this closes this
 * one.
 *
 * WHAT A SCHOOL IS, so the shape is not mistaken for a taxonomy that needs more. A school or tradition is
 * a name, an address derived from it, and optionally a sentence saying what it is — no tree, no
 * coordinates, no publication state. `Craft.schoolId` is `onDelete: SetNull`, so removing one leaves every
 * craft in place with the field cleared, which is why a delete here is offered at all: it cannot orphan a
 * record, only un-file it.
 *
 * ⚠ THE SLUG IS DERIVED, NEVER TYPED, and it is unique. Same rule as every other taxonomy in this studio,
 * and the same two-step guard: checked so an editor gets a sentence, and caught below because a check is
 * not a guarantee when two people save at once.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const SCHOOL_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  _count: { select: { crafts: true } }
} as const satisfies Prisma.CraftSchoolSelect;

type SchoolRow = Prisma.CraftSchoolGetPayload<{ select: typeof SCHOOL_SELECT }>;

const createBody = z.object({
  name: z
    .string({ invalid_type_error: "Give the school or tradition a name." })
    .trim()
    .min(1, "Give the school or tradition a name.")
    .max(160, "Keep the name to 160 characters or fewer."),
  /**
   * `""` becomes null, for the reason the studio's shared field vocabulary states: "has a description"
   * should be one honest query rather than "not null AND not the empty string" repeated everywhere.
   */
  description: z
    .string()
    .trim()
    .max(600, "Keep this to 600 characters or fewer — it is a note, not an article.")
    .nullable()
    .default(null)
    .transform((value) => (value === null || value.length === 0 ? null : value))
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET — the list, for the picker and the screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * No pagination and no search, deliberately. A school is a named tradition and a Centre has tens of them,
 * not thousands; `crafts` counts come with each so a screen can say what removing one would un-file. If
 * this ever needs a page size it needs `listQuerySchema` from lib/studio/crud.ts rather than a hand-rolled
 * one — see rule 1 of that file's header.
 */
export const GET = route(async () => {
  await requireCapability(
    canManageResearch,
    "Schools and traditions need researcher access or higher. An administrator can raise yours."
  );

  const schools = await prisma.craftSchool.findMany({
    orderBy: { name: "asc" },
    select: SCHOOL_SELECT
  });

  return ok({ schools, total: schools.length });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST — record one
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Recording a school or tradition needs researcher access or higher. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, createBody);

  const slug = slugify(body.name);
  if (slug.length === 0) {
    throw fieldProblem(
      "name",
      "That name produces no web-safe address. Use at least one letter or number."
    );
  }

  const clash = await prisma.craftSchool.findUnique({ where: { slug }, select: { name: true } });
  if (clash) {
    throw conflict(
      `“${clash.name}” already uses that address. Give this one a more specific name if they are genuinely different traditions.`
    );
  }

  let created: SchoolRow;
  try {
    created = await mutateWithHistory<SchoolRow>(
      buildAuditContext(request, user),
      {
        action: "CREATE",
        entityType: "CraftSchool",
        entityLabel: body.name,
        /** NO REVISION: a taxonomy row with no history screen, as with regions and news categories. */
        revise: false
      },
      async (tx) =>
        tx.craftSchool.create({
          data: { slug, name: body.name, description: body.description },
          select: SCHOOL_SELECT
        })
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(
        "Another school took that address a moment ago. Reload the page and give this one a more specific name."
      );
    }
    throw error;
  }

  return ok({
    school: created,
    message: `“${created.name}” has been recorded. It is now offered on every craft's “School or tradition” field.`
  });
});
