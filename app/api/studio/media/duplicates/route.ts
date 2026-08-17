import type { NextRequest } from "next/server";
import { z } from "zod";
// `Prisma` is imported as a VALUE: `Prisma.sql` / `Prisma.join` are the tagged-template helpers, and
// they are the only way a checksum reaches this file's SQL. Nothing here concatenates a query string.
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertSameOrigin, ok, parseJson, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { mediaSrc, VARIANT_WIDTHS } from "@/lib/media/url";

/**
 * Byte-identical files in the media library — "you already have this one".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ WHY THIS FILE EXISTS. `/api/studio/media/duplicates` was being swallowed by the sibling dynamic
 * segment `media/[id]/route.ts` with `id = "duplicates"`. That file exports GET, PATCH and DELETE but no
 * POST, so the duplicate check answered **405** rather than an honest 404 — which is why nothing caught
 * it. A STATIC segment always beats a dynamic one in Next, so the existence of this file is the fix
 * (contract §13b).
 *
 * TWO METHODS, TWO DIFFERENT QUESTIONS:
 *
 *   • **POST `{ ids }`** — "is anything in the batch I have just uploaded already here?" This is the one
 *     the product calls: `UploadQueue` sends the ids it has just registered and renders
 *     `MediaDuplicateResponse` — `{ matches: [{ uploadedId, uploadedFileName, existing }] }` — with a
 *     "Use the existing one" button beside each. `existing` is a FULL `StudioMediaAsset` including its
 *     variants, because the queue renders a thumbnail of it through `<MediaImage>`.
 *   • **GET** — "where in the library are there duplicates at all?" The same information for the whole
 *     library, grouped, for a housekeeping pass rather than for one upload.
 *
 * MATCHING IS ON THE CHECKSUM, NEVER THE FILENAME. "IMG_0421.jpg" collides constantly and identical
 * bytes almost never do (prisma/schema.prisma, `MediaAsset.checksum`).
 *
 * ⚠ A NULL CHECKSUM IS NOT A VALUE, AND TWO OF THEM ARE NOT A MATCH. `media/complete` skips the checksum
 * for an object above its in-memory limit, so a library can hold several very large files with none.
 * Grouping those together would tell an administrator that two unrelated 150 MB films are the same file,
 * and the "Use the existing one" button would then delete one of them.
 *
 * NOTHING HERE MERGES OR DELETES ANYTHING. It reports, and the administrator decides — the discard is a
 * separate soft delete through `DELETE /api/studio/media/[id]`, which is reversible.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The biggest batch one POST may ask about.
 *
 * Each distinct checksum in the batch costs a row in the ranking query below, so the work is bounded by
 * this rather than by how many files somebody dropped at once. A larger batch is refused with a sentence
 * instead of being silently trimmed, because a trimmed answer would report "no duplicates" for the files
 * that fell off the end.
 */
const MAX_IDS = 200;

/** How many duplicate GROUPS the GET lists. Past this the screen is a wall of near-identical rows. */
const GROUP_LIMIT = 50;

/** How many copies are named per group. Enough to choose between them; the true count is reported too. */
const COPIES_PER_GROUP = 8;

/** The variant columns `MediaLike` needs, so `<MediaImage>` and `mediaSrc` can pick a thumbnail. */
const VARIANT_SELECT = {
  select: { label: true, format: true, objectKey: true, width: true },
  orderBy: { width: "asc" as const }
};

/**
 * Just enough of an asset to choose between two copies of it: the shared renderable image columns
 * (crop included, so the thumbnail here matches the site) plus the four the chooser reads to tell them
 * apart — kind, name, size and age.
 */
const COPY_SELECT = {
  ...MEDIA_IMAGE_SELECT_WITH_ID,
  kind: true,
  fileName: true,
  byteSize: true,
  createdAt: true
} satisfies Prisma.MediaAssetSelect;

type CopyRow = Prisma.MediaAssetGetPayload<{ select: typeof COPY_SELECT }>;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST — "is anything in this batch already here?"
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MatchBody = z.object({
  ids: z
    .array(z.string().trim().min(1).max(64))
    .min(1, "No files were named, so there was nothing to check.")
    .max(
      MAX_IDS,
      `That is more than ${MAX_IDS} files in one check. Upload them in smaller batches so the duplicate ` +
        "check can cover all of them."
    )
});

type FullAsset = Prisma.MediaAssetGetPayload<{ include: { variants: typeof VARIANT_SELECT } }>;

interface DuplicateMatch {
  uploadedId: string;
  uploadedFileName: string;
  existing: FullAsset;
}

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  await requireCapability(
    canManageMedia,
    "The media library needs media manager access or higher. An administrator can raise yours."
  );

  const body = await parseJson(request, MatchBody);

  // The recycle bin is excluded: a file somebody has already thrown away is not a copy worth keeping.
  const uploaded = await prisma.mediaAsset.findMany({
    where: { id: { in: body.ids }, deletedAt: null },
    select: { id: true, fileName: true, checksum: true }
  });

  const checksums = [
    ...new Set(
      uploaded
        .map((asset) => asset.checksum)
        .filter((checksum): checksum is string => checksum !== null && checksum.length > 0)
    )
  ];

  if (checksums.length === 0) return ok({ matches: [] });

  /**
   * The EARLIEST live asset for each of those checksums, in one query.
   *
   * ⚠ THE ORDERING DECIDES WHICH COPY IS "THE EXISTING ONE", and it has to be the oldest: that is the row
   * whose description, credit and copyright somebody has already written, which is the whole value of the
   * queue's "Use the existing one" offer. `id` breaks a tie so the choice is deterministic — two copies
   * registered in the same millisecond must not swap places between two requests.
   *
   * A window function rather than a query per checksum, because the alternative is one round trip for
   * every distinct checksum in the batch — up to two hundred of them for one drop.
   */
  const earliestIds = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT ranked.id
      FROM (
        SELECT id,
               (row_number() OVER (
                 PARTITION BY checksum
                 ORDER BY "createdAt" ASC, id ASC
               ))::int AS rn
          FROM "media_assets"
         WHERE "deletedAt" IS NULL
           AND checksum IN (${Prisma.join(checksums)})
      ) AS ranked
     WHERE ranked.rn = 1
  `);

  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: earliestIds.map((row) => row.id) } },
    include: { variants: VARIANT_SELECT }
  });

  const earliestByChecksum = new Map<string, FullAsset>();
  for (const row of rows) {
    if (row.checksum) earliestByChecksum.set(row.checksum, row);
  }

  const matches: DuplicateMatch[] = [];
  for (const asset of uploaded) {
    if (!asset.checksum) continue;
    const existing = earliestByChecksum.get(asset.checksum);
    if (!existing) continue;
    /**
     * An asset is never reported as a duplicate of ITSELF, and that one test is also what makes a batch
     * containing two copies of the same file behave sensibly: the older of the pair IS the earliest, so
     * it is left alone and only the later one is offered for discard. Excluding the whole batch instead
     * would report neither, and somebody who dropped the same photograph in twice would never be told.
     */
    if (existing.id === asset.id) continue;
    matches.push({
      uploadedId: asset.id,
      uploadedFileName: asset.fileName,
      existing
    });
  }

  return ok({ matches });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET — every duplicate group in the library
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface RankedCopyRow {
  id: string;
  checksum: string;
  /** How many live copies share this checksum ALTOGETHER, not how many are listed. */
  copies: number;
}

interface DuplicateGroup {
  checksum: string;
  copies: number;
  assets: CopyRow[];
}

export const GET = route(async () => {
  // A read, so no same-origin assertion — but it names files that are not public, so it is still gated.
  await requireCapability(
    canManageMedia,
    "The media library needs media manager access or higher. An administrator can raise yours."
  );

  /**
   * The copies worth listing, in one pass.
   *
   * `count(*) OVER (PARTITION BY checksum)` gives every row the size of its own group, so `copies > 1`
   * selects only the checksums that really do have duplicates, and the true count travels out with the
   * rows — no second aggregate, and nothing has to be inferred from how many rows came back.
   *
   * ⚠ THE `LIMIT` IS EXACT RATHER THAN APPROXIMATE, and the ordering is what makes it so. Rows arrive
   * GROUP-MAJOR (largest group first, then by checksum), so the first `GROUP_LIMIT` groups need at most
   * `GROUP_LIMIT × COPIES_PER_GROUP` rows between them — which is the limit. Every group this endpoint
   * reports is therefore complete up to `COPIES_PER_GROUP`; the only thing the limit can cut off is a
   * group beyond the group cap, and that is precisely what `truncated` says.
   *
   * `row_number()` and `count(*)` both return `bigint`, so BOTH are cast. An un-cast one would reach
   * Prisma as a `BigInt`, which `JSON.stringify` throws on — the endpoint would answer 500 with a message
   * about serialisation. The cast is parenthesised because `::` after a window function's `OVER` clause
   * is not the place to find out how a parser groups it.
   */
  const ranked = await prisma.$queryRaw<RankedCopyRow[]>(Prisma.sql`
    SELECT ranked.id, ranked.checksum, ranked.copies
      FROM (
        SELECT id,
               checksum,
               (row_number() OVER (
                 PARTITION BY checksum
                 ORDER BY "createdAt" DESC, id ASC
               ))::int AS rn,
               (count(*) OVER (PARTITION BY checksum))::int AS copies
          FROM "media_assets"
         WHERE "deletedAt" IS NULL
           AND checksum IS NOT NULL
      ) AS ranked
     WHERE ranked.copies > 1
       AND ranked.rn <= ${COPIES_PER_GROUP}
     ORDER BY ranked.copies DESC, ranked.checksum ASC, ranked.rn ASC
     LIMIT ${GROUP_LIMIT * COPIES_PER_GROUP}
  `);

  const totals = await prisma.$queryRaw<{ groups: number }[]>(Prisma.sql`
    SELECT count(*)::int AS "groups"
      FROM (
        SELECT checksum
          FROM "media_assets"
         WHERE "deletedAt" IS NULL
           AND checksum IS NOT NULL
         GROUP BY checksum
        HAVING count(*) > 1
      ) AS duplicated
  `);
  const groupCount = totals[0]?.groups ?? 0;

  if (ranked.length === 0) {
    return ok({ groups: [], groupCount, truncated: false });
  }

  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: ranked.map((row) => row.id) } },
    select: COPY_SELECT
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  // Assembled in the order the ranking query produced, so the largest group leads and the copies inside
  // each one stay newest-first. A `Map` preserves insertion order, which is what carries that through.
  const grouped = new Map<string, DuplicateGroup>();
  for (const entry of ranked) {
    let group = grouped.get(entry.checksum);
    if (!group) {
      if (grouped.size >= GROUP_LIMIT) continue;
      group = { checksum: entry.checksum, copies: entry.copies, assets: [] };
      grouped.set(entry.checksum, group);
    }
    const row = byId.get(entry.id);
    // A row that vanished between the two queries is a concurrent delete rather than an error: it is no
    // longer a duplicate of anything, so it is simply left out.
    if (row) group.assets.push(row);
  }

  return ok({
    groups: [...grouped.values()].map((group) => ({
      checksum: group.checksum,
      /** Every live copy sharing these bytes. */
      copies: group.copies,
      /** How many of them are described below. Fewer than `copies` when the per-group cap bit. */
      listed: group.assets.length,
      assets: group.assets.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        fileName: asset.fileName,
        byteSize: asset.byteSize,
        createdAt: asset.createdAt,
        /**
         * A ready-made thumbnail address, or null when no public base is configured. Null rather than a
         * plausible-looking relative path (lib/media/url.ts): the raw `objectKey` and `variants` travel
         * alongside, so a caller with its own signing route can still render something.
         */
        thumbnailUrl: mediaSrc(asset, VARIANT_WIDTHS.thumb),
        objectKey: asset.objectKey,
        variants: asset.variants
      }))
    })),
    /** Duplicate groups in the whole library, whether or not they are listed above. */
    groupCount,
    /** True when there are more groups than this answer carries. The screen must print it (contract §1.6). */
    truncated: groupCount > grouped.size
  });
});
