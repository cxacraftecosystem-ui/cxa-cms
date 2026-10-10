import { ok, route } from "@/lib/api";
import { assertNewsletterDrainAuthorised, runCronJob } from "@/lib/cron";
import { drainOutbox } from "@/lib/newsletter/drain";

/**
 * The newsletter drain: send one bounded batch of the outbox.
 *
 * Called by `.github/workflows/newsletter-drain.yml` every five minutes (best-effort — GitHub delays
 * scheduled runs, sometimes by hours) with `Authorization: Bearer $NEWSLETTER_DRAIN_SECRET`, and by
 * Vercel's daily cron in `vercel.json` with `CRON_SECRET`, as a fallback. An editor pressing Send also
 * starts a batch straight away, so a mailing does not wait for the schedule to begin.
 *
 * Safe to call as often as anybody likes, and concurrently: rows are claimed atomically, stale claims are
 * released, and attempts are capped (lib/newsletter/outbox-store.ts). The function's time limit is set in
 * vercel.json; the drain stops starting sends well inside it.
 *
 * GET and POST both work: Vercel's cron sends GET, and the workflow sends POST so that no cache between
 * it and the function can ever answer for it.
 */
export const dynamic = "force-dynamic";

async function handle(request: Request) {
  assertNewsletterDrainAuthorised(request);

  const result = await runCronJob("newsletter-drain", async (notes) => {
    const drained = await drainOutbox();
    if (!drained.configured) notes.push("Email sending is not set up; messages stay queued.");
    if (drained.halted) notes.push(drained.halted);
    notes.push(
      `claimed ${drained.claimed}, sent ${drained.sent}, requeued ${drained.requeued}, failed ${drained.failed}, ` +
        `suppressed ${drained.suppressed}, unattempted ${drained.unattempted}, stale released ${drained.released}, ` +
        `abandoned ${drained.abandoned}, issues queued ${drained.issuesQueued}, rate ${drained.ratePerSecond}/s`
    );
    return {
      processed: drained.sent,
      skipped: drained.suppressed + drained.unattempted + drained.requeued,
      failed: drained.failed > 0 ? [{ id: "deliveries", reason: `${drained.failed} message(s) could not be delivered` }] : []
    };
  });

  return ok(result);
}

export const GET = route(handle);
export const POST = route(handle);
