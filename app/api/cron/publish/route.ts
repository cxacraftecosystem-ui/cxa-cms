import { prisma } from "@/lib/db";
import { ok, route } from "@/lib/api";
import { assertCronAuthorised, runCronJob } from "@/lib/cron";
import { recordEvent } from "@/lib/audit";
import { resyncPublishedFlags } from "@/lib/search/index";

/**
 * Scheduled publishing and automatic retirement.
 *
 * THIS JOB IS A CONVENIENCE, NOT THE MECHANISM. `livePublishableWhere()` in lib/content.ts already
 * compares `publishAt` / `unpublishAt` against `now` on every read, so:
 *
 *   • a scheduled article goes live at its minute even if this has not run since yesterday, and
 *   • a stalled cron cannot leave an expired embargo readable.
 *
 * What the job actually buys is honesty in the STUDIO: without it, the status column would read
 * "Scheduled" for a piece that has been public for a week, and the audit log would have no record of
 * the moment it changed. Both of those matter to the person who has to answer "when did this go up?"
 *
 * Suggested schedule: every 10 minutes. Running it more often costs two indexed updates.
 */
export const dynamic = "force-dynamic";

export const GET = route(async (request: Request) => {
  assertCronAuthorised(request);

  const result = await runCronJob("publish", async (notes) => {
    const now = new Date();
    const failed: { id: string; reason: string }[] = [];
    let processed = 0;

    // ── SCHEDULED → PUBLISHED ────────────────────────────────────────────────
    // `publishedAt` is set to the SCHEDULED time, not to `now`. The article's own claim about when it
    // was published must not drift by however late the job happened to run.
    const duePages = await prisma.page.findMany({
      where: { status: "SCHEDULED", deletedAt: null, publishAt: { lte: now } },
      select: { id: true, slug: true, title: true, publishAt: true }
    });

    for (const page of duePages) {
      try {
        await prisma.page.update({
          where: { id: page.id },
          data: { status: "PUBLISHED", publishedAt: page.publishAt ?? now }
        });
        await recordEvent(
          { actor: null },
          {
            action: "PUBLISH",
            entityType: "Page",
            entityId: page.id,
            entityLabel: page.title,
            after: { status: "PUBLISHED", by: "scheduler" }
          }
        );
        processed += 1;
      } catch (error) {
        failed.push({ id: page.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    const duePosts = await prisma.post.findMany({
      where: { status: "SCHEDULED", deletedAt: null, publishAt: { lte: now } },
      select: { id: true, slug: true, title: true, publishAt: true }
    });

    for (const post of duePosts) {
      try {
        await prisma.post.update({
          where: { id: post.id },
          data: { status: "PUBLISHED", publishedAt: post.publishAt ?? now }
        });
        await recordEvent(
          { actor: null },
          {
            action: "PUBLISH",
            entityType: "Post",
            entityId: post.id,
            entityLabel: post.title,
            after: { status: "PUBLISHED", by: "scheduler" }
          }
        );
        processed += 1;
      } catch (error) {
        failed.push({ id: post.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    // ── PUBLISHED → ARCHIVED, at `unpublishAt` ───────────────────────────────
    // ARCHIVED rather than DRAFT: the piece WAS published and its history should say so. Sending it
    // back to draft would make the revision log read as though it had never gone out.
    const expiredPages = await prisma.page.updateMany({
      where: { status: "PUBLISHED", deletedAt: null, unpublishAt: { lte: now } },
      data: { status: "ARCHIVED" }
    });
    const expiredPosts = await prisma.post.updateMany({
      where: { status: "PUBLISHED", deletedAt: null, unpublishAt: { lte: now } },
      data: { status: "ARCHIVED" }
    });

    processed += expiredPages.count + expiredPosts.count;

    if (expiredPages.count + expiredPosts.count > 0) {
      notes.push(
        `Retired ${expiredPages.count} page(s) and ${expiredPosts.count} article(s) that reached their unpublish date.`
      );
    }

    // ── Events that have finished ────────────────────────────────────────────
    // Events are NOT archived when they end. A past event is a record of what the Centre did, and the
    // /events page shows past events deliberately. This note exists so nobody adds that "missing"
    // behaviour later thinking it was an oversight.
    const finished = await prisma.coeEvent.count({
      where: { status: "PUBLISHED", deletedAt: null, endsAt: { lt: now } }
    });
    if (finished > 0) {
      notes.push(
        `${finished} event(s) have finished. They stay published on purpose — a past event is part of the record.`
      );
    }

    /**
     * Bring the search index's `isPublished` flag back in step.
     *
     * NOT an afterthought, and not covered by the transitions above. `isPublished` is computed at WRITE
     * time, but publication state is resolved at READ time from `publishAt`/`unpublishAt` — so it can go
     * stale with nothing more than the clock advancing:
     *
     *   • a page past its `unpublishAt` 404s at its own URL while its title keeps coming back from
     *     /search and /api/public/suggest — a withdrawn page still findable by name;
     *   • a scheduled article goes live at its minute but stays missing from the site's own search
     *     until somebody re-saves it.
     *
     * `resyncPublishedFlags` recomputes from the source rows rather than from what this pass happened to
     * transition, so a deployment whose cron has been down converges on its first run afterwards.
     */
    const resync = await resyncPublishedFlags(now);
    if (resync.corrected > 0) {
      notes.push(
        `Corrected the search index's published flag on ${resync.corrected} of ${resync.checked} indexed page(s) and article(s).`
      );
    }

    return { processed, skipped: 0, failed };
  });

  return ok(result);
});
