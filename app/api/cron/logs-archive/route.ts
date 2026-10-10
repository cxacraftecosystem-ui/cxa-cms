import { ok, route } from "@/lib/api";
import { assertCronAuthorised, runCronJob } from "@/lib/cron";
import { recordEvent } from "@/lib/audit";
import { storageAvailable } from "@/lib/storage/client";
import {
  LOG_ARCHIVE_KEY_ROOT,
  LOG_RETENTION_FLOOR_DAYS,
  archiveDay,
  archiveDestinationPrivacy,
  archiveScanDays,
  archiveSources,
  candidateDays,
  pendingDays
} from "@/lib/logArchive";

/**
 * The nightly log archive.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * Clause 4 of the CIC hosting undertaking:
 *
 *   "…It will be ensured that the logs are retained for a MINIMUM OF 90 DAYS and are made available
 *    to CIC upon request."
 *
 * Vercel's Hobby plan keeps runtime logs for one hour and gates Log Drains behind Pro, so the
 * platform cannot satisfy that sentence. This job copies the rows that CAN answer it — `audit_logs`,
 * which says what changed, and `access_logs`, which says what was requested — out of Postgres and
 * into the bucket, one set of objects per source per UTC day, at keys derived from the date so a
 * range can be fetched without enumerating anything. The layout, the format and the idempotence
 * argument are all in lib/logArchive.ts.
 *
 * ⚠ IT DELETES NOTHING, AND THAT IS A DECISION RATHER THAN AN OMISSION.
 *
 * A pruning job is a reasonable thing to want eventually: `audit_logs` is append-only and unbounded
 * today, and the Supabase plan's database size is not. But a deleter shipped in the same change as
 * the obligation to retain is how a compliance system deletes the evidence it exists to keep — one
 * wrong cutoff, one environment variable read as days instead of hours, and the rows are gone with
 * the audit trail of their going gone too. Archival has to be provably working FIRST: manifests
 * present for every day in the window, and somebody who has actually fetched a range back out of the
 * bucket.
 *
 * When that job is written, it MUST call `assertRetentionFloor` from lib/logArchive.ts with its
 * cutoff, and it must refuse to delete a day the archive has no manifest for. The floor is a
 * function, not a comment, so that it has to be got past rather than remembered.
 *
 * ⚠ THE GROUNDWORK FOR ONE IS ALREADY IN THE TREE. `accessLogRetentionDays()` in lib/env.ts reads
 * `ACCESS_LOG_RETENTION_DAYS` (180 by default) and the `AccessLog` schema comment names "the
 * retention delete (`at < cutoff`)" as the reason `at` is indexed. Nothing DELETES on either yet;
 * `archiveScanDays()` reads the window so that the archiver can reach every row that still exists,
 * which is the opposite direction and is not a step towards deleting. The two checks a deleter needs
 * are the floor and the manifest — a window configured at 180 days is not evidence that the rows it
 * is about to remove were ever archived.
 *
 * ⚠ AND `access_logs` IS STILL UNBOUNDED, WHICH IS A LIVE PROBLEM AND NOT ONLY AN UNTIDY ONE. Until a
 * deleter exists the table only grows. The amplification that made that dangerous — an anonymous
 * stranger able to drive one INSERT per request against `/api/cron/*` — is closed in
 * lib/requestLog.ts, which now samples anonymous refusals, so the growth is once again proportional
 * to real traffic rather than to whatever a script can generate. That buys the time this job needs to
 * prove itself before anything is allowed to delete; it does not remove the need.
 *
 * ⚠ INFRASTRUCTURE THIS CODE CANNOT DO, AND THE JOB IS NOT COMPLIANT WITHOUT IT:
 *
 *   1. **The bucket needs a lifecycle rule of at least 90 days on `files/logs/`** — and, more
 *      precisely, NO expiry rule shorter than that. Code puts the objects there; only the bucket
 *      decides how long they survive, and a 30-day expiry inherited from a bucket-wide rule would
 *      quietly undo every guarantee this file makes, with the job still reporting success nightly.
 *   2. **The archive prefix must not be anonymously readable.** See `archiveDestinationPrivacy` —
 *      anonymous GetObject is limited to the bucket's listed public prefixes (in production
 *      `media/*`, `models/*` and `craft/*`, verified 2026-10-10; local MinIO grants the whole
 *      bucket), and this job refuses to write until an operator attests in the environment
 *      (`LOG_ARCHIVE_DESTINATION_IS_PRIVATE=true`) that `files/logs/` stays outside them and that no
 *      lifecycle rule under 90 days applies to it. Production set it on 2026-10-10.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const dynamic = "force-dynamic";

/**
 * Bounded per run, the same way `MAX_ASSETS_PER_RUN` bounds the purge: a job that tries to archive
 * every outstanding day in one request times out, and a timed-out function leaves no `[cron]` line
 * at all — the absence of the line is the only signal anyone gets.
 *
 * Two bounds rather than one, because days are not the same size. `MAX_DAYS_PER_RUN` keeps a fresh
 * deployment's back-fill of empty or quiet days moving; `MAX_ROWS_PER_RUN` stops fourteen busy days
 * being attempted in one invocation.
 *
 * ⚠ BOTH ARE RUN-WIDE TOTALS THAT ARE THEN DIVIDED BETWEEN THE SOURCES, and the division is the
 * important half — see the long note at the loop for what sharing them in a fixed order cost. Seven
 * days per source per night drains a full back-fill of the scan window in a few weeks, against a
 * window that slides one day a night, so the backlog closes rather than chasing its own edge.
 *
 * ⚠ THE ROW BUDGET IS CHECKED BEFORE A DAY STARTS, NEVER DURING. A day is the atomic unit — see the
 * parts-then-manifest argument in lib/logArchive.ts — so a single day larger than the whole budget
 * still runs to completion rather than being abandoned half-written. The budget's job is to stop
 * the run starting ANOTHER day, not to interrupt one.
 */
const MAX_DAYS_PER_RUN = 14;
const MAX_ROWS_PER_RUN = 100_000;

/**
 * "The archive did nothing last night", written somewhere that outlives the night.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE REFUSAL PATHS USED TO BE SILENT IN EVERY DURABLE STORE, WHICH IS THE FAILURE THIS WHOLE
 * SLICE EXISTS TO PREVENT, REPRODUCED INSIDE IT.
 *
 * `recordEvent` was reached only inside the per-day success branch, so a run that archived nothing
 * wrote no row; the manifest set in the bucket stayed empty; and the explanation went to `notes`,
 * which is read by whoever is holding the HTTP response, and to `runCronJob`'s `[cron]` console line,
 * which on Hobby is discarded after ONE HOUR. The job runs once a day. So the mechanism whose entire
 * purpose is that one hour of retention is not enough announced its own failure exclusively into that
 * one hour — nightly, for as long as nobody happened to curl the endpoint by hand.
 *
 * One `AuditLog` row per refused run fixes it in the store this application already operates and
 * already produces to CIC. It is one row a night, it is a fact rather than a metric, and "when did
 * the archive stop working, and what did it say at the time" becomes a query instead of an
 * archaeology exercise.
 *
 * `recordEvent` and not `writeAudit`, for the reason lib/audit.ts gives: there is no row change to
 * pair this with, and it must not be able to fail the job.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function recordInertRun(reason: string, detail: string): Promise<void> {
  await recordEvent(
    { actor: null },
    {
      action: "ARCHIVE",
      entityType: "LogArchiveRun",
      entityId: `logs-archive:${reason}`,
      entityLabel: `logs-archive archived nothing — ${reason}`,
      after: { archived: 0, reason, detail }
    }
  );
}

export const GET = route(async (request: Request) => {
  assertCronAuthorised(request);

  const result = await runCronJob("logs-archive", async (notes) => {
    const failed: { id: string; reason: string }[] = [];
    let processed = 0;
    let skipped = 0;

    if (!storageAvailable()) {
      // Not an error, exactly as in the purge: a deployment without object storage has nowhere to
      // put an archive. It is reported every night rather than passed over, because "the logs are
      // being retained" is a claim somebody has made to CIC on this job's behalf.
      const note =
        "Object storage is not configured, so no logs were archived. Clause 4's 90-day retention is " +
        "NOT being met by this deployment — set S3_BUCKET, S3_REGION and the access keys.";
      notes.push(note);
      await recordInertRun("storage_unconfigured", note);
      return { processed, skipped, failed };
    }

    const privacy = archiveDestinationPrivacy();
    if (!privacy.confirmed) {
      notes.push(privacy.reason);
      await recordInertRun("destination_not_private", privacy.reason);
      return { processed, skipped, failed };
    }

    const now = new Date();
    const scanDays = archiveScanDays();
    const sources = archiveSources();
    let deferred = 0;

    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * ⚠ ONE BUDGET PER SOURCE, NOT ONE BUDGET SHARED IN A FIXED ORDER.
     *
     * `daysArchived` and `rowBudget` used to be single counters declared here and shared by the loop
     * below. `archiveSources()` returns `[audit, requests]` in a fixed order, so `audit_logs`
     * consumed the whole run's budget every night until it was caught up and `access_logs` got
     * nothing at all until then. On its own that is only slow. Combined with a scan window that
     * slides forward one day a night it is LOSSY: a backlog of ninety days on each source takes about
     * seven nights to drain the first source, and over those seven nights the second source's oldest
     * seven days aged past the window and stopped being candidates — permanently, with the job
     * thereafter reporting that source fully caught up. That report was literally true and materially
     * false, and the hole it left is precisely the one `dayPrefix`'s note warns readers about: a
     * missing manifest is indistinguishable from "we were not recording".
     *
     * `candidateDays`'s own comment — "OLDEST FIRST MATTERS … a capped run that always took the
     * newest day would archive yesterday every night and never finish a backlog" — was the right
     * reasoning applied one level too low. It holds WITHIN a source and says nothing across two of
     * them sharing one allowance, which is where the starvation was.
     *
     * Dividing rather than round-robining because it is the version with no ordering left in it at
     * all: each source gets a fixed share up front, so no source can be starved by another no matter
     * what order `archiveSources()` returns or how many entries it grows to. `Math.max(1, …)` keeps
     * every source able to make progress even if that list gets longer than the day budget — a run
     * that archives one day per source per night still drains a backlog, and one that archives zero
     * never does.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    const daysPerSource = Math.max(1, Math.floor(MAX_DAYS_PER_RUN / sources.length));
    const rowsPerSource = Math.max(1, Math.floor(MAX_ROWS_PER_RUN / sources.length));

    for (const source of sources) {
      let daysArchived = 0;
      let rowBudget = rowsPerSource;
      const unfinished: string[] = [];
      const earliest = await source.earliestAt();
      if (!earliest) {
        // No rows at all. Writing manifests for those days would assert "nothing happened", which is
        // a different claim from "we were not recording" — see `earliestAt` in lib/logArchive.ts.
        notes.push(`${source.table} is empty, so there is nothing to archive for it yet.`);
        continue;
      }

      /*
       * ⚠ THE SCAN RUNS EVEN WHEN THE RUN'S BUDGET IS ALREADY SPENT, AND THAT IS NOT AN OVERSIGHT.
       *
       * Skipping it once this source's day budget is spent would save one HEAD per day in the scan
       * window on a catch-up run — and would make the "left for the next run" count below a guess,
       * because a source nobody looked at contributes nothing to it. It would also blind the
       * window-edge warning at the end of this loop, which is the one that turns a permanent gap into
       * a recorded fact. The whole reason `CronResult` requires
       * `skipped` is that "and what didn't it do?" must be answerable; an under-reported backlog is
       * the one number that would let a stalled catch-up look like a finished one.
       */
      const candidates = candidateDays({ now, earliest, scanDays });
      const pending = await pendingDays(source, candidates);

      if (pending.length === 0) {
        notes.push(
          `${source.name}: every closed day in the last ${scanDays} is already archived ` +
            `(${candidates.length} day(s) checked).`
        );
        continue;
      }

      for (const day of pending) {
        if (daysArchived >= daysPerSource || rowBudget <= 0) {
          // Say what was left behind. A capped job that reports only its successes looks identical
          // to a job that finished the queue — the purge's words, and the same trap.
          deferred += 1;
          skipped += 1;
          unfinished.push(day);
          continue;
        }

        try {
          const outcome = await archiveDay(source, day);
          processed += 1;
          daysArchived += 1;
          rowBudget -= outcome.rows;

          /*
           * A durable, in-database record that the day was archived.
           *
           * `recordEvent` rather than `writeAudit`, for the reason lib/audit.ts gives: there is no
           * row change to pair this with, and it must not be able to fail the job — an archive that
           * landed must never be reported as failed because an audit insert hit a constraint. Both
           * existing cron routes write their per-item events exactly this way.
           *
           * `ARCHIVE` is an existing `AuditAction`, so this needs NO enum value and NO migration.
           *
           * ⚠ It does add one audit row per archived day, which tomorrow's run then archives, which
           * writes one more. It converges at one row per source per day and is not a loop — but it
           * is why the archive of a completely idle installation is never quite empty.
           */
          await recordEvent(
            { actor: null },
            {
              action: "ARCHIVE",
              entityType: "LogArchive",
              entityId: `${source.name}:${day}`,
              entityLabel: `${source.table} — ${day}`,
              after: {
                rows: outcome.rows,
                bytes: outcome.bytes,
                parts: outcome.parts,
                manifest: outcome.manifestKey
              }
            }
          );
        } catch (error) {
          /*
           * The day stays unarchived, which is exactly what its missing manifest already says, so
           * the next run picks it up with no cleanup and no state to reconcile. This is the
           * recoverable direction of the ordering argument in lib/logArchive.ts: work may be
           * repeated, but a day is never recorded as done when it is not.
           */
          failed.push({
            id: `${source.name}:${day}`,
            reason: `${day} could not be archived and will be retried on the next run: ${
              error instanceof Error ? error.message : String(error)
            }`
          });
          skipped += 1;
          unfinished.push(day);
        }
      }

      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * ⚠ THE LAST NIGHT A DAY CAN STILL BE SAVED, SAID OUT LOUD AND WRITTEN DOWN.
       *
       * `candidateDays` never looks further back than the scan window, and the window slides forward
       * one day every night. So the oldest candidate is the last chance: if it is still unarchived
       * when this run ends, tomorrow's run will not see it, `pendingDays` will never be asked about
       * it, and from then on this job reports the source fully caught up. The loss is silent, and
       * what it leaves behind — a date with no manifest — is indistinguishable to a reader from "we
       * were not recording then".
       *
       * Widening the window (see `archiveScanDays`) makes this rarer; it cannot make it impossible,
       * because any finite window has an edge. So the edge is reported.
       *
       * ⚠ AND IT IS REPORTED INTO `audit_logs`, NOT ONLY INTO `notes`. A note reaches the cron
       * response body and a console line that Hobby keeps for an hour — which is the retention
       * problem this job exists to solve, so using it as the only record of a permanent gap would be
       * self-defeating. An `AuditLog` row is in the store we produce to CIC, it is dated, and it
       * turns "there is no archive for the 4th" into "here is the night we recorded that the 4th was
       * about to become unarchivable, and why".
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      const oldest = candidates[0];
      if (oldest && unfinished.includes(oldest)) {
        const note =
          `⚠ ${source.name}:${oldest} is the OLDEST day in the ${scanDays}-day scan window and was ` +
          "not archived tonight, so tomorrow's run will not consider it at all and it will never be " +
          "archived. The rows are still in Postgres — nothing deletes them — so the gap is in object " +
          "storage only, and it can still be closed by hand or by widening ACCESS_LOG_RETENTION_DAYS " +
          "(which widens the scan window) before the next run.";
        notes.push(note);
        await recordEvent(
          { actor: null },
          {
            action: "ARCHIVE",
            entityType: "LogArchiveGap",
            entityId: `${source.name}:${oldest}`,
            entityLabel: `${source.table} — ${oldest} left the archive scan window unarchived`,
            after: { source: source.name, day: oldest, scanDays, unfinished: unfinished.length }
          }
        );
      }
    }

    if (deferred > 0) {
      notes.push(
        `${deferred} day(s) were left for the next run — this run is capped at ${MAX_DAYS_PER_RUN} day(s) ` +
          `and ${MAX_ROWS_PER_RUN} row(s), divided evenly across ${sources.length} source(s) so that ` +
          `neither can starve the other (${daysPerSource} day(s) and ${rowsPerSource} row(s) each). ` +
          "Call this endpoint again with the cron bearer token to continue immediately rather than " +
          "waiting for tomorrow."
      );
    }

    if (processed > 0) {
      notes.push(
        `Archived ${processed} day(s) under ${LOG_ARCHIVE_KEY_ROOT}/<source>/<YYYY>/<MM>/<DD>/. ` +
          "Each day has a manifest.json naming its part-NNNN.ndjson files, so a date range is " +
          "fetched by computing keys rather than by listing the bucket."
      );
      notes.push(
        `Retention floor: no path in this application may delete a log row younger than ` +
          `${LOG_RETENTION_FLOOR_DAYS} days, and nothing in this job deletes anything at all. The ` +
          "bucket needs its own lifecycle rule of at least that long."
      );
    }

    return { processed, skipped, failed };
  });

  return ok(result);
});
