import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  clientIp,
  notFound,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { indexDocument, removeDocument, searchDocFromFile } from "@/lib/search/index";

/**
 * One file-store entry: read it, change its details, or move it to the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `GET` AND `PATCH` BOTH ANSWER `StudioFileDetail` (app/studio/files/FileManager.tsx) — the entry plus
 * every version, newest first.
 *
 * ⚠ THE SLUG IS NEVER CHANGED HERE, AND THAT IS DELIBERATE. It is the public download address, so it is
 * the string a citation, a reading list or a printed report records. Renaming the title renames the
 * label; it does not move the file. There is no redirect table for downloads, so a slug change would
 * break every existing link with nothing to catch it.
 *
 * `isPublic` AND `expiresAt` ARE RECORDED HERE AND ENFORCED SOMEWHERE ELSE — at
 * `app/api/public/files/[slug]/route.ts`, which answers 404 for a private file (never 403, which would
 * confirm that an embargoed file exists) and 410 with the date for an expired one. Nothing in this
 * handler is an access control, and nothing here may be mistaken for one.
 *
 * BOTH FLAGS ALSO MOVE THE SEARCH INDEX, in the same transaction as the write. `searchDocFromFile`
 * computes `isPublished` through `fileIsPublished` — public, not deleted, and not past its expiry — so the
 * title of an embargoed dataset never appears in a search result, which would itself be a disclosure.
 *
 * ⚠ AN EXPIRY THAT LAPSES IS NOT A WRITE, so nothing here can catch it. A file that was public and is now
 * past its `expiresAt` correctly refuses at the download route, but its index row was computed when it was
 * still current and no request touches this handler when the clock passes the date. That gap is closed by
 * `resyncPublishedFlags()` in lib/search/index.ts, which the publish cron calls on every pass and which
 * recomputes the flag for files from the SAME predicate this route writes with. The index is therefore
 * correct at every write and correct again within one cron interval of an embargo lapsing. Removing files
 * from that sweep would leave a withdrawn dataset findable by name indefinitely.
 *
 * `DELETE` IS A SOFT DELETE. The row gets `deletedAt`, the index row is dropped, and the BYTES SURVIVE
 * every version until the purge cron passes the recovery window. Nothing here touches storage.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const VERSION_SELECT = {
  select: {
    id: true,
    version: true,
    fileName: true,
    mimeType: true,
    byteSize: true,
    checksum: true,
    notes: true,
    createdAt: true
  },
  orderBy: { version: "desc" as const }
};

const DETAIL_SELECT = {
  id: true,
  title: true,
  slug: true,
  description: true,
  category: true,
  isPublic: true,
  expiresAt: true,
  downloadCount: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  uploader: { select: { id: true, name: true } },
  versions: VERSION_SELECT,
  _count: { select: { versions: true } }
} satisfies Prisma.FileAssetSelect;

type FileDetail = Prisma.FileAssetGetPayload<{ select: typeof DETAIL_SELECT }>;

function toDetail(row: FileDetail) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    description: row.description,
    category: row.category,
    isPublic: row.isPublic,
    expiresAt: row.expiresAt,
    downloadCount: row.downloadCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestVersion: row.versions[0] ?? null,
    versionCount: row._count.versions,
    uploader: row.uploader,
    versions: row.versions
  };
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(
    canManageMedia,
    "The file store needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const file = await prisma.fileAsset.findFirst({
    where: { id, deletedAt: null },
    select: DETAIL_SELECT
  });
  if (!file) throw notFound("That file");

  return ok(toDetail(file));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PatchBody = z.object({
  title: z
    .string()
    .trim()
    .min(1, "A file needs a title. It is what people see in the list of downloads.")
    .max(200, "Keep the title to 200 characters or fewer.")
    .optional(),
  /** `""` from an emptied box and `null` mean the same thing and both clear the column. */
  description: z.string().trim().max(2000).nullable().optional(),
  category: z.string().trim().max(80).nullable().optional(),
  isPublic: z.boolean().optional(),
  /**
   * An ISO instant, or `null` for "no expiry".
   *
   * ⚠ `null`, never `""`. A nullable `DateTime` column cannot take an empty string, and a date parsed
   * from one is Invalid Date — which Prisma refuses with a message about a value the reader never typed.
   * The panel already sends `null` for an empty box; this schema is what makes that the only spelling
   * that gets through.
   */
  expiresAt: z.coerce.date().nullable().optional()
});

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Changing a file needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseJson(request, PatchBody);

  const before = await prisma.fileAsset.findFirst({ where: { id, deletedAt: null }, select: DETAIL_SELECT });
  if (!before) throw notFound("That file");

  // Built from what was SENT. `in` rather than `!== undefined`, because an explicit `null` is a real
  // value for three of these fields and `undefined` is what an absent key looks like after Zod.
  const data: Prisma.FileAssetUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if ("description" in body) data.description = body.description?.trim() || null;
  if ("category" in body) data.category = body.category?.trim() || null;
  if (body.isPublic !== undefined) data.isPublic = body.isPublic;
  if ("expiresAt" in body) data.expiresAt = body.expiresAt ?? null;

  if (Object.keys(data).length === 0) return ok(toDetail(before));

  const updated = await mutateWithHistory<FileDetail>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "UPDATE",
      entityType: "FileAsset",
      entityLabel: body.title ?? before.title,
      before,
      // Named so the revision list reads as a history rather than as a column of "Updated".
      summary:
        body.isPublic === undefined
          ? "Details edited"
          : body.isPublic
            ? "Made available to the public"
            : "Taken off the public site"
    },
    async (tx) => {
      const row = await tx.fileAsset.update({ where: { id }, data, select: DETAIL_SELECT });
      // The index carries `isPublic` AND the expiry — see the header.
      await indexDocument(tx, searchDocFromFile(row));
      return row;
    }
  );

  return ok(toDetail(updated));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — soft, always
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Removing a file needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const file = await prisma.fileAsset.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      title: true,
      slug: true,
      downloadCount: true,
      isPublic: true,
      _count: { select: { versions: true, projects: true } }
    }
  });
  if (!file) throw notFound("That file");

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "FileAsset",
      entityLabel: file.title,
      before: { title: file.title, slug: file.slug, downloadCount: file.downloadCount },
      revise: false
    },
    async (tx) => {
      const row = await tx.fileAsset.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true }
      });
      // Out of search immediately. The bytes stay, but the entry must stop being findable the moment it
      // stops being downloadable, or a result leads to a 404.
      await removeDocument(tx, "file", id);
      return row;
    }
  );

  return ok({
    deleted: true,
    id: file.id,
    title: file.title,
    /**
     * The consequences, counted. A file cited in print has links that stop working the instant this is
     * done, and an administrator deciding whether to proceed needs the number rather than a warning in
     * the abstract.
     */
    versionsKept: file._count.versions,
    projectReferences: file._count.projects,
    message:
      `${file.title} is in the recycle bin and can no longer be downloaded. ` +
      (file.downloadCount > 0
        ? `It had been downloaded ${file.downloadCount} ${
            file.downloadCount === 1 ? "time" : "times"
          }, so any address pointing at it — including one in print — stops working now. `
        : "") +
      (file._count.projects > 0
        ? `${file._count.projects === 1 ? "1 project lists it" : `${file._count.projects} projects list it`} ` +
          "as a download and will now show one fewer. "
        : "") +
      `All ${file._count.versions === 1 ? "1 stored version is" : `${file._count.versions} stored versions are`} ` +
      "kept until the recycle bin is emptied, so it can be restored."
  });
});
