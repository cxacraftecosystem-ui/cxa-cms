import { prisma } from "@/lib/db";
import { ok, route } from "@/lib/api";
import { assertCronAuthorised, runCronJob } from "@/lib/cron";
import { mediaPurgeAfterDays } from "@/lib/env";
import { deleteObjects, storageAvailable } from "@/lib/storage/client";
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
      const keys = [asset.objectKey, ...asset.variants.map((variant) => variant.objectKey)];
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
      select: { id: true, title: true, versions: { select: { objectKey: true } } },
      take: MAX_ASSETS_PER_RUN,
      orderBy: { deletedAt: "asc" }
    });

    for (const file of expiredFiles) {
      const keys = file.versions.map((version) => version.objectKey);
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
