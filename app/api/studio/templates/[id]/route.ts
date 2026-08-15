import type { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import {
  assertSameOrigin,
  badRequest,
  clientIp,
  notFound,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import {
  TEMPLATE_LIMITS,
  pageTemplate,
  readStoredBlocks,
  templateProblems,
  type TemplateBlockSpec
} from "@/lib/page-templates";
import { canManageStructure } from "@/lib/permissions";

/**
 * One page template: save it, retire it, put it back, or move it to the removed list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `PATCH` IS PARTIAL, AND IT HAS TO BE. The editor sends the whole template on Save, but the manager's
 * "Do not offer this" switch sends `{ isHidden: true }` and nothing else. A schema that required the
 * full record would answer 422 to the switch, and one that read an absent key as empty would blank the
 * description of everything anybody retired.
 *
 * ⚠ THE BLOCK LIST IS READ BY `readStoredBlocks()` — THE SAME FUNCTION THE SCREENS READ THE COLUMN WITH.
 * One reader means a block type this build does not know is treated identically on the way in and on the
 * way out. The difference is what happens next: reading tolerates it and says so, WRITING refuses. A save
 * that quietly dropped a block would be a template silently shorter than the one on screen.
 *
 * ⚠ AN ARRANGEMENT WITH PROBLEMS MAY BE SAVED, BUT NOT OFFERED. `templateProblems()` — the same function
 * the editor screen prints under the block list — is checked here whenever the result would be visible.
 * Refusing the save outright would strand somebody halfway through building a list; refusing to OFFER a
 * template the page builder itself would refuse to rebuild is the rule that actually matters. The
 * sentences are identical in both places because they come from the one function.
 *
 * ⚠ THE KEY CANNOT BE CHANGED, AND THERE IS NO FIELD FOR IT HERE. A key is what a row uses to stand in
 * place of a built-in, so editing one would silently withdraw a customisation and restore the original
 * under an administrator who thought they were renaming something. Copy it and remove the old one.
 *
 * `DELETE` IS SOFT, AND THE REMOVED ONES ARE LISTED ON THE TEMPLATES SCREEN. `BIN_TYPES` in the
 * recycle-bin route has no entry for a template, so that screen is the only place one can be reached
 * from — the same accepted arrangement as announcements.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * One block, on the wire.
 *
 * `type` is a plain bounded string rather than the `SectionType` enum: the value is checked against the
 * live registry by `readStoredBlocks()`, which is the list that decides what this build can draw, and a
 * second enumeration here would be a copy of it that eventually disagrees.
 *
 * `overrides` is opaque. It is merged over the seeded default and re-parsed by `parseSectionData()` at
 * the moment of use, which strips any key that no longer exists — so an override cannot make an invalid
 * payload however wrong it is, and validating its shape here would be a third schema for one thing.
 */
const BlockBody = z.object({
  type: z.string().trim().min(1).max(64),
  label: z.string().trim().max(TEMPLATE_LIMITS.blockLabel).optional(),
  purpose: z.string().trim().max(TEMPLATE_LIMITS.blockPurpose).optional(),
  overrides: z.record(z.unknown()).optional()
});

const PatchBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "The template needs a name. It is what a colleague chooses it by.")
    .max(TEMPLATE_LIMITS.name, `Keep the name to ${TEMPLATE_LIMITS.name} characters or fewer.`)
    .optional(),
  description: z
    .string()
    .trim()
    .max(
      TEMPLATE_LIMITS.description,
      `Keep the description to ${TEMPLATE_LIMITS.description} characters or fewer.`
    )
    .optional(),
  suggestedTitle: z
    .string()
    .trim()
    .max(
      TEMPLATE_LIMITS.suggestedTitle,
      `Keep the suggested title to ${TEMPLATE_LIMITS.suggestedTitle} characters or fewer — it is typed straight into the page title, which stops there.`
    )
    .optional(),
  /**
   * A lucide export name, or the empty string for none.
   *
   * Checked by SHAPE only, exactly as the research route checks a feature icon and for the same reason:
   * the authoritative list is `TEMPLATE_ICON_NAMES` in components/studio/templates/templateIcons.ts,
   * which is a renderer's list, and pulling the icon set into an API route to check a string is the
   * wrong dependency. It is safe to be lenient because `templateIcon()` never throws — an unrecognised
   * name draws the neutral template glyph rather than leaving a blank square.
   */
  icon: z
    .union([
      z
        .string()
        .trim()
        .max(TEMPLATE_LIMITS.icon)
        .regex(
          /^[A-Z][A-Za-z0-9]*$/,
          "An icon name looks like “Frame” or “GraduationCap” — capitalised, no spaces."
        ),
      z.literal("")
    ])
    .optional(),
  blocks: z
    .array(BlockBody)
    .max(
      TEMPLATE_LIMITS.blocks,
      `A template holds at most ${TEMPLATE_LIMITS.blocks} blocks. A page longer than that is two pages.`
    )
    .optional(),
  isHidden: z.boolean().optional(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
  /** Only meaningful on a removed template. Everything else is ignored alongside it. */
  restore: z.boolean().optional()
});

/** The columns an answer and an audit entry need. One constant, so the reads cannot drift apart. */
const ROW_SELECT = {
  id: true,
  key: true,
  name: true,
  description: true,
  suggestedTitle: true,
  icon: true,
  blocks: true,
  isHidden: true,
  sortOrder: true,
  updatedAt: true,
  deletedAt: true
} satisfies Prisma.PageTemplateSelect;

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

function blocksColumn(blocks: readonly TemplateBlockSpec[]): Prisma.InputJsonValue {
  return blocks as unknown as Prisma.InputJsonValue;
}

/** "…stands in place of the built-in X" — said wherever it matters, because it changes what removal does. */
function shadowedBuiltInName(key: string): string | null {
  return pageTemplate(key)?.name ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageStructure,
    "Editing a page template needs editor access or higher, because every colleague who makes a page is offered it. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseJson(request, PatchBody);

  // Removed rows are found too: putting one back is a PATCH, and a `where` that excluded them would
  // answer "that template does not exist" about a template sitting in the removed list.
  const before = await prisma.pageTemplate.findUnique({ where: { id }, select: ROW_SELECT });
  if (!before) throw notFound("That page template");

  // ── Putting one back ─────────────────────────────────────────────────────────────────────────
  if (body.restore) {
    if (!before.deletedAt) {
      throw badRequest(
        `“${before.name}” has not been removed, so there is nothing to put back. Nothing has been changed.`
      );
    }

    const restored = await mutateWithHistory<{ id: string; name: string; key: string }>(
      auditContext(request, { id: user.id, email: user.email }),
      {
        action: "RESTORE",
        entityType: "PageTemplate",
        entityLabel: before.name,
        before,
        summary: "Put back from the removed list"
      },
      async (tx) =>
        tx.pageTemplate.update({
          where: { id },
          data: {
            deletedAt: null,
            // Back, but RETIRED. A template that reappeared in the chooser the instant it was restored
            // would be offered to a colleague before anybody had looked at whether it is still right —
            // the same reasoning as a restored announcement coming back switched off.
            isHidden: true
          },
          select: ROW_SELECT
        })
    );

    return ok({
      ...restored,
      message: `“${restored.name}” is back in the list, but is not offered yet. Check it, then switch it on.`
    });
  }

  if (before.deletedAt) {
    throw badRequest(
      `“${before.name}” is in the removed list at the foot of the templates screen. Put it back before editing it. Nothing has been changed.`
    );
  }

  // ── An ordinary save ─────────────────────────────────────────────────────────────────────────
  const name = body.name ?? before.name;
  const isHidden = body.isHidden ?? before.isHidden;

  /**
   * The block list this save would leave behind.
   *
   * When the body carries one it is read — and a block this build cannot draw is a REFUSAL here rather
   * than the quiet omission it is on a read. When it does not, the stored one is re-read so the checks
   * below judge the same list a reader would see.
   */
  let blocks: TemplateBlockSpec[];
  if (body.blocks) {
    const read = readStoredBlocks(body.blocks, name);
    if (read.problems.length > 0) {
      throw badRequest(`${read.problems.join(" ")} Nothing has been saved.`);
    }
    blocks = read.blocks;
  } else {
    blocks = readStoredBlocks(before.blocks, name).blocks;
  }

  /**
   * A template that is OFFERED must be one the page builder would agree to rebuild.
   *
   * Only checked when it would be visible: an unfinished arrangement is a normal state to save from, and
   * refusing it would leave somebody's half-built list nowhere to go. The sentences are `templateProblems()`'s
   * own, so the screen and the server explain the refusal in identical words.
   */
  if (!isHidden) {
    const problems = templateProblems({ name, blocks });
    if (problems.length > 0) {
      throw badRequest(
        `${problems.join(" ")} Switch the template off, or fix the list, and try again. Nothing has been saved.`
      );
    }
  }

  const data: Prisma.PageTemplateUpdateInput = {};
  if (body.name !== undefined) data.name = name;
  if (body.description !== undefined) data.description = body.description;
  if (body.suggestedTitle !== undefined) data.suggestedTitle = body.suggestedTitle;
  if (body.icon !== undefined) data.icon = body.icon;
  if (body.blocks !== undefined) data.blocks = blocksColumn(blocks);
  if (body.isHidden !== undefined) data.isHidden = body.isHidden;
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;

  // Nothing to write is not an error: the editor sends what it holds, and a save with no change is a
  // reader pressing Save twice. Answering the row keeps the screen's picture of it correct either way.
  if (Object.keys(data).length === 0) return ok(before);

  const updated = await mutateWithHistory<typeof before>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "UPDATE",
      entityType: "PageTemplate",
      entityLabel: name,
      before,
      summary:
        body.isHidden === true && !before.isHidden
          ? "Retired — no longer offered when creating a page"
          : body.isHidden === false && before.isHidden
            ? "Offered when creating a page"
            : "Edited"
    },
    async (tx) => tx.pageTemplate.update({ where: { id }, data, select: ROW_SELECT })
  );

  const shadowed = shadowedBuiltInName(updated.key);

  return ok({
    ...updated,
    message: isHidden
      ? shadowed
        ? `“${updated.name}” has been saved. It is switched off, and because it stands in place of the built-in “${shadowed}”, that template is not offered either. Remove this one to bring the original back.`
        : `“${updated.name}” has been saved. It is switched off, so it is not offered when a page is created.`
      : `“${updated.name}” has been saved, and is offered whenever somebody creates a page.`
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — soft, always
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageStructure,
    "Removing a page template needs editor access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const template = await prisma.pageTemplate.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, key: true, name: true, isHidden: true, blocks: true }
  });
  if (!template) throw notFound("That page template");

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "PageTemplate",
      entityLabel: template.name,
      before: { key: template.key, name: template.name, isHidden: template.isHidden },
      // A delete is logged but not versioned: there is no new content to snapshot, and the last
      // revision already holds the row as it stood.
      revise: false
    },
    async (tx) =>
      tx.pageTemplate.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true }
      })
  );

  const shadowed = shadowedBuiltInName(template.key);

  return ok({
    deleted: true,
    id: template.id,
    name: template.name,
    key: template.key,
    /** Whether the built-in it was standing in for has just come back. The single most surprising consequence. */
    builtInRestored: shadowed !== null,
    message: shadowed
      ? `“${template.name}” has been removed, and the built-in “${shadowed}” it stood in place of is offered again. ` +
        "Nothing that was created from it has changed — a page keeps the blocks it was given."
      : `“${template.name}” has been removed. It is in the removed list at the foot of the templates screen, ` +
        "where it can be put back. Nothing that was created from it has changed — a page keeps the blocks it was given."
  });
});
