import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch } from "@/lib/permissions";
import { buildAuditContext, found, parseStudioJson } from "@/lib/studio/crud";

/**
 * One school or tradition: correct its wording, or remove one nothing uses.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ RENAMING DOES NOT CHANGE THE WEB ADDRESS, AND THE SCREEN SAYS SO. A school's slug is a PUBLIC query
 * parameter — `/craft-explorer?school=pattachitra-raghurajpur` is built by
 * app/(site)/craft-explorer/[slug]/page.tsx for every craft filed under one, so it is a link a reader can
 * have bookmarked or a colleague can have pasted into a paper. Re-deriving the address from a corrected
 * spelling would break those links with nothing on screen to say it had happened. A school that genuinely
 * needs a new address is a new school with the crafts re-filed onto it, which is work an editor does
 * deliberately rather than a side effect of fixing a typo. This is the same rule the newsroom's categories
 * and tags follow (app/api/studio/news/categories/[id]/route.ts).
 *
 * ⚠ A SCHOOL IN USE IS NOT DELETED, AND THERE IS NO MERGE HERE — the two facts belong together. The
 * newsroom offers "merge into another category", which moves every article and then removes the term in one
 * step; that route exists because filing an article under a category is MANDATORY there, so a category
 * cannot simply be cleared. `Craft.schoolId` is optional and `onDelete: SetNull`, so the equivalent
 * operation is "clear the field", which the craft's own editor already does one craft at a time. Adding a
 * merge would be a second writer for `Craft.schoolId` — the same objection app/studio/crafts/regions/page.tsx
 * records at length about filing crafts from the region screen — so the refusal below names the count and
 * links to the crafts instead, and the editor clears them where that column is already owned.
 *
 * A DELETE IS OFFERED AT ALL because a school is otherwise unrecoverable from the studio: it has no
 * `deletedAt` column and no recycle bin, so a name recorded with a typo would sit in every craft's picker
 * for good. What the refusal protects is not the school, it is the crafts.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const patchBody = z.object({
  name: z
    .string({ invalid_type_error: "Give the school or tradition a name." })
    .trim()
    .min(1, "Give the school or tradition a name.")
    .max(160, "Keep the name to 160 characters or fewer."),
  /** `""` becomes null, so "has a description" stays one honest query — see the POST route's note. */
  description: z
    .string()
    .trim()
    .max(600, "Keep this to 600 characters or fewer — it is a note, not an article.")
    .nullable()
    .default(null)
    .transform((value) => (value === null || value.length === 0 ? null : value))
});

const SCHOOL_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  _count: { select: { crafts: true } }
} as const satisfies Prisma.CraftSchoolSelect;

type SchoolRow = Prisma.CraftSchoolGetPayload<{ select: typeof SCHOOL_SELECT }>;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** "1 craft" / "9 crafts". Written out, because an English plural is not a suffix rule worth guessing. */
function crafts(count: number): string {
  return count === 1 ? "1 craft" : `${count} crafts`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — correct the name or the note
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Editing a school or tradition needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, patchBody);

  const existing = found(
    await prisma.craftSchool.findUnique({ where: { id }, select: SCHOOL_SELECT }),
    "That school"
  );

  if (body.name === existing.name && body.description === existing.description) {
    // Answered as success, not as an error: there is nothing for the screen to fix, and reporting a
    // failure for a save with nothing to do is the more confusing of the two.
    return ok({
      school: existing,
      changed: false,
      message: "Nothing was different, so nothing has been changed."
    });
  }

  const renamed = body.name !== existing.name;

  const updated = await mutateWithHistory<SchoolRow>(
    buildAuditContext(request, user),
    {
      action: "UPDATE",
      entityType: "CraftSchool",
      entityLabel: body.name,
      before: { name: existing.name, description: existing.description },
      /** NO REVISION: a taxonomy row with no history screen, as with regions and news categories. */
      revise: false
    },
    async (tx) =>
      tx.craftSchool.update({
        where: { id },
        // ⚠ `slug` IS NOT IN HERE, and that is the header's first rule rather than an omission.
        data: { name: body.name, description: body.description },
        select: SCHOOL_SELECT
      })
  );

  return ok({
    school: updated,
    changed: true,
    message: renamed
      ? `“${existing.name}” now reads “${updated.name}”. Its web address is still ?school=${updated.slug}, so existing links keep working.`
      : `The note on “${updated.name}” has been saved.`
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — only when nothing is filed under it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Removing a school or tradition needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const existing = found(
    await prisma.craftSchool.findUnique({
      where: { id },
      select: {
        ...SCHOOL_SELECT,
        // Live crafts only, to match the number the screen shows beside each row.
        _count: { select: { crafts: { where: { deletedAt: null } } } }
      }
    }),
    "That school"
  );

  const inUse = existing._count.crafts;

  /**
   * Crafts in the recycle bin, counted separately.
   *
   * They do not BLOCK the delete — a recycled craft is not on the site and nobody is reading its school —
   * but restoring one afterwards would silently find the field cleared, so the answer says so. Nobody can
   * see these rows from the schools screen, which is exactly why they have to be stated.
   */
  const recycled = await prisma.craft.count({
    where: { schoolId: id, deletedAt: { not: null } }
  });

  if (inUse > 0) {
    // THE COUNT IS IN THE REFUSAL, and so is the way forward — see the header for why that way is the
    // craft's own editor rather than a merge offered here.
    throw conflict(
      `“${existing.name}” cannot be removed while ${crafts(inUse)} ${inUse === 1 ? "is" : "are"} filed under it. Open ${inUse === 1 ? "that craft" : "those crafts"} and clear “School or tradition” on ${inUse === 1 ? "it" : "each"}, then remove this one. The link beside the count on the schools screen lists ${inUse === 1 ? "it" : "them"}.`
    );
  }

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "CraftSchool",
      entityLabel: existing.name,
      // The whole row: a school is HARD-deleted, so this audit entry is the only surviving record of
      // what was removed.
      before: {
        name: existing.name,
        slug: existing.slug,
        description: existing.description,
        craftsInRecycleBin: recycled
      },
      revise: false
    },
    async (tx) => {
      await tx.craftSchool.delete({ where: { id } });
      // Nothing to re-index: no live craft was filed under it, and a recycled craft is not in the
      // search index in the first place.
      return { id };
    }
  );

  return ok({
    deleted: true,
    name: existing.name,
    slug: existing.slug,
    craftsInRecycleBin: recycled,
    message:
      `“${existing.name}” has been removed, and ?school=${existing.slug} no longer narrows the archive to anything.` +
      (recycled > 0
        ? ` ${crafts(recycled)} in the recycle bin ${recycled === 1 ? "was" : "were"} filed under it, so restoring ${recycled === 1 ? "it" : "them"} will need a school choosing again.`
        : "")
  });
});
