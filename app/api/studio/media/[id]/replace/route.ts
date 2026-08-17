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
  notFound,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canManageMedia } from "@/lib/permissions";
import {
  deleteObject,
  deleteObjects,
  getObjectBytes,
  headObject,
  requireStorage
} from "@/lib/storage/client";
import { isSafeObjectKey } from "@/lib/storage/keys";
import {
  DERIVABLE_MIME_TYPES,
  generateDerivatives,
  isSvg,
  probeImage
} from "@/lib/storage/derivatives";
import { formatBytes } from "@/lib/utils";

/**
 * Replace the BYTES behind one media asset, keeping its id.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE SHAPE IS FIXED BY `MediaDetailPanel`'s replacement flow. It sends
 * `{ objectKey, fileName, contentType, byteSize }` and expects a `StudioMediaAsset` back, which it puts
 * straight into the grid with no re-fetch.
 *
 * ⚠ THE SIGNED PUT HAS ALREADY HAPPENED BY THE TIME THIS RUNS. The panel presigns through
 * `/api/studio/media/presign`, PUTs the file to storage from the browser, and only then calls this
 * endpoint — so this request REGISTERS AN OBJECT THAT ALREADY EXISTS. Everything below follows from that
 * one fact: the bytes are not this route's to accept or refuse, only to confirm, describe and point a row
 * at.
 *
 * WHY A REPLACEMENT RATHER THAN A NEW UPLOAD. The id does not change, so every article, album, profile
 * and page SEO slot already pointing at this asset picks up the new picture with no re-linking. That is
 * the entire feature; it is also why the DESCRIPTION, caption, credit, copyright, tags and folder are all
 * left exactly as they are — somebody wrote them about this slot, and a replacement of the photograph in
 * it does not make them wrong.
 *
 * ══ THE OLD OBJECT IS NOT DELETED, AND NOR ARE ITS DERIVATIVES ══
 *
 * Every published page's CDN URL is derived from an object key, and derivative keys are derived from the
 * original's (lib/storage/keys.ts). The replacement therefore gets its OWN key and its own derivatives,
 * and the previous ones are left in the bucket. Two reasons:
 *
 *   • a mistaken replacement is recoverable — the previous key is recorded in the audit entry's `before`,
 *     so the original file can be put back;
 *   • the old URLs keep resolving while CDN and browser caches drain, instead of turning every already
 *     served page into a broken image the moment somebody presses Replace.
 *
 * ⚠ BE HONEST ABOUT THE COST: those objects are no longer referenced by any row, and the purge job walks
 * SOFT-DELETED ROWS rather than orphaned keys (app/api/cron/purge), so nothing collects them
 * automatically. They stay until an administrator removes them, which is why every key this route
 * abandons is named in the audit entry and in the answer. Storage that grows slowly and recoverably was
 * chosen over bytes that vanish the instant somebody clicks the wrong button.
 *
 * WHAT *IS* REMOVED IS THE OLD VARIANT **ROWS**. They describe derivatives of a key this asset no longer
 * points at, and `pickVariant` (lib/media/url.ts) prefers a variant over the original — so leaving them
 * would make every page keep showing the OLD picture at the new asset, which is the exact bug a
 * replacement is meant to fix.
 *
 * ⚠ THIS ROUTE DECODES A WHOLE IMAGE AND NEEDS TIME AND MEMORY, exactly as
 * `app/api/studio/media/complete/route.ts` does. `vercel.json` grants that route 300s and 3009 MB and
 * has NO ENTRY FOR THIS ONE — it needs the same one, or a large heritage scan will be killed part-way
 * and the row will keep pointing at the old file with no explanation on screen.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ Mirrors `DERIVE_MAX_BYTES` in media/complete. Above this, no smaller versions are made. */
const DERIVE_MAX_BYTES = 80 * 1024 * 1024;

/** ⚠ Mirrors `CHECKSUM_MAX_BYTES` in media/complete. Above this, no fingerprint is taken. */
const CHECKSUM_MAX_BYTES = 128 * 1024 * 1024;

/**
 * The exact shape `buildObjectKey({ namespace: "media", … })` produces.
 *
 * ⚠ Mirrors `ISSUED_MEDIA_KEY` in media/complete, and for the same reason it is a full pattern rather
 * than a prefix test: a VARIANT key (`media/2026/07/abc…-photo/md.webp`, produced by `buildVariantKey`)
 * must not pass, or a caller could point this asset at another asset's thumbnail.
 */
const ISSUED_MEDIA_KEY = /^media\/\d{4}\/\d{2}\/[0-9a-f]{16}-[a-z0-9-]+(?:\.[a-z0-9]+)?$/;

/** ⚠ Server-side allow-list, in step with media/presign and media/complete. */
const CONTENT_TYPE_KINDS: Readonly<Record<string, MediaKind>> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "image/avif": "IMAGE",
  "image/gif": "IMAGE",
  "image/tiff": "IMAGE",
  // Accepted, then treated as a DOCUMENT — an SVG is a script-bearing document, not a bitmap.
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

  "model/gltf-binary": "MODEL_3D",
  "model/gltf+json": "MODEL_3D"
};

/**
 * ⚠ Mirrors `MEDIA_KIND_LABELS` in components/studio/media/MediaGrid.tsx.
 *
 * Restated rather than imported: that module's siblings are `"use client"`, and importing a component
 * module into a route handler replaces its exports with client references. The words matter because the
 * refusal below is the same sentence the panel shows before the upload starts.
 */
const KIND_LABELS: Record<MediaKind, string> = {
  IMAGE: "an image",
  VIDEO: "a video",
  AUDIO: "an audio recording",
  DOCUMENT: "a document",
  MODEL_3D: "a 3D model",
  PANORAMA: "a panorama"
};

const VARIANT_SELECT = {
  select: { label: true, format: true, objectKey: true, width: true },
  orderBy: { width: "asc" as const }
};

const ReplaceBody = z.object({
  objectKey: z.string().trim().min(1).max(1024),
  fileName: z
    .string()
    .trim()
    .min(1, "The file has no name, so there is nothing to store it under.")
    .max(255, "That file name is longer than 255 characters. Rename it and try again."),
  contentType: z
    .string()
    .trim()
    .min(1, "The browser could not tell what type of file this is, usually because it has no extension.")
    .max(160),
  byteSize: z
    .number()
    .int("A file size has to be a whole number of bytes.")
    .positive("That file is empty (0 bytes). Choose the file itself rather than a folder.")
});

/**
 * May a file of this content type stand in for an asset of this kind?
 *
 * The KIND NEVER CHANGES — that is what makes this a replacement rather than a new upload. Everything
 * already using the asset expects what it had: an article laying out a photograph cannot render a PDF,
 * and the page would simply have a hole in it. So the answer is either "yes, keep the kind" or a sentence
 * explaining the refusal.
 *
 * Two kinds cannot be read off the wire and are therefore judged against what the ROW already says:
 * a PANORAMA is an ordinary JPEG, and a MODEL_3D is only ever a glTF. An SVG is a document whatever it
 * arrives as, so it may only replace a DOCUMENT.
 */
function checkReplacement(contentType: string, current: MediaKind): { problem: string } | null {
  const implied = CONTENT_TYPE_KINDS[contentType];
  if (!implied) {
    return {
      problem:
        `Files of type ${contentType} are not accepted in the media library, so nothing was changed. ` +
        "Images, video, audio, PDFs, Office documents, plain text and glTF models can be uploaded."
    };
  }

  const arriving: MediaKind = isSvg(contentType)
    ? "DOCUMENT"
    : current === "PANORAMA" && implied === "IMAGE"
      ? "PANORAMA"
      : implied;

  if (arriving !== current) {
    return {
      problem:
        `This record is ${KIND_LABELS[current]} and the file you chose is ${KIND_LABELS[arriving]}. ` +
        "A replacement has to be the same kind of thing, because everything already using this file " +
        "expects it. Upload it as a new file instead."
    };
  }

  return null;
}

export const POST = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Replacing a file needs media manager access or higher. An administrator can raise yours."
  );
  // A 503 rather than a 500: unconfigured storage is a deployment state, not a bug.
  requireStorage();

  const { id } = await context.params;
  const body = await parseJson(request, ReplaceBody);
  const objectKey = body.objectKey;
  const contentType = body.contentType.toLowerCase();

  // ── Is this a key this deployment could have issued? ────────────────────────────────────────────
  // Without this test a caller could point an asset at ANY object in the bucket — another asset's
  // derivative, or a private document from the file store, which would then have a public CDN URL.
  if (!isSafeObjectKey(objectKey) || !ISSUED_MEDIA_KEY.test(objectKey)) {
    throw badRequest(
      "That storage address is not one the media library issues, so nothing was changed. Start the upload again."
    );
  }

  const asset = await prisma.mediaAsset.findFirst({
    // The recycle bin is out of scope: replacing the file behind a deleted row would put new bytes
    // somewhere nothing on the site can see, and the restore would then bring back a different picture.
    where: { id, deletedAt: null },
    select: {
      // The image columns come from the one shared media select (lib/media/select.ts) rather than a
      // hand-written copy, so this read cannot fall behind the next column added to a renderable image.
      ...MEDIA_IMAGE_SELECT_WITH_ID,
      // The file's own bookkeeping, which the audit `before` records so a mistaken replacement is
      // recoverable. `variants` is narrowed to the rows themselves: their keys are the objects this
      // replacement abandons, and nothing here renders them.
      kind: true,
      fileName: true,
      mimeType: true,
      byteSize: true,
      checksum: true,
      variants: { select: { id: true, objectKey: true } }
    }
  });
  if (!asset) throw notFound("That file");

  const problem = checkReplacement(contentType, asset.kind);
  if (problem) throw badRequest(problem.problem);

  if (objectKey === asset.objectKey) {
    throw badRequest(
      "That is the file this record already points at, so there was nothing to replace. Choose the new file again."
    );
  }

  // Already spoken for? The unique index on `objectKey` would refuse the write anyway, but a P2002
  // reaches the reader as "something went wrong" and this reaches them as an explanation. The recycle bin
  // is deliberately NOT excluded: a soft-deleted row still owns its bytes until the purge runs.
  const [takenByAsset, takenByVariant] = await Promise.all([
    prisma.mediaAsset.findUnique({ where: { objectKey }, select: { id: true, deletedAt: true } }),
    prisma.mediaVariant.findUnique({ where: { objectKey }, select: { assetId: true } })
  ]);
  if (takenByAsset) {
    throw conflict(
      takenByAsset.deletedAt
        ? "That upload is already in the library as a separate file, currently in the recycle bin. Nothing was changed."
        : "That upload is already in the library as a separate file. Nothing was changed."
    );
  }
  if (takenByVariant) {
    throw conflict(
      "That storage address belongs to a smaller version of another file and cannot be used on its own."
    );
  }

  // ── Did the bytes actually land? ────────────────────────────────────────────────────────────────
  // Trusting the browser's "done" is how a row ends up pointing at a key that was never written — a
  // broken image with a perfectly healthy-looking database, found weeks later by a visitor.
  const head = await headObject(objectKey);
  if (!head) {
    throw badRequest(
      "The upload did not reach storage, so nothing was changed. Nothing is stored under that address. " +
        "Try uploading the file again."
    );
  }

  // ── Are they the bytes that were described? ─────────────────────────────────────────────────────
  if (head.byteSize !== body.byteSize) {
    // This key was issued by the media library a moment ago and no row references it, so removing it is
    // safe — and it is the only way this refusal does not leave an object nothing will ever collect.
    await deleteObject(objectKey).catch((error: unknown) => {
      console.error("[media/replace] could not remove a rejected upload", objectKey, error);
    });
    throw badRequest(
      `What reached storage is ${formatBytes(head.byteSize)} but the upload was described as ` +
        `${formatBytes(body.byteSize)}. Nothing was changed. Try uploading the file again.`
    );
  }

  // ── The bytes, once, for the fingerprint and the derivatives ────────────────────────────────────
  const derivable = DERIVABLE_MIME_TYPES.has(contentType) && head.byteSize <= DERIVE_MAX_BYTES;
  const wantsChecksum = head.byteSize <= CHECKSUM_MAX_BYTES;

  let bytes: Buffer | null = null;
  if (derivable || wantsChecksum) {
    bytes = await getObjectBytes(objectKey);
  }

  const checksum = bytes && wantsChecksum ? createHash("sha256").update(bytes).digest("hex") : null;

  /**
   * Everything the row records about the FILE ITSELF is recomputed, never carried over.
   *
   * A replacement whose dimensions were inherited from the previous file would render inside an
   * aspect-ratio box of the wrong shape — the "portrait photograph in a landscape frame" layout shift —
   * and a blur placeholder from the old picture would show the old picture for a moment on every load.
   */
  let width: number | null = null;
  let height: number | null = null;
  let blurDataUrl: string | null = null;
  let variants: {
    label: string;
    format: string;
    objectKey: string;
    width: number;
    height: number;
    byteSize: number;
  }[] = [];
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
        "The new picture could not be read, so no smaller versions were made and its dimensions are " +
          "unknown. It is stored exactly as uploaded."
      );
    }
  } else if (bytes && CONTENT_TYPE_KINDS[contentType] === "IMAGE" && !isSvg(contentType)) {
    // An image the pipeline cannot resize, or one too large to try. The dimensions are still worth
    // recording: the layout uses them for the box that prevents a shift on load.
    const probe = await probeImage(bytes);
    if (probe) {
      width = probe.width;
      height = probe.height;
    }
  }

  if (DERIVABLE_MIME_TYPES.has(contentType) && !derivable) {
    notes.push(
      `The new file is ${formatBytes(head.byteSize)}, which is above the ${formatBytes(DERIVE_MAX_BYTES)} ` +
        "limit for making smaller versions, so none were made. The site will send the full-size file to " +
        "every visitor until an administrator regenerates them."
    );
  }
  if (!wantsChecksum) {
    notes.push(
      `The new file is ${formatBytes(head.byteSize)}, which is above the ${formatBytes(CHECKSUM_MAX_BYTES)} ` +
        "limit for fingerprinting, so it was stored without one. That only affects duplicate detection."
    );
  }

  const auditContext: AuditContext = {
    actor: { id: user.id, email: user.email },
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };

  const abandonedVariantKeys = asset.variants.map((variant) => variant.objectKey);

  // ── The row, its variants, its revision and the audit entry: one transaction ────────────────────
  let updated;
  try {
    updated = await mutateWithHistory<
      Prisma.MediaAssetGetPayload<{ include: { variants: typeof VARIANT_SELECT } }>
    >(
      auditContext,
      {
        action: "UPDATE",
        entityType: "MediaAsset",
        entityLabel: body.fileName,
        /**
         * The PREVIOUS keys, spelled out. This is what makes a mistaken replacement recoverable and what
         * an administrator reads to find the abandoned objects — see the header. Nothing else records
         * them once the row has moved on.
         */
        before: {
          objectKey: asset.objectKey,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          width: asset.width,
          height: asset.height,
          checksum: asset.checksum,
          variantObjectKeys: abandonedVariantKeys
        },
        summary: "File replaced"
      },
      async (tx) => {
        // The old rows first. They describe derivatives of a key this asset is about to stop pointing at,
        // and `pickVariant` prefers a variant over the original — see the header.
        await tx.mediaVariant.deleteMany({ where: { assetId: asset.id } });

        await tx.mediaAsset.update({
          where: { id: asset.id },
          data: {
            objectKey,
            fileName: body.fileName,
            mimeType: contentType,
            byteSize: head.byteSize,
            width,
            height,
            checksum,
            blurDataUrl,
            /**
             * Nothing in this codebase measures duration, so this is `null` either way today. It is
             * written explicitly because carrying the PREVIOUS file's length over would be a statement
             * about bytes that are no longer here.
             */
            duration: null
            /**
             * ⚠ `kind`, `altText`, `caption`, `credit`, `copyright`, `tags` and `folderId` are absent on
             * purpose. An omitted key in a Prisma `update` leaves the column alone, and every one of
             * those describes the SLOT rather than the bytes — the whole reason somebody replaces a file
             * instead of uploading a new one is to keep them. `kind` is additionally guaranteed
             * unchanged by `checkReplacement` above.
             */
          }
        });

        if (variants.length > 0) {
          // Only the derivatives that actually reached storage get a row. A variant row for an object
          // that does not exist is a broken image with a healthy database.
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
    /**
     * The new derivatives are already in the bucket and nothing now references them — their keys are
     * derived from an original this row never adopted, so no retry will look for them either. Removing
     * them is the difference between a failed replacement and a bucket that grows every time one fails.
     *
     * The newly uploaded ORIGINAL is deliberately left: the signed PUT already succeeded, so a retry of
     * this request with the same key is the recovery path, and deleting it would close that off.
     */
    if (variants.length > 0) {
      const cleanup = await deleteObjects(variants.map((variant) => variant.objectKey));
      if (cleanup.failed.length > 0) {
        console.error(
          "[media/replace] the record was not changed and %d new derivative object(s) could not be removed",
          cleanup.failed.length,
          cleanup.failed
        );
      }
    }
    throw error;
  }

  return ok({
    ...updated,
    /**
     * What the derivative pipeline managed. `failed` names the sizes that are MISSING, so the panel can
     * say which ones rather than implying the set is complete.
     */
    derivatives: {
      generated: variants.length,
      failed: derivativeFailures,
      notes
    },
    /**
     * The bytes that are no longer referenced by any row. Named here as well as in the audit entry
     * because they are NOT collected by anything — see the header — and an administrator watching
     * storage grow needs to know what these replacements left behind.
     */
    previous: {
      objectKey: asset.objectKey,
      fileName: asset.fileName,
      byteSize: asset.byteSize,
      variantObjectKeys: abandonedVariantKeys,
      retained: true,
      note:
        "The previous file and its smaller versions are still in storage, so this replacement can be " +
        "undone and any page already served keeps working while caches refresh. They are not removed " +
        "automatically."
    }
  });
});
