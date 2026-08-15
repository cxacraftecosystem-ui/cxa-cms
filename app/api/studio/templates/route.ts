import type { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import {
  assertSameOrigin,
  badRequest,
  clientIp,
  conflict,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import {
  PAGE_TEMPLATES,
  TEMPLATE_LIMITS,
  findPageTemplate,
  mergePageTemplates,
  pageTemplate,
  readStoredBlocks,
  storedTemplateFromRow,
  type PageTemplateListResponse,
  type RemovedPageTemplate,
  type TemplateBlockSpec
} from "@/lib/page-templates";
import { canManageStructure } from "@/lib/permissions";
import { slugify } from "@/lib/utils";

/**
 * Page templates: the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT A TEMPLATE ROW IS. An ordered list of BLOCK TYPES with an editor-facing name for each, and never
 * a block payload — the rule lib/page-templates.ts exists to state, and the reason a template written
 * last year cannot go stale. Nothing in this file writes a payload, and `readStoredBlocks()` drops any
 * key other than `type`, `label`, `purpose` and `overrides` on the way back out.
 *
 * `GET` ANSWERS THE MERGED LIST, NOT THE TABLE. The built-ins in lib/page-templates.ts and the rows here
 * are one list to everybody who uses this studio, so they are merged in one place —
 * `mergePageTemplates()` — rather than in each screen that shows them. The answer carries hidden
 * templates as well, because the manager has to list a retired one in order to bring it back; the
 * chooser filters them with `visiblePageTemplates()`.
 *
 * AND IT ANSWERS THE REMOVED ONES TOO. `BIN_TYPES` in app/api/studio/recycle-bin/route.ts has no entry
 * for a template, so a soft-deleted row is reachable from nowhere else in the studio. Listing them here
 * is what makes the soft delete honest rather than a disappearance (contract §1.6). The same accepted
 * arrangement as announcements, which carry the same note.
 *
 * ⚠ `key` IS UNIQUE ACROSS REMOVED ROWS AS WELL, so a new template can collide with one that is in the
 * removed list and cannot be seen. The conflict below says exactly that, and says where to look — a
 * bare "that name is taken" would send an administrator hunting a template that is not on the screen.
 *
 * ⚠ EVERY NEW ROW ARRIVES HIDDEN, EXCEPT A CUSTOMISED BUILT-IN. A blank template has no blocks yet and
 * a copy has not been renamed yet; either one appearing in the chooser the instant it is created is a
 * half-made arrangement offered to a colleague. A customisation is the exception and has to be: it takes
 * a built-in's key, so hiding it would withdraw the built-in it replaced.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many rows one answer carries.
 *
 * Generous, because a studio with more than a hundred page templates has a different problem from
 * pagination — and stated in the answer either way, so a truncated list is never mistaken for the whole
 * one (contract §1.6).
 */
const ROW_LIMIT = 100;
const REMOVED_LIMIT = 25;

/** How many numbered keys are tried before giving up. The same loop, and the same ceiling, as the pages one. */
const KEY_ATTEMPTS = 50;

/** The columns the merge needs. Kept as one constant so the two reads below cannot drift apart. */
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
  updatedAt: true
} satisfies Prisma.PageTemplateSelect;

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

/** A `Json` column that is NOT nullable takes `InputJsonValue`; the cast restates what Zod already checked. */
function blocksColumn(blocks: readonly TemplateBlockSpec[]): Prisma.InputJsonValue {
  return blocks as unknown as Prisma.InputJsonValue;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  await requireCapability(
    canManageStructure,
    "Page templates need editor access or higher, because using one creates a page. An administrator can raise yours."
  );

  const [rows, rowCount, removedRows, removedTotal] = await Promise.all([
    prisma.pageTemplate.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      take: ROW_LIMIT,
      select: ROW_SELECT
    }),
    prisma.pageTemplate.count({ where: { deletedAt: null } }),
    prisma.pageTemplate.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      take: REMOVED_LIMIT,
      select: { id: true, key: true, name: true, blocks: true, deletedAt: true }
    }),
    prisma.pageTemplate.count({ where: { deletedAt: { not: null } } })
  ]);

  const removed: RemovedPageTemplate[] = removedRows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    // Counted through the same reader the merge uses, so the number beside a removed template is the
    // number of blocks it would actually create — not the length of whatever is in the column.
    blockCount: readStoredBlocks(row.blocks, row.name).blocks.length,
    // Non-null by the `where` above; the fallback exists because TypeScript cannot see that.
    deletedAt: (row.deletedAt ?? new Date()).toISOString()
  }));

  const body: PageTemplateListResponse = {
    items: mergePageTemplates(rows.map(storedTemplateFromRow)),
    rowCount,
    truncated: rowCount > rows.length,
    limit: ROW_LIMIT,
    removed,
    removedTotal,
    removedTruncated: removedTotal > removed.length
  };

  return ok(body);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The three ways a template comes into being, in one body.
 *
 * `from` absent — a blank template with a name and no blocks. `from` present — a copy of that
 * arrangement under a key of its own. `from` present with `replaceBuiltIn` — a copy that TAKES the
 * built-in's key, so it stands in its place everywhere from the moment it is saved.
 *
 * There is no `blocks` here on purpose. A template is built in the editor, which sends a PATCH; letting
 * a creation carry an arbitrary list would mean two places validating the same rule, and the one that
 * eventually disagrees is the one an administrator is not looking at.
 */
const CreateBody = z.object({
  name: z
    .string()
    .trim()
    .max(TEMPLATE_LIMITS.name, `Keep the name to ${TEMPLATE_LIMITS.name} characters or fewer.`)
    .optional(),
  from: z.string().trim().min(1).max(TEMPLATE_LIMITS.key).optional(),
  replaceBuiltIn: z.boolean().optional(),
  isHidden: z.boolean().optional()
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageStructure,
    "Creating a page template needs editor access or higher, because every colleague who makes a page is offered it. An administrator can raise yours."
  );

  const body = await parseJson(request, CreateBody);

  /**
   * EVERY key, including the removed ones.
   *
   * `PageTemplate.key` is unique across soft-deleted rows too, so a candidate that collides with one in
   * the recycle list would fail at the database with a P2002 nobody can act on. Reading them here turns
   * that into a sentence saying where the template actually is.
   */
  const existing = await prisma.pageTemplate.findMany({
    select: { key: true, name: true, deletedAt: true }
  });
  const taken = new Map(existing.map((row) => [row.key, row] as const));

  const liveRows = await prisma.pageTemplate.findMany({
    where: { deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    take: ROW_LIMIT,
    select: ROW_SELECT
  });
  const merged = mergePageTemplates(liveRows.map(storedTemplateFromRow));

  const source = body.from ? findPageTemplate(merged, body.from) : null;
  if (body.from && !source) {
    throw badRequest(
      `There is no template called “${body.from}” to copy. It may have been removed since this screen was opened. Nothing has been created.`
    );
  }

  const name = (body.name ?? "").trim() || (source ? `${source.name} (copy)` : "");
  if (name.length === 0) {
    throw badRequest(
      "The template needs a name before it can be created. It is what a colleague chooses it by. Nothing has been created."
    );
  }

  let key: string;

  if (body.replaceBuiltIn) {
    // Only a built-in can be stood in for. Replacing a row would mean two rows with one key, which the
    // unique index refuses anyway — and "edit it" is what somebody wanting that actually means.
    const builtIn = body.from ? pageTemplate(body.from) : null;
    if (!builtIn) {
      throw badRequest(
        "Only one of the templates that ship with this software can be customised in place. To change a template somebody here wrote, open it and edit it. Nothing has been created."
      );
    }

    const clash = taken.get(builtIn.id);
    if (clash) {
      throw conflict(
        clash.deletedAt
          ? `“${builtIn.name}” has already been customised once, and that customisation is in the removed list at the foot of the templates screen. Put it back and edit it, rather than starting again.`
          : `“${builtIn.name}” has already been customised — “${clash.name}” stands in its place. Open that one and edit it.`
      );
    }

    key = builtIn.id;
  } else {
    const base = slugify(name);
    if (base.length === 0) {
      throw badRequest(
        "That name cannot be turned into a short code, because it has no letters or numbers in it. Give the template a name with some words in it. Nothing has been created."
      );
    }

    // Built-in ids are treated as taken here: a template accidentally named "Exhibition" must not
    // silently replace the built-in of that name. Standing in for one is the deliberate act above.
    const reserved = new Set<string>([...PAGE_TEMPLATES.map((entry) => entry.id), ...taken.keys()]);

    let candidate = "";
    for (let attempt = 1; attempt <= KEY_ATTEMPTS; attempt += 1) {
      const next = attempt === 1 ? base : `${base}-${attempt}`;
      if (!reserved.has(next)) {
        candidate = next;
        break;
      }
    }

    if (candidate.length === 0) {
      throw conflict(
        "There are already templates under every short code this name suggests. Give it a slightly different name. Nothing has been created."
      );
    }

    key = candidate;
  }

  const blocks: TemplateBlockSpec[] = source ? source.blocks.map((block) => ({ ...block })) : [];

  /**
   * Hidden unless it is standing in for a built-in. See the file header: an unfinished arrangement in
   * the chooser is a half-made page offered to a colleague, and a customisation that arrived hidden
   * would withdraw the built-in whose place it takes.
   */
  const isHidden = body.isHidden ?? !body.replaceBuiltIn;

  const created = await mutateWithHistory<{ id: string; key: string; name: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "CREATE",
      entityType: "PageTemplate",
      entityLabel: name,
      summary: body.replaceBuiltIn
        ? `Customised the built-in “${source?.name ?? key}” template`
        : source
          ? `Copied from “${source.name}”`
          : "Created"
    },
    async (tx) =>
      tx.pageTemplate.create({
        data: {
          key,
          name,
          description: source?.description ?? "",
          suggestedTitle: source?.suggestedTitle ?? "",
          icon: source?.icon ?? "",
          blocks: blocksColumn(blocks),
          isHidden,
          // At the end of the custom templates rather than at the top. Somebody creating one has not
          // decided where it belongs yet, and putting it first would move every other one down.
          sortOrder: liveRows.length
        },
        select: { id: true, key: true, name: true, description: true, isHidden: true, sortOrder: true }
      })
  );

  return ok(
    {
      id: created.id,
      key: created.key,
      name: created.name,
      isHidden,
      message: body.replaceBuiltIn
        ? `“${created.name}” now stands in place of the template that ships with the software. Removing it brings the original back.`
        : isHidden
          ? `“${created.name}” has been created but is not offered yet. Build its blocks, then switch it on.`
          : `“${created.name}” has been created.`
    },
    { status: 201 }
  );
});
