import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ApiError, notFound, route } from "@/lib/api";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/ratelimit";
import { headObject, presignDownload, requireStorage, storageAvailable } from "@/lib/storage/client";
import { isSafeObjectKey } from "@/lib/storage/keys";

/**
 * The same file, served to be LOOKED AT rather than saved.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AS A SECOND ROUTE AT ALL, when `../route.ts` already serves the bytes. That one signs
 * with `Content-Disposition: attachment`, which is deliberate and load-bearing there: the file store
 * accepts `application/octet-stream` for research data precisely BECAUSE everything it serves is saved
 * rather than rendered. A browser handed an attachment downloads it — so an `<iframe>` pointed at that
 * route leaves an empty box on the page and a file in the reader's Downloads folder, which is the exact
 * silent failure `documentEmbedSectionSchema` documents at length. Weakening the disposition there would
 * make every dataset in the library renderable in place, which is not ours to decide from a preview
 * feature. So the two dispositions get two addresses.
 *
 * ⚠ IT SERVES A PDF AND NOTHING ELSE, EVER. Two independent guards, because one is a check and two are a
 * property:
 *
 *   1. The route refuses unless the thing it is about to sign IS a PDF — either the version's own
 *      `mimeType` is exactly `application/pdf`, or a `previewObjectKey` exists, which this application
 *      wrote itself after `convertToPdf` verified the `%PDF-` magic bytes.
 *   2. `ResponseContentType: "application/pdf"` is forced on the signed URL regardless of what is stored,
 *      so a mislabelled object cannot arrive claiming to be HTML.
 *
 * Without both, a route that renders arbitrary uploaded bytes inline is a stored-XSS delivery mechanism:
 * the file store accepts ANY content type from signed-in staff — its chooser is deliberately
 * unrestricted, since research data has no agreed type — so an `.html` uploaded as a "dataset" would
 * execute if this route ever signed it without a disposition.
 *
 * ⚠ AND IT MUST STAY A REDIRECT, NOT A PROXY, FOR A SECURITY REASON AS WELL AS A COST ONE.
 * `components/sections/DocumentEmbedSection.tsx` explains why its frame carries no `sandbox`: Chrome's
 * PDF viewer will not render inside a sandboxed frame, and what makes that acceptable to forgo is that
 * the frame's origin is the OBJECT STORE'S, not this site's — so nothing inside it can reach the page,
 * its cookies or its session. A frame served by this route inherits that property only because the 302
 * lands the document on the storage origin. Streaming the bytes through here instead would put a
 * reader-supplied PDF on our own origin, in an unsandboxed frame, and quietly undo the reasoning the
 * other block relies on.
 *
 * ⚠ IT DOES NOT COUNT A DOWNLOAD, and that is not an oversight. `downloadCount` is a figure the Centre
 * reports; a page that frames a PDF would inflate it once per page view, and a lazily-loaded frame would
 * do so for readers who never looked at it. Somebody who wants the file presses the download link beside
 * the frame, which goes through the counted route.
 *
 * THE ACCESS CONTROL IS THE SAME PREDICATE, spelled out again rather than shared, because it is short and
 * because a preview that outlived an embargo would be worse than a download that did. Not deleted,
 * public, not lapsed — the rule lib/search/index.ts's `searchDocFromFile` also states.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** As the download route: long enough to START the transfer, short enough not to be shareable. */
const SIGNED_URL_SECONDS = 120;

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export const GET = route(async (request: NextRequest, context: RouteContext) => {
  /**
   * ⚠ ITS OWN ROUTE NAME, SHARING THE DOWNLOAD POLICY. A separate bucket, because a reader looking at one
   * publication should not spend the allowance that stops somebody scripting the download endpoint — and
   * the same limits, because each request here costs exactly what one there does: a storage HEAD and a
   * signature.
   */
  const limited = enforceRateLimit(
    request,
    "file-preview",
    RATE_LIMITS.download,
    (phrase) =>
      `That is a lot of document previews from one connection in a short time, so this is paused for ${phrase}. ` +
      "Nothing has gone wrong with the files themselves."
  );
  if (limited) return limited;

  const { slug } = await context.params;

  const file = await prisma.fileAsset.findFirst({
    where: { slug, deletedAt: null },
    select: {
      id: true,
      title: true,
      isPublic: true,
      expiresAt: true,
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: {
          version: true,
          objectKey: true,
          fileName: true,
          mimeType: true,
          previewObjectKey: true
        }
      }
    }
  });

  // Missing and not-public are ONE answer, for the reason the download route gives: a 403 confirms that a
  // file with this slug exists, which for embargoed material is the fact being protected.
  if (!file || !file.isPublic) throw notFound("That file");

  if (file.expiresAt && file.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(
      410,
      `“${file.title}” was available until ${formatDay(file.expiresAt)} and the link has now expired.`,
      { code: "expired" }
    );
  }

  const version = file.versions[0];
  if (!version) {
    throw new ApiError(
      404,
      `“${file.title}” has a catalogue entry but no file has been uploaded against it yet, so there is nothing to show.`,
      { code: "no_version" }
    );
  }

  /**
   * WHICH OBJECT IS A PDF — guard 1 of the two the header describes.
   *
   * The converted preview wins over the original when both could serve, which only happens if a version
   * is a PDF that was also converted; harmless, and preferring the preview keeps one code path warm.
   */
  const key =
    version.previewObjectKey ??
    (version.mimeType.toLowerCase() === "application/pdf" ? version.objectKey : null);

  if (!key) {
    // A 404 rather than a 415: to a reader there is no preview at this address, and the format is not
    // something they can act on. The page never links here for such a file — this is the direct hit.
    throw new ApiError(
      404,
      `“${file.title}” has no version a browser can display. It can still be downloaded, and a PDF preview may not have been made for it yet.`,
      { code: "no_preview" }
    );
  }

  if (!storageAvailable()) requireStorage();

  if (!isSafeObjectKey(key)) {
    console.error("[files] unusable object key for inline preview on file", file.id, "version", version.version);
    throw new ApiError(
      500,
      `“${file.title}” points at a storage location this application cannot read.`,
      { code: "bad_object_key" }
    );
  }

  // CONFIRM THE BYTES EXIST before promising them — a redirect to a purged key reaches the reader as an
  // XML error document from a storage vendor, inside a frame, with no way to tell it from a broken site.
  let head;
  try {
    head = await headObject(key);
  } catch (error) {
    console.error("[files] storage HEAD failed for inline preview", key, error);
    throw new ApiError(503, "The file store could not be reached, so this preview cannot be shown.", {
      code: "storage_unreachable"
    });
  }
  if (!head) {
    throw new ApiError(
      404,
      `“${file.title}” is listed in the catalogue but its file is no longer in storage.`,
      { code: "object_missing" }
    );
  }

  const signedUrl = await presignDownload({
    key,
    expiresInSeconds: SIGNED_URL_SECONDS,
    /**
     * ⚠ NO `downloadFileName`, WHICH IS THE WHOLE POINT OF THIS ROUTE. `presignDownload` adds
     * `Content-Disposition: attachment` only when given one, so omitting it is what makes the object
     * render instead of saving. That is the single line of difference from the download route, and it is
     * why the guard above has to be exact.
     */
    contentType: "application/pdf"
  });

  // 302, never 301: the target expires in two minutes, and a cached permanent redirect would send every
  // later request straight to a dead signature.
  const response = NextResponse.redirect(signedUrl, 302);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
});
