import type { Prisma } from "@prisma/client";

import { assertSameOrigin, ApiError, ok, route } from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import {
  convertToPdf,
  documentConverterConfigured,
  pdfConvertibleExtension
} from "@/lib/documents/convert";
import { canManageContent } from "@/lib/permissions";
import { getObjectBytes, putObject, requireStorage, storageAvailable } from "@/lib/storage/client";
import { buildVariantKey, isSafeObjectKey } from "@/lib/storage/keys";
import { buildAuditContext, found } from "@/lib/studio/crud";

/**
 * Make a PDF a browser can draw, for a document whose own format it cannot.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR. A browser renders a PDF and renders nothing else — no Word, no PowerPoint, no
 * OpenDocument — so a publication whose full text is a `.docx` could only ever be offered as a download.
 * Converting once, here, means one reader-facing path (a framed PDF) instead of three, and it reuses the
 * viewer that already handles the `<iframe>` and CSP traps `DocumentEmbedSection` documents.
 *
 * ⚠ CONVERTED ONCE ON DEMAND, NEVER ON EVERY PAGE VIEW, AND NEVER THROUGH A VIEWER SERVICE. Office Online
 * and Google Docs Viewer render a deck by fetching it from our storage into theirs, on every page load,
 * cached indefinitely — including a document withdrawn an hour later. This asks a converter ONCE, from our
 * server, uploads the result to our own bucket, and every reader afterwards is served a static PDF from
 * our own CDN. The third party sees the bytes a single time and never sees a reader.
 *
 * ⚠ IT IS A POST WITH NO BODY, AND THAT IS NOT A GET. It spends money at a third party, writes an object
 * to storage and mutates a row; a GET that did any of those would be fetched by a link prefetcher.
 *
 * ⚠ A FAILURE IS RECORDED, NOT THROWN AWAY, AND IT IS STILL A 200. `convertToPdf` never throws for an
 * expected failure — no key configured, a format it does not take, the provider refusing — it returns
 * `{ ok: false, reason }`. Those reasons are written to `previewFailedReason` so the studio can say WHY
 * beside the document instead of offering a button that silently does nothing twice. The answer is a
 * success because the request was handled correctly; `made: false` carries the outcome. A 5xx here would
 * put "something went wrong on our side" in front of an editor whose file is simply a format the
 * converter does not accept.
 *
 * ⚠ THE KEY IS DERIVED FROM THE ORIGINAL'S, via `buildVariantKey`, so a re-conversion lands on the SAME
 * key. That means the CDN serves the new bytes at the URL already embedded in published pages, with no
 * cache-busting query string — and it gives a purge a prefix to sweep, which the recycle bin notes a file
 * version otherwise lacks. The column is still the authority: both purge paths delete
 * `previewObjectKey` explicitly rather than trusting the convention.
 *
 * WHO MAY: `canManageContent`. It spends a paid quota and publishes bytes that appear on a public page,
 * which is an editor's decision rather than an author's.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * ⚠ A CONVERSION IS SLOW AND VERCEL'S DEFAULT IS NOT THE CONSTRAINT. `lib/documents/convert.ts` polls the
 * provider against its own deadline; this only has to be longer than that, or the function would be killed
 * mid-poll and the editor would see a timeout for a conversion that then completed at the provider with
 * nothing here to receive it.
 */
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VERSION_SELECT = {
  id: true,
  version: true,
  objectKey: true,
  fileName: true,
  mimeType: true,
  byteSize: true,
  previewObjectKey: true,
  previewByteSize: true,
  previewAttemptedAt: true,
  previewFailedReason: true
} as const satisfies Prisma.FileVersionSelect;

/**
 * Record the attempt, whether it produced anything or not. One place, so the two branches cannot drift.
 *
 * ⚠ THE MUTATE RETURNS THE **FILE'S** ID, NOT THE VERSION'S, and that is what makes the audit entry
 * findable. `mutateWithHistory` takes `entityId` from `result.id` — there is no `entityId` input — so
 * returning the updated `FileVersion` row unchanged would file the entry under `entityType: "FileAsset"`
 * with a version's id in it, and every audit and rollback screen keyed on that pair would miss it.
 */
async function recordOutcome(
  audit: AuditContext,
  file: { id: string; title: string },
  versionId: string,
  outcome:
    | { made: true; objectKey: string; byteSize: number }
    | { made: false; reason: string }
): Promise<void> {
  await mutateWithHistory(
    audit,
    {
      action: "UPDATE",
      entityType: "FileAsset",
      entityLabel: file.title,
      summary: outcome.made ? "A PDF preview was made" : "A PDF preview could not be made",
      /** NO REVISION: a preview is a derived artefact, not a version of the record's own content. */
      revise: false
    },
    async (tx) => {
      const updated = await tx.fileVersion.update({
        where: { id: versionId },
        data: outcome.made
          ? {
              previewObjectKey: outcome.objectKey,
              previewByteSize: outcome.byteSize,
              previewAttemptedAt: new Date(),
              // Cleared on success, so a document that failed once and then converted does not keep
              // reporting the old reason beside a preview that now exists.
              previewFailedReason: null
            }
          : {
              previewAttemptedAt: new Date(),
              previewFailedReason: outcome.reason
            },
        select: VERSION_SELECT
      });
      return { ...updated, id: file.id, versionId: updated.id };
    }
  );
}

export const POST = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Making a document preview needs editor access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const audit = buildAuditContext(request, user);

  const file = found(
    await prisma.fileAsset.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        title: true,
        versions: { orderBy: { version: "desc" }, take: 1, select: VERSION_SELECT }
      }
    }),
    "That file"
  );

  const version = file.versions[0];
  if (!version) {
    throw new ApiError(
      409,
      `“${file.title}” has a catalogue entry but no uploaded file, so there is nothing to convert.`,
      { code: "no_version" }
    );
  }

  // Already a PDF: no conversion, and saying so is better than making a byte-identical copy at a cost.
  if (version.mimeType.toLowerCase() === "application/pdf") {
    return ok({
      made: false,
      alreadyRenderable: true,
      message: `“${file.title}” is already a PDF, so it is shown on the page as it is. No preview is needed.`
    });
  }

  const extension = pdfConvertibleExtension(version.fileName);
  if (!extension) {
    return ok({
      made: false,
      alreadyRenderable: false,
      message: `“${version.fileName}” is not a format that can be turned into a PDF, so it stays a download. Nothing has been changed.`
    });
  }

  if (!documentConverterConfigured()) {
    return ok({
      made: false,
      alreadyRenderable: false,
      message:
        "No document converter is configured for this deployment, so no preview can be made. The document is still offered as a download. An administrator can add a converter key."
    });
  }

  if (!storageAvailable()) requireStorage();

  if (!isSafeObjectKey(version.objectKey)) {
    console.error("[files] unusable object key on version", version.id);
    throw new ApiError(
      500,
      `“${file.title}” points at a storage location this application cannot read, so it cannot be converted.`,
      { code: "bad_object_key" }
    );
  }

  let bytes: Buffer;
  try {
    bytes = await getObjectBytes(version.objectKey);
  } catch (error) {
    console.error("[files] could not read object for conversion", version.objectKey, error);
    throw new ApiError(
      503,
      "The document could not be read out of storage, so no preview was made. Try again in a moment — nothing has been changed.",
      { code: "storage_unreachable" }
    );
  }

  const converted = await convertToPdf({ bytes, fileName: version.fileName });

  if (!converted.ok) {
    // The reason is recorded and answered, not thrown — see the header on why this is a 200.
    await recordOutcome(audit, file, version.id, { made: false, reason: converted.reason });
    return ok({
      made: false,
      alreadyRenderable: false,
      reason: converted.reason,
      message: `No preview could be made for “${version.fileName}”: ${converted.reason} It is still offered as a download.`
    });
  }

  const previewKey = buildVariantKey({
    originalKey: version.objectKey,
    label: "preview",
    format: "pdf"
  });

  try {
    await putObject({
      key: previewKey,
      body: converted.pdf,
      contentType: "application/pdf",
      // A derived artefact at a stable key: a re-conversion replaces the bytes, so a long cache would
      // serve the old rendition. An hour is long enough to matter for a reader and short enough that a
      // correction reaches the site the same morning.
      cacheControl: "public, max-age=3600"
    });
  } catch (error) {
    console.error("[files] could not store the converted preview", previewKey, error);
    // ⚠ RECORDED AS A FAILURE, because from the reader's side that is exactly what it is: the conversion
    // happened and the bytes are nowhere. Leaving the row untouched would offer the button again with no
    // explanation of why the last press appeared to do nothing.
    await recordOutcome(audit, file, version.id, {
      made: false,
      reason: "The document was converted but the PDF could not be written to storage."
    });
    throw new ApiError(
      503,
      `“${file.title}” was converted but the PDF could not be saved, so there is still no preview. Try again in a moment.`,
      { code: "storage_write_failed" }
    );
  }

  await recordOutcome(audit, file, version.id, {
    made: true,
    objectKey: previewKey,
    byteSize: converted.pdf.byteLength
  });

  return ok({
    made: true,
    alreadyRenderable: false,
    seconds: converted.seconds,
    message: `“${file.title}” now has a PDF preview, so it is shown on the page rather than only offered as a download.`
  });
});
