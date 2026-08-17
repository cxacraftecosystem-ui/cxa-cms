import { prisma } from "@/lib/db";
import { ok, route } from "@/lib/api";
import { assertCronAuthorised, runCronJob } from "@/lib/cron";
import { mediaPurgeAfterDays } from "@/lib/env";
import { deleteObjects, listObjectKeys, storageAvailable } from "@/lib/storage/client";
import { variantPrefix } from "@/lib/storage/keys";
import { recordEvent } from "@/lib/audit";
import { pruneExpiredSessions } from "@/lib/auth/session";

/**
 * The recycle-bin purge, and session housekeeping.
 *
 * THE ORDER OF THE TWO DELETIONS IS THE WHOLE DESIGN. Bytes go first, the row second:
 *
 *   • bytes deleted, row deleted     → correct.
 *   • bytes deleted, row NOT deleted → an orphan ROW pointing at nothing. Visible, reported by the
 *     next run, and fixable. Recoverable.
 *   • row deleted, bytes NOT deleted → an orphan OBJECT nothing references. Invisible, unbilled to
 *     any feature, and it accumulates forever. Nobody ever finds it.
 *
 * So a failure to delete the bytes ABORTS that asset's row deletion. The row survives, still in the
 * recycle bin, and the next run tries again.
 *
 * NOTHING IS PURGED THAT IS NOT PAST ITS WINDOW. `MEDIA_PURGE_AFTER_DAYS` (30 by default) is the
 * grace period, and the recycle bin is only a real safety net if the object it points at still
 * exists — a window shorter than a working fortnight turns "restore the photograph we deleted before
 * the holidays" into a permanent loss.
 *
 * Suggested schedule: once a day, off-peak.
 */
export const dynamic = "force-dynamic";

/** Bounded per run: a purge that tries to delete ten thousand objects in one request times out. */
const MAX_ASSETS_PER_RUN = 500;

export const GET = route(async (request: Request) => {
  assertCronAuthorised(request);

  const result = await runCronJob("purge", async (notes) => {
    const cutoff = new Date(Date.now() - mediaPurgeAfterDays() * 24 * 60 * 60 * 1000);
    const failed: { id: string; reason: string }[] = [];
    let processed = 0;
    let skipped = 0;

    const prunedSessions = await pruneExpiredSessions();
    if (prunedSessions > 0) {
      notes.push(`Removed ${prunedSessions} expired or long-revoked session row(s).`);
    }

    if (!storageAvailable()) {
      // Not an error. A deployment without storage has no bytes to purge, and refusing to run the
      // session prune above because of it would be the wrong trade.
      notes.push("Object storage is not configured, so no media bytes were purged.");
      return { processed, skipped, failed };
    }

    const expired = await prisma.mediaAsset.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, objectKey: true, fileName: true, variants: { select: { objectKey: true } } },
      take: MAX_ASSETS_PER_RUN,
      orderBy: { deletedAt: "asc" }
    });

    const totalExpired = await prisma.mediaAsset.count({ where: { deletedAt: { lt: cutoff } } });
    if (totalExpired > expired.length) {
      // Say what was left behind. A capped job that reports only its successes looks identical to a
      // job that finished the queue.
      notes.push(
        `${totalExpired - expired.length} more asset(s) are past the purge window and will be handled ` +
          "on the next run — this run is capped at " +
          `${MAX_ASSETS_PER_RUN}.`
      );
    }

    for (const asset of expired) {
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * ⚠ THE ROWS ARE NOT A COMPLETE RECORD OF THE BYTES, AND THIS LOOP USED TO BELIEVE THEY WERE.
       *
       * It deleted `objectKey` plus the keys named by the variant ROWS, and nothing else. But
       * lib/storage/derivatives.ts says a derivative run can PARTLY fail, with the caller writing
       * down only what landed — so a derivative can exist in the bucket with no row naming it.
       * Every one of those survived this purge, at a publicly readable URL, with the asset row that
       * could have found it now deleted. Unenumerable, unreachable by any later cleanup, and billed
       * for ever. That has been true of every run this cron has ever made.
       *
       * The prefix is now swept as well and the two sets unioned. `deleteObjects` treats an
       * already-absent key as a success, so a key in both lists costs nothing.
       *
       * ⚠ A FAILED SWEEP IS A FAILED PURGE, NOT AN EMPTY ONE. If storage cannot be listed the set is
       * unknown, and deleting what we happen to know about before dropping the row produces exactly
       * the orphans this exists to prevent. `listObjectKeys` throws; the asset is skipped WITH ITS
       * ROW INTACT and the next run retries it — the same ordering the rest of this file follows.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      let keys: string[];
      try {
        const known = [asset.objectKey, ...asset.variants.map((variant) => variant.objectKey)];
        const swept = await listObjectKeys(variantPrefix(asset.objectKey));
        keys = [...new Set([...known, ...swept])];
      } catch (error) {
        failed.push({
          id: asset.id,
          reason: `Storage could not be listed for this asset, so its derivatives are unknown and the record was kept: ${
            error instanceof Error ? error.message : "unknown error"
          }`
        });
        skipped += 1;
        continue;
      }

      const outcome = await deleteObjects(keys);

      if (outcome.failed.length > 0) {
        // The row STAYS. See the ordering note at the top of this file.
        failed.push({
          id: asset.id,
          reason: `${outcome.failed.length} object(s) could not be deleted from storage; the record was kept so the next run can retry.`
        });
        skipped += 1;
        continue;
      }

      try {
        // The variant rows cascade from the asset row, so this one delete removes both.
        await prisma.mediaAsset.delete({ where: { id: asset.id } });
        await recordEvent(
          { actor: null },
          {
            action: "PURGE",
            entityType: "MediaAsset",
            entityId: asset.id,
            entityLabel: asset.fileName,
            before: { objectKey: asset.objectKey, variants: keys.length - 1 }
          }
        );
        processed += 1;
      } catch (error) {
        // The bytes are already gone and the row could not be removed. This is the RECOVERABLE
        // direction, but it must be reported loudly — the asset now renders as a broken image.
        failed.push({
          id: asset.id,
          reason:
            "Storage objects were deleted but the database row could not be removed. " +
            `The record is now an orphan and must be deleted by hand: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    // Files use the same window and the same ordering rule.
    const expiredFiles = await prisma.fileAsset.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: {
        id: true,
        title: true,
        // ⚠ `previewObjectKey` AS WELL, OR THE PDF RENDITION IS ORPHANED FOR EVER. A converted preview is
        // a second object belonging to a version (app/api/studio/files/[id]/preview/route.ts), and the
        // version rows are the only record of either — so a purge that collected the original alone would
        // drop the row and leave the preview in the bucket with nothing anywhere pointing at it, which is
        // precisely the orphan this whole route exists to prevent.
        versions: { select: { objectKey: true, previewObjectKey: true } }
      },
      take: MAX_ASSETS_PER_RUN,
      orderBy: { deletedAt: "asc" }
    });

    for (const file of expiredFiles) {
      const keys = file.versions.flatMap((version) =>
        version.previewObjectKey ? [version.objectKey, version.previewObjectKey] : [version.objectKey]
      );
      const outcome = keys.length > 0 ? await deleteObjects(keys) : { deleted: 0, failed: [] };

      if (outcome.failed.length > 0) {
        failed.push({
          id: file.id,
          reason: `${outcome.failed.length} stored version(s) could not be deleted; the record was kept for the next run.`
        });
        skipped += 1;
        continue;
      }

      try {
        await prisma.fileAsset.delete({ where: { id: file.id } });
        await recordEvent(
          { actor: null },
          {
            action: "PURGE",
            entityType: "FileAsset",
            entityId: file.id,
            entityLabel: file.title,
            before: { versions: keys.length }
          }
        );
        processed += 1;
      } catch (error) {
        failed.push({
          id: file.id,
          reason: `Stored versions were deleted but the record could not be: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    if (processed === 0 && skipped === 0) {
      notes.push(`Nothing was past the ${mediaPurgeAfterDays()}-day recycle-bin window.`);
    }

    return { processed, skipped, failed };
  });

  return ok(result);
});
