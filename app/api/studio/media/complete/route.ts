import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { MediaKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
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
import { canManageMedia } from "@/lib/permissions";
import { deleteObject, deleteObjects, getObjectBytes, headObject, requireStorage } from "@/lib/storage/client";
import { isSafeObjectKey } from "@/lib/storage/keys";
import { DERIVABLE_MIME_TYPES, generateDerivatives, isSvg, probeImage } from "@/lib/storage/derivatives";
import { formatBytes } from "@/lib/utils";

/**
 * Step 3 of 3 of the direct-to-storage upload: register the object that has just landed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SHAPE IS FIXED BY `lib/client/upload.ts`. It sends
 * `{ objectKey, fileName, contentType, byteSize, folderId? }` and expects the created `MediaAsset`
 * back — the whole row, because a freshly uploaded file goes straight into the grid with no re-fetch
 * (`StudioMediaAsset` in components/studio/media/MediaGrid.tsx is the same shape).
 *
 * THIS IS THE ROUTE THAT MUST NOT BE GOT WRONG. Six rules, in order, each of which is a defect if it
 * is skipped:
 *
 *  1. **`headObject` FIRST, AND REFUSE WHEN THE OBJECT IS ABSENT.** Trusting the browser's "done" is
 *     how a `MediaAsset` row ends up pointing at a key that was never written — a broken image with a
 *     perfectly healthy-looking database, discovered weeks later by a visitor.
 *  2. **THE REPORTED SIZE IS CROSS-CHECKED AGAINST THE HEAD RESULT.** A mismatch means the bytes in
 *     the bucket are not the bytes that were described, so the row would be a lie about its own
 *     contents. It is a 400 — and the object is deleted, because it is a key this endpoint issued,
 *     nothing references it, and leaving it behind is an orphan nothing will ever collect.
 *  3. **THE KEY MUST BE ONE THIS ENDPOINT COULD HAVE ISSUED.** `isSafeObjectKey` plus the `media/`
 *     namespace plus the exact shape `buildObjectKey` produces. Without that, a caller could register
 *     any object in the bucket — including another asset's derivative, or a private file store
 *     document — as a media asset with a public URL.
 *  4. **A DUPLICATE IS REPORTED, NOT SILENTLY MERGED.** Matched on the SHA-256 of the bytes, never the
 *     filename ("IMG_0421.jpg" collides constantly; identical bytes almost never do). The
 *     administrator decides whether to keep both — see `UploadQueue`, which offers the choice.
 *  5. **THE DERIVATIVE FAILURES ARE REPORTED.** `generateDerivatives` returns a `failed` list. Only
 *     what actually landed becomes a variant row, and the failures come back in the response, because
 *     a variant row for an object that does not exist is a broken image with a healthy database.
 *  6. **THE ROW, ITS VARIANTS, ITS REVISION AND THE AUDIT ENTRY ARE ONE TRANSACTION.** If the write
 *     rolls back, the derivative objects written a moment earlier are deleted again, so a failure
 *     leaves the bucket as it was rather than salting it with unreferenced files.
 *
 * THIS ROUTE NEEDS TIME AND MEMORY, and `vercel.json` grants it 300s and 3009 MB: sharp decodes the
 * whole image, and a 40-megapixel heritage scan is a large bitmap. That is also why the two caps below
 * exist — a limit that is stated is better than an out-of-memory kill that loses the row entirely.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * Above this, the derivative pipeline is not run.
 *
 * sharp holds the decoded bitmap in memory, and decoding a 100 MB TIFF can exceed even a generous
 * limit — and an out-of-memory kill takes the whole request with it, so the file would land in storage
 * with no row at all. Skipping is reported in the answer and the detail panel already says "none have
 * been made yet", which is recoverable; losing the upload is not.
 */
const DERIVE_MAX_BYTES = 80 * 1024 * 1024;

/**
 * Above this, the checksum is not computed.
 *
 * The checksum needs the whole object in memory, and its only job is duplicate detection. A 150 MB
 * film that is registered without one is a small loss; refusing the upload, or pulling 200 MB through
 * a function for a hash nobody asked for, are both worse. The skip is reported.
 */
const CHECKSUM_MAX_BYTES = 128 * 1024 * 1024;

/** How many byte-identical assets are named back. Beyond this the panel's list is noise. */
const DUPLICATE_LIMIT = 5;

/**
 * The exact shape `buildObjectKey({ namespace: "media", … })` produces:
 * `media/<year>/<2-digit month>/<16 hex>-<slug>[.ext]`.
 *
 * Written out as a pattern rather than merely checking the prefix, so a *variant* key
 * (`media/2026/07/abc…-photo/md.webp`, produced by `buildVariantKey`) is rejected too — otherwise a
 * caller could register one asset's thumbnail as a second asset and a purge of the first would break
 * the second.
 */
const ISSUED_MEDIA_KEY = /^media\/\d{4}\/\d{2}\/[0-9a-f]{16}-[a-z0-9-]+(?:\.[a-z0-9]+)?$/;

/** Server-side allow-list. In step with presign's copy and with lib/client/upload.ts. */
const CONTENT_TYPE_KINDS: Readonly<Record<string, MediaKind>> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "image/avif": "IMAGE",
  "image/gif": "IMAGE",
  "image/tiff": "IMAGE",
  // Accepted, then stored as a DOCUMENT — see `storedKind`.
  "image/svg+xml": "IMAGE",

  "video/mp4": "VIDEO",
  "video/webm": "VIDEO",
  "video/quicktime": "VIDEO",

  "audio/mpeg": "AUDIO",
  "audio/mp4": "AUDIO",
  "audio/ogg": "AUDIO",
  "audio/wav": "AUDIO",
  "audio/x-wav": "AUDIO",
  "audio/webm": "AUDIO",

  "application/pdf": "DOCUMENT",
  "application/msword": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCUMENT",
  "application/vnd.ms-excel": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "DOCUMENT",
  "application/vnd.ms-powerpoint": "DOCUMENT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "DOCUMENT",
  "application/zip": "DOCUMENT",
  "text/plain": "DOCUMENT",
  "text/csv": "DOCUMENT",
  // Subtitles for the video player. Filed as a DOCUMENT — see the note in lib/client/upload.ts.
  "text/vtt": "DOCUMENT",

  "model/gltf-binary": "MODEL_3D",
  "model/gltf+json": "MODEL_3D"
};

const CompleteBody = z.object({
  objectKey: z.string().trim().min(1).max(1024),
  fileName: z.string().trim().min(1, "The file has no name.").max(255),
  contentType: z.string().trim().min(1).max(160),
  byteSize: z.number().int().positive(),
  /** `null` and an omitted key both mean "not in a folder"; an id is checked to exist. */
  folderId: z.string().trim().min(1).max(64).nullable().optional(),
  /**
   * Optional, and only ever needed for PANORAMA — a panorama is an ordinary JPEG on the wire and
   * nothing about the bytes can reveal it. `lib/client/upload.ts` does not send it today (it declares
   * the kind at the presign step only), so a panorama currently lands as an IMAGE; accepting it here
   * means the browser half can start forwarding it without a change on this side.
   */
  kind: z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "MODEL_3D", "PANORAMA"]).optional()
});

/** The variant columns `MediaLike` and the detail panel both read. */
const VARIANT_SELECT = {
  select: { label: true, format: true, objectKey: true, width: true },
  orderBy: { width: "asc" as const }
};

/**
 * What this file is stored as.
 *
 * An SVG is always a DOCUMENT: it is a script-bearing document rather than a bitmap, and filing it as
 * an image would put it in every picture picker and hand it to the derivative pipeline, which cannot
 * read it. The caller may only override the kind to PANORAMA, and only for a real image.
 */
function storedKind(contentType: string, declared: MediaKind | undefined): MediaKind | null {
  const implied = CONTENT_TYPE_KINDS[contentType];
  if (!implied) return null;
  if (isSvg(contentType)) return "DOCUMENT";
  if (declared === "PANORAMA") return implied === "IMAGE" ? "PANORAMA" : null;
  return implied;
}

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Adding to the media library needs media manager access or higher. An administrator can raise yours."
  );
  requireStorage();

  const body = await parseJson(request, CompleteBody);
  const objectKey = body.objectKey;
  const contentType = body.contentType.toLowerCase();

  // ── Rule 3: is this a key we could have issued? ───────────────────────────────────────────────
  if (!isSafeObjectKey(objectKey) || !ISSUED_MEDIA_KEY.test(objectKey)) {
    throw badRequest(
      "That storage address is not one the media library issues, so nothing was added. Start the upload again."
    );
  }

  const kind = storedKind(contentType, body.kind);
  if (!kind) {
    throw badRequest(
      `Files of type ${contentType} are not accepted in the media library, so nothing was added.`
    );
  }

  // Already registered? The unique index on `objectKey` would refuse it anyway, but a P2002 reaches
  // the reader as "something went wrong" and this reaches them as an explanation. The recycle bin is
  // deliberately NOT excluded: a soft-deleted row still owns those bytes until the purge runs.
  const [existingAsset, existingVariant] = await Promise.all([
    prisma.mediaAsset.findUnique({ where: { objectKey }, select: { id: true, deletedAt: true } }),
    prisma.mediaVariant.findUnique({ where: { objectKey }, select: { assetId: true } })
  ]);
  if (existingAsset) {
    throw conflict(
      existingAsset.deletedAt
        ? "That file has already been added and is currently in the recycle bin. Restore it there rather than uploading it again."
        : "That file has already been added to the library."
    );
  }
  if (existingVariant) {
    throw conflict("That storage address belongs to a smaller version of another file and cannot be added on its own.");
  }

  if (body.folderId) {
    const folder = await prisma.mediaFolder.findUnique({
      where: { id: body.folderId },
      select: { id: true }
    });
    if (!folder) {
      throw badRequest(
        "The folder this was being filed into no longer exists. Reload the media library and upload it again."
      );
    }
  }

  // ── Rule 1: did the bytes actually land? ─────────────────────────────────────────────────────
  const head = await headObject(objectKey);
  if (!head) {
    throw badRequest(
      "The upload did not reach storage, so nothing was added to the library. Nothing is stored under that " +
        "address. Try uploading the file again."
    );
  }

  // ── Rule 2: are they the bytes that were described? ──────────────────────────────────────────
  if (head.byteSize !== body.byteSize) {
    // The key is one this endpoint issued and no row references it, so removing it is safe and is the
    // only way this refusal does not leave an orphan behind.
    await deleteObject(objectKey).catch((error: unknown) => {
      console.error("[media/complete] could not remove a rejected upload", objectKey, error);
    });
    throw badRequest(
      `What reached storage is ${formatBytes(head.byteSize)} but the upload was described as ` +
        `${formatBytes(body.byteSize)}. Nothing was added to the library. Try uploading the file again.`
    );
  }

  // ── The bytes, once, for the checksum and the derivatives ────────────────────────────────────
  const derivable = DERIVABLE_MIME_TYPES.has(contentType) && head.byteSize <= DERIVE_MAX_BYTES;
  const wantsChecksum = head.byteSize <= CHECKSUM_MAX_BYTES;

  let bytes: Buffer | null = null;
  if (derivable || wantsChecksum) {
    bytes = await getObjectBytes(objectKey);
  }

  const checksum = bytes && wantsChecksum ? createHash("sha256").update(bytes).digest("hex") : null;

  // ── Rule 4: is this file already here, byte for byte? ────────────────────────────────────────
  const duplicates = checksum
    ? await prisma.mediaAsset.findMany({
        where: { checksum, deletedAt: null },
        select: { id: true, fileName: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: DUPLICATE_LIMIT
      })
    : [];

  // ── Rule 5: derivatives, with the failures kept ──────────────────────────────────────────────
  let width: number | null = null;
  let height: number | null = null;
  let blurDataUrl: string | null = null;
  let variants: { label: string; format: string; objectKey: string; width: number; height: number; byteSize: number }[] =
    [];
  let derivativeFailures: { label: string; format: string; reason: string }[] = [];
  const notes: string[] = [];

  if (bytes && derivable) {
    const result = await generateDerivatives({ originalKey: objectKey, bytes });
    variants = result.variants;
    derivativeFailures = result.failed;
    blurDataUrl = result.blurDataUrl;
    if (result.width > 0 && result.height > 0) {
      width = result.width;
      height = result.height;
    } else {
      notes.push(
        "The picture could not be read, so no smaller versions were made and its dimensions are unknown. " +
          "It is stored exactly as uploaded."
      );
    }
  } else if (bytes && CONTENT_TYPE_KINDS[contentType] === "IMAGE" && !isSvg(contentType)) {
    // An image the pipeline cannot resize (or one too large to try). Its dimensions are still worth
    // recording — the layout uses them for the aspect-ratio box that prevents a shift on load.
    const probe = await probeImage(bytes);
    if (probe) {
      width = probe.width;
      height = probe.height;
    }
  }

  if (DERIVABLE_MIME_TYPES.has(contentType) && !derivable) {
    notes.push(
      `This picture is ${formatBytes(head.byteSize)}, which is above the ${formatBytes(DERIVE_MAX_BYTES)} ` +
        "limit for making smaller versions, so none were made. The site will send the full-size file to every " +
        "visitor until an administrator regenerates them."
    );
  }
  if (!wantsChecksum) {
    notes.push(
      `This file is ${formatBytes(head.byteSize)}, which is above the ${formatBytes(CHECKSUM_MAX_BYTES)} ` +
        "limit for the duplicate check, so it was not checked against what is already in the library."
    );
  }

  const context: AuditContext = {
    actor: { id: user.id, email: user.email },
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };

  // ── Rule 6: one transaction, and clean up the bytes if it fails ──────────────────────────────
  let created;
  try {
    created = await mutateWithHistory<
      Prisma.MediaAssetGetPayload<{ include: { variants: typeof VARIANT_SELECT } }>
    >(
      context,
      {
        action: "UPLOAD",
        entityType: "MediaAsset",
        entityLabel: body.fileName,
        summary: "Uploaded"
      },
      async (tx) => {
        const asset = await tx.mediaAsset.create({
          data: {
            kind,
            objectKey,
            fileName: body.fileName,
            mimeType: contentType,
            byteSize: head.byteSize,
            width,
            height,
            checksum,
            blurDataUrl,
            // NOT set to "" here. `null` means "nobody has written a description" and `""` means
            // "somebody decided this is decorative" — two different statements the whole library UI
            // keeps apart, and the accessibility backlog counts the first (MediaDetailPanel.tsx).
            altText: null,
            folderId: body.folderId ?? null,
            uploaderId: user.id
          }
        });

        if (variants.length > 0) {
          // Only the derivatives that actually reached storage get a row. See rule 5.
          await tx.mediaVariant.createMany({
            data: variants.map((variant) => ({ assetId: asset.id, ...variant }))
          });
        }

        return tx.mediaAsset.findUniqueOrThrow({
          where: { id: asset.id },
          include: { variants: VARIANT_SELECT }
        });
      }
    );
  } catch (error) {
    // The derivatives are already in the bucket and nothing now references them. Removing them is the
    // difference between a failed upload and a bucket that grows every time one fails.
    if (variants.length > 0) {
      const cleanup = await deleteObjects(variants.map((variant) => variant.objectKey));
      if (cleanup.failed.length > 0) {
        console.error(
          "[media/complete] the record was not created and %d derivative object(s) could not be removed",
          cleanup.failed.length,
          cleanup.failed
        );
      }
    }
    throw error;
  }

  return ok({
    ...created,
    /**
     * Byte-identical files already in the library. REPORTED, never merged — `UploadQueue` offers the
     * choice between them and the administrator decides. (The library also asks the same question in
     * one batch through `/api/studio/media/duplicates`; this field means a single upload does not
     * have to.)
     */
    duplicates: duplicates.map((entry) => ({
      id: entry.id,
      fileName: entry.fileName,
      createdAt: entry.createdAt
    })),
    /**
     * What the derivative pipeline managed. `failed` names the sizes that are MISSING, so the screen
     * can say which ones rather than implying the set is complete.
     */
    derivatives: {
      generated: variants.length,
      failed: derivativeFailures,
      notes
    }
  });
});
