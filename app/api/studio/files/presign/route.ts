import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, assertSameOrigin, badRequest, ok, parseJson, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { presignUpload, requireStorage } from "@/lib/storage/client";
import { buildObjectKey, extensionOf } from "@/lib/storage/keys";
import { formatBytes } from "@/lib/utils";

/**
 * Step 1 of 2 of a file-store upload: hand the browser a signed PUT.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHY THIS FILE EXISTS. `POST /api/studio/files/presign` was being swallowed by the sibling dynamic
 * segment `files/[id]/route.ts` with `id = "presign"`. That file exports GET, PATCH and DELETE but no
 * POST, so every upload answered **405** — not a 404, which is why nothing caught it, and why no document
 * or dataset could be added to this installation at all. A STATIC segment always beats a dynamic one in
 * Next, so the existence of this file is the whole fix (contract §13b).
 *
 * ⚠ THE SHAPE IS FIXED BY `uploadToStore()` in app/studio/files/FileManager.tsx. It sends
 * `{ fileName, contentType, byteSize }` and reads `{ uploadUrl, headers, objectKey }`. Step 2 is either
 * `POST /api/studio/files` (a new catalogue entry plus version 1) or
 * `POST /api/studio/files/[id]/versions` (a new version of an existing entry).
 *
 * ⚠ THE SIGNED HEADERS ARE RETURNED VERBATIM AND MUST BE REPLAYED VERBATIM. `Content-Type` is part of the
 * signature, so a browser that sends a different one is refused with a signature mismatch — which reads
 * like a credentials problem and sends whoever is debugging it through IAM for an hour.
 *
 * ⚠ THE KEY IS BUILT HERE AND IN THE `files` NAMESPACE, NEVER TAKEN FROM THE CALLER. Both registration
 * routes accept `buildObjectKey({ namespace: "files", … })` and nothing else — the header of
 * app/api/studio/files/route.ts states that as an assumption this file must honour — so that a caller
 * cannot register an arbitrary bucket object, including a media asset or another entry's version, as a
 * download. The key is also random, so the bucket cannot be enumerated, and keeps the original filename
 * on the end so a signed download saves under a name a person recognises.
 *
 * ══ IT IS AN ALLOW-LIST, AND THE SCRIPT-BEARING FORMATS ARE REFUSED BY NAME ══
 *
 * A deny-list is a list of the attacks somebody had already thought of. So the types below are the ones
 * this store exists to hold — papers, office documents, tabular and structured data, archives — and on
 * top of that, three formats are refused OUTRIGHT even when they arrive under another name:
 * **SVG, HTML and XHTML**. Each is a document that can carry `<script>`, and a download of one served
 * from this origin is a stored-XSS primitive: it would run with the studio's cookies. The refusal is by
 * declared type AND by file extension, because the browser reports no type at all for many legitimate
 * dataset formats (see `application/octet-stream` below) and that would otherwise be the way round it.
 *
 * NOTHING IS WRITTEN TO THE DATABASE HERE. A signed URL is a promise, not a fact — the row is created by
 * step 2, and only after `headObject` has confirmed the bytes actually landed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The per-file cap, server-side and authoritative.
 *
 * ⚠ MIRRORS `MAX_UPLOAD_BYTES` in lib/client/upload.ts (which `FileManager` reads) and the copy in
 * app/api/studio/files/route.ts. All three must move together. It is restated rather than imported
 * because that module is `"use client"`: importing it into a route handler replaces its exports with
 * client references and reading a plain constant from it fails at runtime.
 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** How long the signed PUT is good for. Long enough for a large dataset on a domestic uplink. */
const PRESIGN_EXPIRY_SECONDS = 15 * 60;

/**
 * What the file store accepts, grouped by what each group is there for.
 *
 * Deliberately wider than the media library's list: this store holds the material the Centre publishes as
 * downloads, which is mostly office documents and research data rather than pictures.
 */
const ALLOWED_CONTENT_TYPES = new Set<string>([
  // Papers, reports and slides
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  "text/rtf",
  "text/plain",
  "text/markdown",

  // Tabular and structured data
  "text/csv",
  "application/csv",
  "text/tab-separated-values",
  "application/json",
  "application/ld+json",
  "application/geo+json",
  "application/xml",
  "text/xml",
  "application/x-netcdf",
  "application/x-hdf",
  "application/x-sqlite3",
  "application/vnd.sqlite3",

  // Archives — how a corpus, a shapefile set or a photograph bundle actually arrives
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-7z-compressed",

  /**
   * ⚠ "THE BROWSER COULD NOT TELL", AND IT IS IN THE LIST ON PURPOSE.
   *
   * `File.type` is empty for every format without a registered MIME type — Parquet, Stata, SPSS, NetCDF
   * with the wrong extension, BibTeX, shapefiles, most instrument output — and `FileManager` sends
   * `application/octet-stream` for all of them. Refusing it would make the file store unable to accept
   * precisely the research data it exists for, which is why the screen's own file picker accepts every
   * type and leaves the size cap to do the constraining.
   *
   * What keeps it safe is that it is not a bypass for the three refused formats: `REFUSED_EXTENSIONS`
   * below is checked whatever the declared type, and the public download route serves every version with
   * `Content-Disposition: attachment` and the stored type, so a document under this type is saved rather
   * than rendered.
   */
  "application/octet-stream"
]);

/**
 * Types refused outright. See the header — each of these can carry script and be rendered inline.
 *
 * `image/svg+xml` is accepted by the MEDIA library (which files it as a document and never renders it
 * inline) and refused here, which is not an inconsistency: a file-store entry exists to be downloaded by
 * the public from a link the site prints, and that is the one place an inline-rendered document would do
 * the most damage.
 */
const REFUSED_CONTENT_TYPES = new Set<string>([
  "image/svg+xml",
  "image/svg",
  "text/html",
  "application/xhtml+xml",
  "text/xhtml"
]);

/**
 * Extensions refused whatever the declared type.
 *
 * This is the half that closes `application/octet-stream`: a browser reports no type for a file called
 * `report.html` renamed from a template, and a caller crafting the request can declare anything at all.
 */
const REFUSED_EXTENSIONS = new Set<string>([
  "html",
  "htm",
  "xhtml",
  "xht",
  "shtml",
  "svg",
  "svgz",
  "mhtml",
  "mht"
]);

/** One sentence for readers who do not think in MIME types. */
const ACCEPTED_SUMMARY =
  "PDFs, Word, Excel and PowerPoint documents, OpenDocument files, plain text, CSV and TSV data, JSON " +
  "and XML, and ZIP, tar or gzip archives can be added. Research data in a format the browser cannot " +
  "name is accepted as well.";

const PresignBody = z.object({
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
    .positive(
      "This file is empty (0 bytes). If you dragged a folder in, open it and choose the files inside."
    )
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  // The capability check is the boundary, not the file screen's own guard. A client guard that only
  // hides a control is not a guard (contract §1.7).
  await requireCapability(
    canManageMedia,
    "Adding to the file store needs media manager access or higher. An administrator can raise yours."
  );

  // A 503 rather than a 500: unconfigured storage is a deployment state, not a bug, and the message
  // names the variables that are missing.
  requireStorage();

  const body = await parseJson(request, PresignBody);
  const contentType = body.contentType.toLowerCase();
  const extension = extensionOf(body.fileName);

  if (body.byteSize > MAX_UPLOAD_BYTES) {
    // BOTH numbers, always. "Too large" leaves the reader guessing whether trimming a little would help;
    // here the answer is no.
    throw new ApiError(
      413,
      `This file is ${formatBytes(body.byteSize)} and the limit is ${formatBytes(MAX_UPLOAD_BYTES)}. ` +
        "Split it or compress it, or ask an administrator to raise the limit.",
      { code: "too_large" }
    );
  }

  if (REFUSED_CONTENT_TYPES.has(contentType) || REFUSED_EXTENSIONS.has(extension)) {
    // The reason is stated rather than hidden behind "not accepted": an editor with a perfectly innocent
    // diagram exported as an SVG needs to know what to do instead, and the alternative is a real one.
    throw badRequest(
      "Web pages and SVG drawings cannot be added to the file store, because a browser can be made to " +
        "run code inside one when somebody downloads it from this site. Save it as a PDF, or add the " +
        "picture to the media library instead."
    );
  }

  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw badRequest(`Files of type ${contentType} are not accepted. ${ACCEPTED_SUMMARY}`);
  }

  // The `files` namespace, and never the caller's key. See the header.
  const objectKey = buildObjectKey({ namespace: "files", fileName: body.fileName });

  const signed = await presignUpload({
    key: objectKey,
    // The type we SIGN is the type the browser must send, and it is also the only type step 2 will store
    // for this key — which is what stops a signed PUT for a dataset being used to store a web page.
    contentType,
    expiresInSeconds: PRESIGN_EXPIRY_SECONDS
  });

  return ok({
    uploadUrl: signed.url,
    // Returned verbatim so no caller has to know which headers were signed.
    headers: signed.headers,
    objectKey,
    expiresInSeconds: signed.expiresInSeconds
  });
});
