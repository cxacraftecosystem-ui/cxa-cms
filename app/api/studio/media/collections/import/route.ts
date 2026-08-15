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
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/ratelimit";
import { deleteObjects, putObject, requireStorage } from "@/lib/storage/client";
import { buildObjectKey } from "@/lib/storage/keys";
import { generateDerivatives, probeImage } from "@/lib/storage/derivatives";
import {
  OPEN_COLLECTION_IMPORT_RATE_LIMIT,
  OPEN_COLLECTION_MAX_IMAGE_BYTES,
  OPEN_COLLECTION_SOURCES,
  OPEN_COLLECTION_SOURCE_LABELS,
  downloadOpenCollectionImage,
  fetchOpenCollectionRecord,
  openCollectionFileName,
  openCollectionIdentityTag,
  openCollectionTags,
  normaliseSourceId,
  type OpenCollectionSource
} from "@/lib/media/open-collections";
import { formatBytes } from "@/lib/utils";

/**
 * Importing ONE openly-licensed photograph from a museum into the media library.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ ONE RECORD PER REQUEST, ON PURPOSE. `components/studio/media/OpenCollectionImport.tsx` sends these
 * one at a time and in order, and that is not a limitation to be optimised away. Each call downloads up
 * to 40 MB and hands it to sharp, which holds the decoded bitmap in memory; three at once is how a
 * function meets its memory limit and loses all three. Doing them one at a time is also what gives the
 * picker real per-item progress and lets it name the third failure without abandoning the fourth.
 *
 * SIX RULES, IN ORDER. Skipping any of them is a defect, and the reason is written beside each:
 *
 *  1. **THE RECORD IS RE-FETCHED AND THE LICENCE RE-DECIDED SERVER-SIDE.** The body carries a source
 *     and an identifier and NOTHING ELSE — no licence, no title, no image URL. A licence a client sent
 *     is a value the caller chose; accepting one would let an edited search result present a
 *     copyrighted photograph as CC0 and this route would believe it. This is the whole control.
 *  2. **THE DUPLICATE CHECK RUNS BEFORE THE DOWNLOAD.** Matched on the stored identity tag
 *     (`met:436535`), so importing the same object twice returns the asset that is already there rather
 *     than pulling 30 MB across the wire to discover it. Matched AGAIN on the SHA-256 of the bytes
 *     afterwards, which catches the same photograph reached through two different records.
 *  3. **THE DOWNLOAD IS CAPPED AND DEADLINED.** Both live in the library module, along with the
 *     allow-list of hosts a file may come from — a URL out of somebody else's JSON must not be able to
 *     make this server fetch an address on its own private network.
 *  4. **THE BYTES ARE PROVED TO BE AN IMAGE BEFORE ANYTHING IS STORED.** `probeImage` reads the actual
 *     pixels, and the stored MIME type comes from what it found rather than from the `Content-Type`
 *     header. Without this, a redirect to an HTML error page becomes a "photograph" in the library —
 *     a row that looks perfect and renders as a broken image on a published page.
 *  5. **THE ATTRIBUTION AND THE LICENCE ARE STORED, AND `altText` IS LEFT NULL.** `credit` is the
 *     attribution built once by the library module in the form the licence requires; `copyright` is the
 *     licence itself. `altText` is `null` because a machine cannot write alt text, and `null` means
 *     "nobody has written one" — which puts it on the studio's accessibility backlog, where it belongs.
 *     `""` would mean "somebody decided this is decorative", which is a different statement and a false
 *     one for a museum photograph.
 *  6. **THE ROW, ITS VARIANTS, ITS REVISION AND THE AUDIT ENTRY ARE ONE TRANSACTION**, and if the write
 *     fails, every object written a moment earlier — the original and every derivative — is deleted
 *     again. A failure must leave the bucket as it was rather than salting it with unreferenced files.
 *
 * THE CAPTION IS DELIBERATELY LEFT EMPTY, and the source URL is not put in it. `caption` is published
 * as a figcaption on the public site (GallerySection, MediaLightbox, RichText), and a bare URL under a
 * photograph is not a caption. The source URL is stored twice regardless: inside `credit`, where every
 * licence form here ends with it, and as the identity tag, which `openCollectionSourceUrl()` expands.
 *
 * THIS ROUTE NEEDS TIME AND MEMORY. ⚠ `vercel.json` grants those to `media/complete` and
 * `media/[id]/replace` and does NOT yet name this file — it needs the same
 * `{ "memory": 3009, "maxDuration": 300 }` entry for exactly the same reason: sharp decoding a
 * full-resolution museum scan is a large bitmap and a slow one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * What sharp reports, mapped to what is stored.
 *
 * The stored MIME type comes from HERE, never from the response header — see rule 4. A format sharp
 * recognises but this map does not is REFUSED rather than stored with a guessed type: `svg` is the one
 * that matters (an SVG is a script-bearing document, not a bitmap, and it is deliberately absent from
 * the derivative pipeline's own list too).
 */
const PROBED_MIME_TYPES: Readonly<Record<string, string>> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  tiff: "image/tiff",
  gif: "image/gif",
  avif: "image/avif"
};

/** How many byte-identical assets are named back, as in the ordinary upload path. */
const DUPLICATE_LIMIT = 5;

const ImportBody = z.object({
  source: z.enum(OPEN_COLLECTION_SOURCES),
  /**
   * The source's own identifier and the only thing about the record this route trusts — and even this
   * is re-validated into its canonical form by `normaliseSourceId` before it reaches a URL.
   */
  sourceId: z.string().trim().min(1, "The record reference is missing.").max(300),
  /** `null` and an omitted key both mean "not in a folder"; an id is checked to exist. */
  folderId: z.string().trim().min(1).max(64).nullable().optional()
});

/** The variant columns `MediaLike` and the media grid both read. In step with the upload path. */
const VARIANT_SELECT = {
  select: { label: true, format: true, objectKey: true, width: true },
  orderBy: { width: "asc" as const }
};

type ImportedAsset = Prisma.MediaAssetGetPayload<{ include: { variants: typeof VARIANT_SELECT } }>;

/** The row shape the picker hands straight to the media grid, plus what happened to it. */
function existingAnswer(asset: ImportedAsset, reason: string) {
  return ok({
    status: "existing" as const,
    reason,
    asset,
    derivatives: { generated: asset.variants.length, failed: [], notes: [] as string[] }
  });
}

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Importing from the open collections needs media manager access or higher. An administrator can raise yours."
  );
  requireStorage();

  const limited = enforceRateLimit(
    request,
    "open-collections-import",
    OPEN_COLLECTION_IMPORT_RATE_LIMIT,
    (phrase) =>
      `No more pictures can be imported for ${phrase}. Each import downloads a full-size file from ` +
      "the museum, so the pause keeps this installation a well-behaved visitor to their free service. " +
      "Anything already imported has been kept."
  );
  if (limited) return limited;

  const body = await parseJson(request, ImportBody);
  const source: OpenCollectionSource = body.source;
  const sourceLabel = OPEN_COLLECTION_SOURCE_LABELS[source];

  /**
   * Canonicalised BEFORE anything is done with it, and used everywhere below.
   *
   * ⚠ Not merely trimmed. A Commons reference arrives with either spelling of the word separator —
   * `File:Bagru_printing.jpg` and `File:Bagru printing.jpg` name the SAME file — so the duplicate check
   * a few lines down would miss one form of it, import a second copy, and only the checksum would catch
   * the mistake after thirty megabytes had already crossed the wire. This is also what stops a control
   * character reaching a query string.
   */
  const sourceId = normaliseSourceId(source, body.sourceId);
  if (!sourceId) {
    throw badRequest(
      `“${body.sourceId}” is not a reference ${sourceLabel} uses, so nothing was fetched. ` +
        "Choose the picture from the search results rather than typing a reference by hand."
    );
  }

  if (body.folderId) {
    const folder = await prisma.mediaFolder.findUnique({
      where: { id: body.folderId },
      select: { id: true }
    });
    if (!folder) {
      throw badRequest(
        "The folder this was being filed into no longer exists. Reload the media library and try the import again."
      );
    }
  }

  // ── Rule 2, first half: is this record already here? ─────────────────────────────────────────
  // Before the download, so importing the same object twice costs one indexed query rather than thirty
  // megabytes. The recycle bin is included: a soft-deleted row still owns those bytes until the purge.
  const identityTag = openCollectionIdentityTag(source, sourceId);
  const alreadyHere = await prisma.mediaAsset.findMany({
    where: { tags: { has: identityTag } },
    include: { variants: VARIANT_SELECT },
    orderBy: { createdAt: "asc" },
    take: 2
  });
  const liveMatch = alreadyHere.find((asset) => asset.deletedAt === null);
  if (liveMatch) {
    return existingAnswer(
      liveMatch,
      `This picture has already been imported from ${sourceLabel}, so the copy already in the library was used ` +
        "instead of downloading it again."
    );
  }
  const binnedMatch = alreadyHere[0];
  if (binnedMatch) {
    throw conflict(
      `This picture has been imported from ${sourceLabel} before and is currently in the recycle bin. ` +
        "Restore it there rather than importing it again, so the description and credit somebody has already " +
        "written for it are kept."
    );
  }

  // ── Rule 1: re-fetch the record and re-decide the licence, server-side ────────────────────────
  const lookup = await fetchOpenCollectionRecord({ source, sourceId });
  if (!lookup.ok) {
    // A refusal on licence grounds is a 409, not a 500 and not a 400: the request was well formed and
    // the answer is a deliberate "no". A source that could not be reached is a 503 — a condition, not a
    // mistake anybody made.
    throw lookup.refused
      ? conflict(lookup.reason)
      : new ApiError(503, lookup.reason, { code: "source_unavailable" });
  }
  const record = lookup.record;

  // ── Rule 3: download, capped and deadlined ───────────────────────────────────────────────────
  const download = await downloadOpenCollectionImage({
    url: record.fullUrl,
    maxBytes: OPEN_COLLECTION_MAX_IMAGE_BYTES
  });
  if (!download.ok) throw badRequest(download.reason);

  const bytes = Buffer.from(download.bytes);

  // ── Rule 4: are these actually the bytes of an image? ────────────────────────────────────────
  const probe = await probeImage(bytes);
  if (!probe) {
    throw badRequest(
      `${sourceLabel} sent something that is not a picture this library can read, so nothing was stored. ` +
        "That usually means the address now leads to an error page rather than to the file."
    );
  }
  const mimeType = probe.format ? PROBED_MIME_TYPES[probe.format] : undefined;
  if (!mimeType) {
    throw badRequest(
      `The file at ${sourceLabel} is ${probe.format ?? "of an unknown kind"}, which the media library does ` +
        "not store as a photograph. Nothing was added."
    );
  }

  // ── Rule 2, second half: the same photograph reached by another route ─────────────────────────
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const byChecksum = await prisma.mediaAsset.findFirst({
    where: { checksum, deletedAt: null },
    include: { variants: VARIANT_SELECT },
    orderBy: { createdAt: "asc" }
  });
  if (byChecksum) {
    // Nothing has been written to storage yet, so there is nothing to clean up — which is exactly why
    // the checksum is computed before the upload rather than after it.
    return existingAnswer(
      byChecksum,
      `This picture is byte-for-byte identical to “${byChecksum.fileName}”, which is already in the library, ` +
        "so that copy was used instead of storing a second one."
    );
  }

  // ── The storage pipeline: the same one every upload goes through ──────────────────────────────
  const fileName = openCollectionFileName(record);
  const objectKey = buildObjectKey({ namespace: "media", fileName });

  await putObject({ key: objectKey, body: bytes, contentType: mimeType });

  const derived = await generateDerivatives({ originalKey: objectKey, bytes });

  const notes: string[] = [];
  if (derived.variants.length === 0) {
    notes.push(
      "None of the smaller versions could be made, so the site will send the full-size file to every " +
        "visitor until an administrator regenerates them."
    );
  }

  /**
   * The tags the asset is created with, including the identity tag the duplicate check reads.
   *
   * Both spellings are stored when they differ. Commons follows a rename: asking for
   * `File:Old name.jpg` answers with the record whose canonical title is `File:New name.jpg`, and the
   * asset has to be findable under BOTH — otherwise the next editor who imports it under the name they
   * were given gets a second copy, and only the checksum notices.
   */
  const tags = openCollectionTags(source, record.sourceId);
  if (record.sourceId !== sourceId) tags.push(openCollectionIdentityTag(source, sourceId));

  const context: AuditContext = {
    actor: { id: user.id, email: user.email },
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };

  // ── Rule 6: one transaction, and clean the bucket if it fails ────────────────────────────────
  let created: ImportedAsset;
  try {
    created = await mutateWithHistory<ImportedAsset>(
      context,
      {
        action: "UPLOAD",
        entityType: "MediaAsset",
        entityLabel: fileName,
        summary: `Imported from ${sourceLabel}`
      },
      async (tx) => {
        const asset = await tx.mediaAsset.create({
          data: {
            kind: "IMAGE",
            objectKey,
            fileName,
            mimeType,
            byteSize: bytes.byteLength,
            width: derived.width > 0 ? derived.width : probe.width,
            height: derived.height > 0 ? derived.height : probe.height,
            checksum,
            blurDataUrl: derived.blurDataUrl,
            // Rule 5. `null`, never `""` — see the header.
            altText: null,
            // Left for an editor. A URL is not a caption, and this one is published.
            caption: null,
            credit: record.attribution,
            copyright: record.licenceUrl ? `${record.licence} — ${record.licenceUrl}` : record.licence,
            tags,
            folderId: body.folderId ?? null,
            uploaderId: user.id
          }
        });

        if (derived.variants.length > 0) {
          // Only the derivatives that actually reached storage get a row: a variant row for an object
          // that does not exist is a broken image with a healthy database.
          await tx.mediaVariant.createMany({
            data: derived.variants.map((variant) => ({ assetId: asset.id, ...variant }))
          });
        }

        return tx.mediaAsset.findUniqueOrThrow({
          where: { id: asset.id },
          include: { variants: VARIANT_SELECT }
        });
      }
    );
  } catch (error) {
    // The original and its derivatives are in the bucket and nothing now references them. Removing
    // them is the difference between a failed import and a bucket that grows every time one fails.
    // The ORIGINAL is included, unlike the ordinary upload path's cleanup: there the object was put in
    // the bucket by the browser under a key this endpoint issued and a retry reuses it, whereas here
    // the server wrote it and nothing will ever refer to it again.
    const orphans = [objectKey, ...derived.variants.map((variant) => variant.objectKey)];
    const cleanup = await deleteObjects(orphans);
    if (cleanup.failed.length > 0) {
      console.error(
        "[media/collections/import] the record was not created and %d object(s) could not be removed",
        cleanup.failed.length,
        cleanup.failed
      );
    }
    throw error;
  }

  // Byte-identical files already in the library, REPORTED rather than merged — the same courtesy the
  // ordinary upload path offers. Nothing here matched on the checksum (that path returned above), so
  // this can only be non-empty if something landed between the two queries.
  const duplicates = await prisma.mediaAsset.findMany({
    where: { checksum, deletedAt: null, id: { not: created.id } },
    select: { id: true, fileName: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: DUPLICATE_LIMIT
  });

  return ok({
    status: "imported" as const,
    asset: created,
    /** Repeated back so the picker can show what was agreed to, beside what was created. */
    licence: record.licence,
    licenceUrl: record.licenceUrl,
    attribution: record.attribution,
    sourceUrl: record.sourceUrl,
    size: formatBytes(bytes.byteLength),
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
      generated: derived.variants.length,
      failed: derived.failed,
      notes
    }
  });
});
