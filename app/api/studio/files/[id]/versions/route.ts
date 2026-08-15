import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  ApiError,
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
import { indexDocument, searchDocFromFile } from "@/lib/search/index";
import { isUniqueViolation } from "@/lib/studio/crud";
import { deleteObject, getObjectBytes, headObject, requireStorage } from "@/lib/storage/client";
import { isSafeObjectKey } from "@/lib/storage/keys";
import { formatBytes } from "@/lib/utils";

/**
 * A NEW VERSION of an existing file-store entry.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SHAPE IS FIXED BY `FileManager`'s replace flow: it presigns through
 * `/api/studio/files/presign`, PUTs the bytes straight to storage, and then sends
 * `{ objectKey, fileName, mimeType, byteSize, notes }` here. So this request REGISTERS AN OBJECT THAT
 * ALREADY EXISTS — the bytes are not this route's to accept, only to confirm and describe. The answer is
 * `StudioFileDetail`, the entry plus every version, newest first.
 *
 * ⚠ `mimeType` IS WHAT THE SCREEN SENDS, and `contentType` is accepted as well because that is the name
 * the two presign endpoints use for the same value. One of the two must be present; sending both with
 * different values is refused rather than resolved, because guessing which one described the bytes is how
 * a download ends up served as the wrong type.
 *
 * ══ THE EARLIER VERSIONS' BYTES ARE NEVER TOUCHED ══
 *
 * That is the whole point of the model (prisma/schema.prisma, `FileAsset`): a citation of "version 2 of
 * the Bagru corpus" must keep resolving to version 2 for as long as the record exists. So a replacement
 * is an INSERT and never an overwrite — no object is deleted, no key is reused, and the public download
 * route simply starts serving the highest version. Nothing in this file may be changed to remove an old
 * object; the purge job is the only writer allowed to, and only for an entry in the recycle bin.
 *
 * ⚠ THE VERSION NUMBER IS COMPUTED INSIDE THE TRANSACTION, WITH A `max` READ, NEVER A ROW COUNT. Counting
 * is wrong the moment a version is ever pruned — five rows numbered 3 to 7 would produce another 6 — and
 * two concurrent additions would compute the same number either way. The unique index on
 * `(fileId, version)` is the backstop, and a genuine race is answered as a conflict the reader can act
 * on rather than as "something went wrong on our side". This mirrors `writeRevision` in lib/audit.ts,
 * which solves the identical problem for revisions.
 *
 * THE ENTRY IS RE-INDEXED IN THE SAME TRANSACTION. A file's searchable text is its title and description,
 * neither of which this route changes — but `updatedAt` moves, `searchDocFromFile` recomputes
 * `isPublished` from `isPublic` AND the expiry, and doing it here means the index cannot drift out of step
 * with the row for the one write that would otherwise skip it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ Mirrors `MAX_UPLOAD_BYTES` in lib/client/upload.ts, files/route.ts and files/presign/route.ts. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Above this, the checksum is skipped.
 *
 * ⚠ Mirrors the copy in app/api/studio/files/route.ts. It needs the whole object in memory and it only
 * feeds duplicate detection, so a very large corpus stored without one is a small loss — and the skip is
 * reported in the answer rather than left silent.
 */
const CHECKSUM_MAX_BYTES = 128 * 1024 * 1024;

/**
 * The exact shape `buildObjectKey({ namespace: "files", … })` produces.
 *
 * ⚠ Mirrors `ISSUED_FILE_KEY` in app/api/studio/files/route.ts, and it is a full pattern rather than a
 * prefix test for the same reason: nothing but a key this deployment's file-store presign issued may be
 * registered, or a caller could point a public download at any object in the bucket — a media asset, or
 * another entry's embargoed version.
 */
const ISSUED_FILE_KEY = /^files\/\d{4}\/\d{2}\/[0-9a-f]{16}-[a-z0-9-]+(?:\.[a-z0-9]+)?$/;

/** ⚠ In step with the same constant in files/route.ts and files/[id]/route.ts. */
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

/** ⚠ `StudioFileDetail` from app/studio/files/FileManager.tsx. In step with files/[id]/route.ts. */
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

const VersionBody = z
  .object({
    objectKey: z.string().trim().min(1).max(1024),
    fileName: z.string().trim().min(1, "The file has no name.").max(255),
    /** See the header: the screen sends `mimeType`, the presign endpoints call it `contentType`. */
    mimeType: z.string().trim().min(1).max(160).optional(),
    contentType: z.string().trim().min(1).max(160).optional(),
    byteSize: z.number().int().positive(),
    /** What changed in this version. `""` from an emptied box and `null` both mean "nothing recorded". */
    notes: z.string().trim().max(500).nullable().optional()
  })
  .refine((value) => value.mimeType !== undefined || value.contentType !== undefined, {
    path: ["mimeType"],
    message:
      "The type of the file was not sent, so the new version could not be added. Reload the page and try again."
  })
  .refine(
    (value) =>
      value.mimeType === undefined ||
      value.contentType === undefined ||
      value.mimeType.toLowerCase() === value.contentType.toLowerCase(),
    {
      path: ["mimeType"],
      message:
        "The request described the file's type twice, and the two did not agree, so nothing was added. " +
        "Reload the page and try again."
    }
  );

export const POST = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Adding a new version needs media manager access or higher. An administrator can raise yours."
  );
  // A 503 rather than a 500: unconfigured storage is a deployment state, not a bug.
  requireStorage();

  const { id } = await context.params;
  const body = await parseJson(request, VersionBody);
  const objectKey = body.objectKey;
  // One of the two is present and, if both are, they agree — both proved by the schema above.
  const mimeType = (body.mimeType ?? body.contentType ?? "").toLowerCase();

  if (!isSafeObjectKey(objectKey) || !ISSUED_FILE_KEY.test(objectKey)) {
    throw badRequest(
      "That storage address is not one the file store issues, so nothing was added. Start the upload again."
    );
  }

  if (body.byteSize > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      413,
      `This file is ${formatBytes(body.byteSize)} and the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. ` +
        "Split it or compress it, or ask an administrator to raise the limit.",
      { code: "too_large" }
    );
  }

  const file = await prisma.fileAsset.findFirst({
    // The recycle bin is out of scope: adding a version to a deleted entry would store bytes nobody can
    // reach, and the restore would then bring back a file the administrator never reviewed.
    where: { id, deletedAt: null },
    select: { id: true, title: true }
  });
  if (!file) throw notFound("That file");

  // `objectKey` is unique across every version of every entry. Checked here so the reader gets an
  // explanation rather than a P2002 arriving as "something went wrong on our side".
  const alreadyUsed = await prisma.fileVersion.findUnique({
    where: { objectKey },
    select: { fileId: true, version: true }
  });
  if (alreadyUsed) {
    throw badRequest(
      alreadyUsed.fileId === file.id
        ? `That upload is already stored as version ${alreadyUsed.version} of this file. Nothing was added.`
        : "That upload has already been registered against a different file. Nothing was added."
    );
  }

  // ── Did the bytes actually land? ────────────────────────────────────────────────────────────────
  // Trusting the browser's "done" produces a version row pointing at a key that was never written — a
  // download button that answers "not found" with a perfectly healthy-looking database.
  const head = await headObject(objectKey);
  if (!head) {
    throw badRequest(
      "The upload did not reach the file store, so no new version was added. Nothing is stored under that " +
        "address. Try uploading the file again."
    );
  }

  // ── Are they the bytes that were described? ─────────────────────────────────────────────────────
  if (head.byteSize !== body.byteSize) {
    // This key was issued by the file store a moment ago and no row references it, so removing it is safe
    // — and it is the only way this refusal does not leave an object nothing will ever collect.
    await deleteObject(objectKey).catch((error: unknown) => {
      console.error("[files/versions] could not remove a rejected upload", objectKey, error);
    });
    throw badRequest(
      `What reached the file store is ${formatBytes(head.byteSize)} but the upload was described as ` +
        `${formatBytes(body.byteSize)}. No new version was added. Try uploading the file again.`
    );
  }

  const checksum =
    head.byteSize <= CHECKSUM_MAX_BYTES
      ? createHash("sha256")
          .update(await getObjectBytes(objectKey))
          .digest("hex")
      : null;

  let updated;
  try {
    updated = await mutateWithHistory<FileDetail>(
      auditContext(request, { id: user.id, email: user.email }),
      {
        action: "UPDATE",
        entityType: "FileAsset",
        entityLabel: file.title,
        before: { title: file.title },
        summary: "A new version was uploaded"
      },
      async (tx) => {
        /**
         * The number, from a `max` read INSIDE the transaction. See the header for why this is not a
         * count. `aggregate` rather than `findFirst`, so the answer is one value from an index rather than
         * a row this route has no other use for.
         */
        const highest = await tx.fileVersion.aggregate({
          where: { fileId: file.id },
          _max: { version: true }
        });
        const version = (highest._max.version ?? 0) + 1;

        await tx.fileVersion.create({
          data: {
            fileId: file.id,
            version,
            objectKey,
            fileName: body.fileName,
            mimeType,
            byteSize: head.byteSize,
            checksum,
            notes: body.notes?.trim() || null
          }
        });

        /**
         * The entry itself is touched so `updatedAt` moves.
         *
         * Not cosmetic: the file list's default ordering is `updatedAt desc`, so without this a file that
         * has just been given a new version stays wherever it was and the person who uploaded it cannot
         * find it. An empty `data` is enough — Prisma's `@updatedAt` writes the column on any update.
         */
        const row = await tx.fileAsset.update({
          where: { id: file.id },
          data: {},
          select: DETAIL_SELECT
        });

        // In the same transaction as the write it describes, so a rolled-back save cannot leave a search
        // result pointing at a state that never existed (lib/search/index.ts).
        await indexDocument(tx, searchDocFromFile(row));

        return row;
      }
    );
  } catch (error) {
    /**
     * `(fileId, version)` is unique. Two colleagues adding a version in the same instant both read the
     * same `max`, and the index refuses the second — which is exactly what it is for. The honest answer
     * is that somebody else got there first, because retrying works.
     */
    if (isUniqueViolation(error)) {
      throw conflict(
        `Somebody else added a new version of “${file.title}” at the same moment, so this one was not ` +
          "stored. Reload the file to see theirs, then add yours again if it is still needed."
      );
    }
    throw error;
  }

  const added = updated.versions[0] ?? null;

  return ok(
    {
      ...toDetail(updated),
      /** The version just stored, named so the screen can say which number it became. */
      addedVersion: added,
      message:
        `Version ${added?.version ?? updated._count.versions} of “${updated.title}” has been stored. ` +
        "The earlier versions are untouched and can still be downloaded, so an existing citation keeps " +
        "resolving to the version it named.",
      ...(checksum === null
        ? {
            note:
              `This file is ${formatBytes(head.byteSize)}, which is above the ` +
              `${formatBytes(CHECKSUM_MAX_BYTES)} limit for fingerprinting, so it was stored without one. ` +
              "That only affects duplicate detection; the file itself is unaffected."
          }
        : {})
    },
    { status: 201 }
  );
});
