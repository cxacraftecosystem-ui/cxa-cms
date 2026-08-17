import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  conflict,
  ok,
  route,
  userAgent
} from "@/lib/api";
import { parseStudioJson } from "@/lib/studio/crud";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { slugify } from "@/lib/utils";

/**
 * The media library's folders: the flat list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LIST IS FLAT AND THE TREE IS ASSEMBLED IN THE BROWSER (`FolderTree`), so the whole hierarchy is
 * ONE query rather than one per level. That is what the materialised `path` column is for: a subtree is
 * a prefix match, and the path doubles as a stable total sort key because it is unique.
 *
 * `assetCount` COUNTS ONLY WHAT IS FILED DIRECTLY IN THE FOLDER, and it EXCLUDES THE RECYCLE BIN. Both
 * halves matter: the number is what refuses a delete ("12 files are filed here"), and counting
 * soft-deleted files in it would refuse a delete on the strength of files nobody can see.
 *
 * THE PATH IS DERIVED FROM THE NAME AND IS NOT A SECOND NAME TO KEEP IN STEP. `name` is what a person
 * reads; `path` is the machine handle — lower case, hyphenated, unique. Renaming rebuilds it, and
 * rebuilding it rebuilds every descendant's, which is why a rename lives in the `[id]` handler and
 * happens in one transaction.
 *
 * FOLDERS ARE FILING, NOT PUBLISHING. Nothing about a folder appears on the public site, so there is no
 * status, no soft delete and no recycle bin here — a folder is a label on a drawer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How deep the tree may go.
 *
 * Not an arbitrary tidiness rule: `MediaFolder.parentId` cascades on delete, the browser assembles the
 * tree recursively, and `path` is a single column. A cap that is checked is better than a stack the
 * fifteenth level down. Eight is deeper than any real filing anybody has described.
 */
const MAX_DEPTH = 8;

/** Names past this stop being labels and start being descriptions. */
const MAX_NAME = 80;

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  await requireCapability(
    canManageMedia,
    "The media library needs media manager access or higher. An administrator can raise yours."
  );

  const rows = await prisma.mediaFolder.findMany({
    select: {
      id: true,
      name: true,
      parentId: true,
      path: true,
      // A FILTERED relation count, so a tree twenty folders deep is one query rather than twenty round
      // trips for twenty small integers — and the filter is what keeps the recycle bin out of the
      // number beside a folder name.
      _count: { select: { assets: { where: { deletedAt: null } } } }
    },
    // The unique path is a total order, so the list never reshuffles between requests. An unstable sort
    // renders a different tree every time and reads as data changing under the reader.
    orderBy: { path: "asc" }
  });

  return ok({
    items: rows.map((folder) => ({
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId,
      path: folder.path,
      assetCount: folder._count.assets
    }))
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const CreateBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the folder a name.")
    .max(MAX_NAME, `Keep the name to ${MAX_NAME} characters or fewer.`),
  /**
   * `null` means the top level. Sent EXPLICITLY by `FolderTree` rather than omitted, because Zod's
   * `.default()` fires for a missing key and never for an explicit `null` (contract §14) — so both
   * spellings are accepted here and mean the same thing.
   */
  parentId: z.string().trim().min(1).max(64).nullable().optional()
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Creating a folder needs media manager access or higher. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, CreateBody);
  const parentId = body.parentId ?? null;

  let parentPath = "";
  if (parentId) {
    const parent = await prisma.mediaFolder.findUnique({
      where: { id: parentId },
      select: { path: true }
    });
    if (!parent) {
      throw badRequest(
        "The folder this was going inside no longer exists. Reload the media library and try again."
      );
    }
    parentPath = parent.path;

    // The depth is read off the materialised path — one leading slash per level — so no walk up the
    // tree is needed and a cycle in the data cannot make this loop.
    const depth = parentPath.split("/").filter(Boolean).length;
    if (depth >= MAX_DEPTH) {
      throw badRequest(
        `Folders can only be ${MAX_DEPTH} levels deep and “${parentPath}” is already at the bottom. ` +
          "Use tags rather than more levels — they are what the search box actually reads."
      );
    }
  }

  const segment = slugify(body.name);
  if (segment.length === 0) {
    // A name of only punctuation or only non-Latin script slugifies to nothing, and a folder with no
    // path cannot be stored. Said plainly rather than answered with a constraint violation.
    throw badRequest(
      "That name cannot be turned into a folder address. Include at least one letter or number in it."
    );
  }

  const path = `${parentPath}/${segment}`;

  const clash = await prisma.mediaFolder.findUnique({ where: { path }, select: { name: true } });
  if (clash) {
    throw conflict(
      `There is already a folder called “${clash.name}” in the same place. Give this one a different name.`
    );
  }

  const created = await mutateWithHistory<{
    id: string;
    name: string;
    parentId: string | null;
    path: string;
  }>(
    auditContext(request, { id: user.id, email: user.email }),
    { action: "CREATE", entityType: "MediaFolder", entityLabel: path, summary: "Folder created" },
    async (tx) =>
      tx.mediaFolder.create({
        data: { name: body.name, parentId, path },
        select: { id: true, name: true, parentId: true, path: true }
      })
  );

  // A brand-new folder holds nothing, so the count is a known zero rather than a query.
  return ok({ ...created, assetCount: 0 }, { status: 201 });
});
