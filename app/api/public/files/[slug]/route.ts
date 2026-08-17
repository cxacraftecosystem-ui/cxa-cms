import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ApiError, notFound, route } from "@/lib/api";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/ratelimit";
import { headObject, presignDownload, requireStorage, storageAvailable } from "@/lib/storage/client";
import { isSafeObjectKey } from "@/lib/storage/keys";

/**
 * The counted download.
 *
 * **THE ACCESS CONTROL IS HERE.** `isPublic` and `expiresAt` are enforced in this handler, not by
 * hiding a button: a hidden button is not an access control, and this URL is guessable from a slug that
 * appears in the search index. Everything below follows from that.
 *
 *   • **Not public → 404, never 403.** A 403 confirms that a file with that slug exists, which for
 *     embargoed material is the fact being protected.
 *   • **Expired → 410 Gone, with the date.** Different from a 404 on purpose: the reader had a working
 *     link and deserves to know it lapsed rather than to wonder whether they mistyped it. The file's
 *     existence was already public, so naming the expiry leaks nothing.
 *   • **A missing storage object → 404 with a sentence.** Never a redirect to a signed URL that will
 *     answer 403 or an XML error document — a reader cannot tell those from a broken site, and the
 *     operator gets no signal at all.
 *
 * ⚠ **THE REDIRECT MUST STAY TEMPORARY.** It points at a signed URL that expires in two minutes. A 301
 * would be cached by the browser and by every proxy in between, and every later visit to this endpoint
 * would go straight to a dead signature — a download that works once and then fails forever, with
 * nothing in the logs because the request never arrives.
 *
 * **A SIBLING AT `/inline`, AND THE DIFFERENCE IS THE DISPOSITION.**
 * `app/api/public/files/[slug]/inline/route.ts` serves the same object to be LOOKED AT — signed without
 * `Content-Disposition`, so a browser draws it instead of saving it, and restricted to a PDF for exactly
 * that reason. It deliberately does not count a download. The attachment disposition below stays as it
 * is: the file store accepts `application/octet-stream` for research data precisely because everything
 * THIS route serves is saved rather than rendered, and weakening it would make every dataset in the
 * library renderable in place.
 *
 * ⚠ **A NOTE THAT USED TO BE A WARNING, KEPT BECAUSE THE TRAP IS STILL THERE.** `searchUrlFor("file",
 * slug)` once built `/api/public/files/{slug}/download`, which matched no route, so every file result on
 * /search was a hard 404 while the card printed the path as though it worked. lib/search/index.ts now
 * builds `/api/public/files/{slug}` and says so at that line — but the wrong string may still be
 * PERSISTED in `SearchDocument.url` from before the fix, so a deployment that has not run `reindexAll()`
 * since then still 404s. Adding a segment here (as `/inline` does) does not resurrect `/download`.
 */

export const dynamic = "force-dynamic";

/**
 * How long the signed URL lives.
 *
 * Two minutes is enough to START the transfer, which is all that matters: S3 checks the signature when
 * the request arrives, not while the bytes flow, so a 900 MB dataset on a slow line is unaffected. A
 * longer window would leave a shareable link to embargoed material sitting in a browser history and in
 * any referrer log along the way.
 */
const SIGNED_URL_SECONDS = 120;

/** UTC midnight for the day bucket, matching `PageViewDaily` and `SearchQueryLog`. */
function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

/** Two letters or nothing — `country` is part of a unique key, so an arbitrary header value is a row leak. */
function readCountry(request: Request): string | null {
  const raw =
    request.headers.get("x-vercel-ip-country") ??
    request.headers.get("cf-ipcountry") ??
    request.headers.get("x-country-code");
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (code === "XX" || code === "T1") return null;
  return code;
}

/**
 * Record the download: the running total on the file, and the day bucket.
 *
 * NEVER THROWS. The reader asked for a file, not for a statistic; a failed counter that refused the
 * download would trade the thing somebody wanted for a number nobody has looked at yet.
 *
 * `updateMany`-then-`create` for the same reason as the view beacon: Postgres treats NULLs as distinct
 * in a unique index, so an upsert's ON CONFLICT can never match the (…, NULL) rows an unknown country
 * produces, while `updateMany` generates `country IS NULL` and does.
 */
async function recordDownload(fileId: string, country: string | null): Promise<void> {
  const day = utcDay(new Date());
  try {
    await prisma.fileAsset.update({
      where: { id: fileId },
      data: { downloadCount: { increment: 1 } }
    });

    const updated = await prisma.downloadEvent.updateMany({
      where: { entityType: "file", entityId: fileId, day, country },
      data: { count: { increment: 1 } }
    });
    if (updated.count > 0) return;

    try {
      await prisma.downloadEvent.create({
        data: { entityType: "file", entityId: fileId, day, country, count: 1 }
      });
    } catch {
      await prisma.downloadEvent.updateMany({
        where: { entityType: "file", entityId: fileId, day, country },
        data: { count: { increment: 1 } }
      });
    }
  } catch (error) {
    console.error("[files] could not record a download for", fileId, error);
  }
}

export const GET = route(async (request: NextRequest, context: { params: Promise<{ slug: string }> }) => {
  const limited = enforceRateLimit(
    request,
    "file-download",
    RATE_LIMITS.download,
    (phrase) =>
      `That is a lot of downloads from one connection in a short time, so this is paused for ${phrase}. ` +
      "Nothing has gone wrong with the files themselves."
  );
  if (limited) return limited;

  const { slug } = await context.params;

  // `FileAsset` has no `ContentStatus` column, so neither `livePublishableWhere()` nor
  // `liveStatusWhere()` applies — referencing `status` here would be a Prisma runtime error. The
  // equivalent predicate is spelled out: not deleted, public, not lapsed. lib/search/index.ts's
  // `searchDocFromFile` states the same rule for the index, and the two must stay in step.
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
        select: { id: true, version: true, objectKey: true, fileName: true, mimeType: true }
      }
    }
  });

  // Missing and not-public are ONE answer. See the header.
  if (!file || !file.isPublic) throw notFound("That file");

  if (file.expiresAt && file.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(
      410,
      `“${file.title}” was available until ${formatDay(file.expiresAt)} and the link has now expired. ` +
        "Write to the Centre if you still need it — the file itself has not been deleted.",
      { code: "expired" }
    );
  }

  // A record with no version is a real state: the row was created and the upload never finished. Saying
  // so is more useful than a generic 404, because it tells an editor exactly what to fix.
  const version = file.versions[0];
  if (!version) {
    throw new ApiError(
      404,
      `“${file.title}” has a catalogue entry but no file has been uploaded against it yet, so there is ` +
        "nothing to download. Please report this to the Centre.",
      { code: "no_version" }
    );
  }

  // A deployment with no object storage cannot serve a download. 503 with the reason, which is what
  // `requireStorage()` throws — a deployment state, not a bug.
  if (!storageAvailable()) requireStorage();

  if (!isSafeObjectKey(version.objectKey)) {
    // Belt and braces: keys are built by `buildObjectKey`. One that fails the check came from an older
    // version of the schema or from a restore, and it must not be concatenated into a storage request.
    console.error("[files] unusable object key on file", file.id, "version", version.version);
    throw new ApiError(
      500,
      `“${file.title}” points at a storage location this application cannot read. An administrator ` +
        "needs to upload the file again.",
      { code: "bad_object_key" }
    );
  }

  // CONFIRM THE BYTES EXIST before promising them. The alternative is a redirect to a signed URL for a
  // key that was purged, which the reader experiences as an XML error page from a storage vendor.
  let head;
  try {
    head = await headObject(version.objectKey);
  } catch (error) {
    console.error("[files] storage HEAD failed for", version.objectKey, error);
    throw new ApiError(
      503,
      "The file store could not be reached, so this download cannot start. Try again in a moment — " +
        "nothing is wrong with your link.",
      { code: "storage_unreachable" }
    );
  }

  if (!head) {
    throw new ApiError(
      404,
      `“${file.title}” is listed in the catalogue but its file is no longer in storage, so there is ` +
        "nothing to download. Please report this to the Centre — the record is there, the bytes are not.",
      { code: "object_missing" }
    );
  }

  // Counted before the redirect, because at this point we know the file exists and the reader is being
  // sent to it. Counting after would mean counting nothing, since the transfer never returns here.
  await recordDownload(file.id, readCountry(request));

  const signedUrl = await presignDownload({
    key: version.objectKey,
    expiresInSeconds: SIGNED_URL_SECONDS,
    // The ORIGINAL filename, so the download saves as "bagru-corpus-v2.zip" rather than as the random
    // object key. `presignDownload` strips the characters that would truncate the header.
    downloadFileName: version.fileName,
    contentType: version.mimeType
  });

  // 302, not 301 — see the warning in the header.
  const response = NextResponse.redirect(signedUrl, 302);
  // No proxy, no browser and no CDN may keep this: the target expires in two minutes and the next
  // request has to be counted again.
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
});
