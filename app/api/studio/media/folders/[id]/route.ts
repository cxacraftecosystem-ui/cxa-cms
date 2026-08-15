import type { NextRequest } from "next/server";
import { z } from "zod";
// `Prisma` is imported as a VALUE: `Prisma.sql` is the tagged-template helper, and the one raw statement
// in this file is the reason it is needed. Nothing here concatenates a query string.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  conflict,
  notFound,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { isUniqueViolation } from "@/lib/studio/crud";
import { slugify } from "@/lib/utils";

/**
 * One media-library folder: rename it, move it, or delete it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ BOTH HANDLERS ANSWER `MediaFolderNode` from components/studio/media/MediaGrid.tsx —
 * `{ id, name, parentId, path, assetCount }` — because `FolderTree` puts the answer straight back into
 * the tree it is already showing. `assetCount` EXCLUDES the recycle bin, exactly as the list handler's
 * does, and that agreement is load-bearing: it is the number the tree uses to decide whether to offer
 * Delete at all, so a differently-counted number here would show an enabled button that always refuses.
 *
 * ══ THE MATERIALISED `path` IS THE WHOLE POINT OF THIS FILE ══
 *
 * `MediaFolder.path` is a unique, materialised "/events/2026/convocation". It exists so that reading a
 * subtree is a prefix match and the whole tree is ONE query (see the list handler). The cost of that is
 * paid HERE: a rename or a move has to rewrite the path of the folder **and of every folder beneath it**,
 * or the descendants keep a path that no longer describes where they are — a silently orphaned subtree
 * that still appears in the tree, still counts its files, and can never be reached by a prefix query
 * again. So:
 *
 *   • the rewrite is ONE `UPDATE` over the whole subtree, not a row-by-row loop. A loop that fails
 *     half-way leaves exactly the inconsistency the column exists to prevent, and the statement below is
 *     inside the same transaction as the folder's own update;
 *   • a MOVE is refused BEFORE anything is written when it would make a folder its own descendant. The
 *     test is on the paths: the proposed parent's path may not be the folder's path, nor begin with it.
 *     Writing first and detecting afterwards is not an option — a cycle in `parentId` makes the browser's
 *     tree assembly recurse forever, and no later request can repair a subtree it cannot walk;
 *   • the DEPTH cap is re-checked against the DEEPEST descendant, not just the folder being moved. The
 *     create handler refuses an eighth level; moving a three-deep subtree under a six-deep parent would
 *     otherwise reach eleven by the back door.
 *
 * ⚠ A FOLDER IS HARD-DELETED, AND THAT IS NOT A BREACH OF THE SOFT-DELETE RULE. `MediaFolder` has no
 * `deletedAt` column because a folder is FILING, not publishing: nothing about it appears on the public
 * site, no URL points at it, and it can be created again in a moment. The rule protects CONTENT, and the
 * content — the files inside — is exactly what this handler refuses to delete alongside it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ Mirrors `MAX_DEPTH` in the sibling list handler. Both must move together. */
const MAX_DEPTH = 8;

/** ⚠ Mirrors `MAX_NAME` in the sibling list handler. Names past this stop being labels. */
const MAX_NAME = 80;

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

/** Levels in a materialised path — one leading slash per level, so no walk up the tree is needed. */
function depthOf(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/** The last part of a path: the folder's own address segment. */
function lastSegmentOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Files filed DIRECTLY in a folder, recycle bin excluded — the number the tree renders. */
function liveAssetCount(folderId: string): Promise<number> {
  return prisma.mediaAsset.count({ where: { folderId, deletedAt: null } });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — rename, move, or both
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PatchBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the folder a name.")
    .max(MAX_NAME, `Keep the name to ${MAX_NAME} characters or fewer.`)
    .optional(),
  /**
   * `null` means the top level, and it is sent EXPLICITLY by `FolderTree` rather than omitted. Zod's
   * `.default()` fires for a missing key and never for an explicit `null` (contract §14), so this is
   * `.nullable().optional()`: an ABSENT key means "leave the filing alone" and `null` means "move it to
   * the top level". Those are two different instructions and they must not be spelled the same way.
   */
  parentId: z.string().trim().min(1).max(64).nullable().optional()
});

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Changing a folder needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseJson(request, PatchBody);

  const folder = await prisma.mediaFolder.findUnique({
    where: { id },
    select: { id: true, name: true, parentId: true, path: true }
  });
  if (!folder) throw notFound("That folder");

  const nextName = body.name ?? folder.name;
  // `in` rather than `!== undefined`: an explicit `null` is a real instruction here. See the schema.
  const nextParentId = "parentId" in body ? (body.parentId ?? null) : folder.parentId;

  if (nextParentId === folder.id) {
    throw badRequest("A folder cannot be put inside itself. Choose a different place for it.");
  }

  // ── Where it is going, and whether that is even possible ────────────────────────────────────────
  let parentPath = "";
  if (nextParentId !== null) {
    const parent = await prisma.mediaFolder.findUnique({
      where: { id: nextParentId },
      select: { id: true, name: true, path: true }
    });
    if (!parent) {
      throw badRequest(
        "The folder this was being moved into no longer exists. Reload the media library and try again."
      );
    }

    /**
     * ⚠ THE CYCLE TEST, AND IT HAPPENS BEFORE ANY WRITE.
     *
     * A folder cannot become its own descendant. The materialised path answers that in one comparison —
     * if the proposed parent lives at or beneath this folder, the move would detach the pair from the
     * tree entirely: `FolderTree` assembles the hierarchy by following `parentId`, so a cycle is an
     * infinite recursion in the browser, and nothing that cannot be rendered can be repaired from the
     * screen afterwards.
     */
    if (parent.path === folder.path || parent.path.startsWith(`${folder.path}/`)) {
      throw badRequest(
        `“${folder.name}” cannot be moved into “${parent.name}”, because that folder is inside it. ` +
          "Move the inner folder out first, or choose a place outside this one."
      );
    }

    parentPath = parent.path;
  }

  /**
   * The address segment.
   *
   * Recomputed from the name ONLY when a new name was sent. A pure move deliberately keeps the segment it
   * already has: `slugify` is a function that may be improved one day, and re-deriving the segment on
   * every move would silently change the addresses of folders nobody renamed.
   */
  const segment = body.name !== undefined ? slugify(body.name) : lastSegmentOf(folder.path);
  if (segment.length === 0) {
    // A name of only punctuation, or only non-Latin script, slugifies to nothing — and a folder with no
    // path cannot be stored. Said plainly rather than answered with a constraint violation.
    throw badRequest(
      "That name cannot be turned into a folder address. Include at least one letter or number in it."
    );
  }

  const nextPath = `${parentPath}/${segment}`;

  if (nextPath === folder.path && nextName === folder.name) {
    // Nothing to do. Answered with the row rather than a 400: a save with no changes is something the
    // dialog can treat as success, and refusing it would leave the reader pressing a button that does
    // nothing and says nothing.
    return ok({ ...folder, assetCount: await liveAssetCount(folder.id) });
  }

  /**
   * Everything beneath this folder, for the depth check and for reporting how much moved.
   *
   * `startsWith` on the materialised path, with the trailing slash so a sibling called "events-archive"
   * is not swept in by a folder called "events". Prisma's `startsWith` does not escape the `LIKE`
   * metacharacters, which is safe here because every segment is `slugify`d down to `[a-z0-9-]` — and the
   * one statement that actually WRITES uses an exact prefix comparison rather than `LIKE` anyway.
   */
  const descendants = await prisma.mediaFolder.findMany({
    where: { path: { startsWith: `${folder.path}/` } },
    select: { id: true, path: true }
  });

  const currentDepth = depthOf(folder.path);
  const deepestBelow = descendants.reduce(
    (deepest, row) => Math.max(deepest, depthOf(row.path) - currentDepth),
    0
  );
  const nextDeepest = depthOf(nextPath) + deepestBelow;
  if (nextDeepest > MAX_DEPTH) {
    throw badRequest(
      `Folders can only be ${MAX_DEPTH} levels deep, and moving “${folder.name}” there would put ` +
        `${deepestBelow > 0 ? "the folders inside it" : "it"} at level ${nextDeepest}. ` +
        "Choose a place nearer the top, or use tags rather than more levels — they are what the search " +
        "box actually reads."
    );
  }

  if (nextPath !== folder.path) {
    const clash = await prisma.mediaFolder.findUnique({
      where: { path: nextPath },
      select: { name: true }
    });
    if (clash) {
      throw conflict(
        `There is already a folder called “${clash.name}” in the same place. Give this one a different name.`
      );
    }
  }

  let moved = 0;
  let updated;

  try {
    updated = await mutateWithHistory<{
      id: string;
      name: string;
      parentId: string | null;
      path: string;
    }>(
      auditContext(request, { id: user.id, email: user.email }),
      {
        action: "UPDATE",
        entityType: "MediaFolder",
        entityLabel: nextPath,
        before: { name: folder.name, parentId: folder.parentId, path: folder.path },
        summary:
          nextName !== folder.name && nextParentId !== folder.parentId
            ? "Folder renamed and moved"
            : nextName !== folder.name
              ? "Folder renamed"
              : "Folder moved"
      },
      async (tx) => {
        if (nextPath !== folder.path) {
          /**
           * ⚠ ONE STATEMENT FOR THE WHOLE SUBTREE.
           *
           * `right(path, length(path) - length(<old>))` keeps everything after the old prefix and
           * `<new> || …` puts the new one in front. Both lengths are measured by POSTGRES, in characters
           * — computing the offset in JavaScript instead would be wrong for any path holding a character
           * outside the Basic Multilingual Plane, because `String.length` counts UTF-16 units while
           * `right`/`length` count characters.
           *
           * `left(path, length(<prefix>)) = <prefix>` rather than a `LIKE`: an exact comparison has no
           * metacharacters to escape, so a stray `%` in a path written by an older build cannot widen
           * the match into somebody else's subtree.
           *
           * Postgres checks a unique index at the end of each STATEMENT, so moving every descendant in
           * one is also the only ordering that cannot trip `path`'s uniqueness against itself.
           *
           * Every parameter carries an explicit `::text`. Without it Postgres has to resolve `length()`
           * and `left()` against an untyped parameter, and an overload chosen by inference is not
           * something a statement that rewrites a whole subtree should depend on.
           */
          const prefix = `${folder.path}/`;
          moved = await tx.$executeRaw(Prisma.sql`
            UPDATE "media_folders"
               SET path = ${nextPath}::text || right(path, length(path) - length(${folder.path}::text))
             WHERE left(path, length(${prefix}::text)) = ${prefix}::text
          `);
        }

        return tx.mediaFolder.update({
          where: { id: folder.id },
          data: { name: nextName, parentId: nextParentId, path: nextPath },
          select: { id: true, name: true, parentId: true, path: true }
        });
      }
    );
  } catch (error) {
    // `path` is unique, and the check above is a CHECK rather than a guarantee — two administrators
    // renaming two folders into the same address at the same moment both pass it. The index is the
    // backstop; the honest answer is the same 409 rather than "something went wrong on our side".
    if (isUniqueViolation(error)) {
      throw conflict(
        "Another folder took that address a moment ago. Reload the media library and try a different name."
      );
    }
    throw error;
  }

  return ok({
    ...updated,
    assetCount: await liveAssetCount(updated.id),
    /** How many folders inside it moved with it. Stated so a big rename does not look like a small one. */
    descendantsMoved: moved
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — only when the folder is empty
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Deleting a folder needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const folder = await prisma.mediaFolder.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      path: true,
      parentId: true,
      _count: { select: { assets: { where: { deletedAt: null } }, children: true } }
    }
  });
  if (!folder) throw notFound("That folder");

  /**
   * Files that are in the recycle bin but still filed here.
   *
   * A separate query because Prisma allows one filter per relation inside `_count`. It does NOT refuse
   * the delete — the tree's Delete button is offered on the strength of the LIVE count, and refusing on a
   * number the reader cannot see would be a button that always fails for no visible reason. It is
   * REPORTED instead, because `MediaAsset.folder` is `onDelete: SetNull`: those recycled files lose their
   * filing, so restoring one afterwards puts it back with no folder rather than back in here.
   */
  const recycled = await prisma.mediaAsset.count({
    where: { folderId: id, deletedAt: { not: null } }
  });

  const liveAssets = folder._count.assets;
  const children = folder._count.children;

  if (liveAssets > 0 || children > 0) {
    // BOTH counts, always. "This folder is not empty" leaves an administrator opening it to find out
    // what is in the way; these two numbers say what to move first. The tree refuses the same thing on
    // the same numbers before the request is sent — this is the boundary, not a second opinion.
    const parts: string[] = [];
    if (liveAssets > 0) {
      parts.push(liveAssets === 1 ? "1 file is filed here" : `${liveAssets} files are filed here`);
    }
    if (children > 0) {
      parts.push(children === 1 ? "it has 1 folder inside it" : `it has ${children} folders inside it`);
    }
    throw conflict(
      `“${folder.name}” cannot be deleted because ${parts.join(" and ")}. Move or delete the contents first.`
    );
  }

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "MediaFolder",
      entityLabel: folder.path,
      before: { name: folder.name, path: folder.path, parentId: folder.parentId, recycledAssets: recycled },
      // Logged, not versioned: there is no new state worth restoring, and a folder is recreated rather
      // than restored — there is no recycle bin for filing.
      revise: false
    },
    async (tx) =>
      // A real delete. `MediaFolder` carries no `deletedAt`, and the header says why. The folder is empty
      // of live files and of child folders, both proved above, so the `Cascade` on `parentId` and the
      // `SetNull` on an asset's `folderId` have nothing to reach except the recycled files counted above.
      tx.mediaFolder.delete({ where: { id: folder.id }, select: { id: true } })
  );

  return ok({
    deleted: true,
    id: folder.id,
    name: folder.name,
    path: folder.path,
    /** Recycled files that are no longer filed anywhere. Zero in the ordinary case. */
    recycledAssetsUnfiled: recycled,
    message:
      recycled === 0
        ? `The folder “${folder.name}” has been deleted. It was empty, so nothing was lost, and it can be created again at any time.`
        : `The folder “${folder.name}” has been deleted. ${
            recycled === 1
              ? "1 file that was in the recycle bin was filed here and is now filed nowhere"
              : `${recycled} files that were in the recycle bin were filed here and are now filed nowhere`
          }, so restoring ${recycled === 1 ? "it" : "them"} will put ${
            recycled === 1 ? "it" : "them"
          } back into the library without a folder.`
  });
});
