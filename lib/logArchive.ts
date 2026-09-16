import "server-only";
import { prisma } from "@/lib/db";
import {
  ACCESS_LOG_RETENTION_DEFAULT_DAYS,
  accessLogRetentionDays,
  logArchiveDestinationIsPrivate
} from "@/lib/env";
import { headObject, putObject } from "@/lib/storage/client";

/**
 * Log archival, and the 90-day retention floor.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 *
 * The hosting undertaking signed with IIT KGP's Computer and Informatics Centre carries CLAUSE 4:
 *
 *   "The PI/PIC/Website In-charge shall be responsible for the continuous monitoring of all
 *    website-related logs. Any suspected security anomalies shall be immediately reported to the
 *    CIC. It will be ensured that the logs are retained for a MINIMUM OF 90 DAYS and are made
 *    available to CIC upon request."
 *
 * The responsibility is entirely ours, because the site is externally hosted rather than on a CIC
 * server. The deployment is on Vercel's Hobby plan, which retains runtime logs for ONE HOUR and
 * gates Log Drains behind Pro — so `console.log` is not a retention mechanism, and clause 4 has to
 * be satisfied from inside the application, into storage we already operate.
 *
 * This module turns database rows into dated objects in the bucket. It DELETES NOTHING. See the
 * retention floor below for why shipping a deleter next to a retention obligation would be the
 * single worst thing this file could do.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * ⚠ THE RETENTION FLOOR. NOTHING IN THIS APPLICATION MAY DELETE AN AUDIT OR REQUEST LOG ROW YOUNGER
 * THAN THIS MANY DAYS.
 *
 * Clause 4, verbatim: "It will be ensured that the logs are retained for a MINIMUM OF 90 DAYS and
 * are made available to CIC upon request."
 *
 * It is a constant and NOT an environment variable, deliberately. Every other window in this
 * codebase is configurable — `MEDIA_PURGE_AFTER_DAYS`, the session prune — because each is an
 * operational preference. This one is a term in a signed undertaking whose stated penalty
 * (clause 5) is deactivation of the website. A value an operator can lower in a dashboard at 2 a.m.
 * to reclaim disk is not a floor; it is a suggestion. Retaining longer is done by archiving further
 * back, never by editing this number down.
 *
 * ⚠ IT IS A FLOOR, NOT A SCHEDULE. Nothing here deletes at 90 days either. 90 is the earliest a
 * deleter would be ALLOWED to touch, if one ever existed.
 *
 * ⚠ THERE IS A SECOND 90 IN THIS TREE AND THEY MUST NEVER DISAGREE. `lib/env.ts` carries
 * `ACCESS_LOG_RETENTION_FLOOR_DAYS`, which `accessLogRetentionDays()` throws below. That one guards
 * a configured window for `access_logs`; this one guards every deletion path for BOTH log tables
 * and is what the archive manifests record. Two hand-maintained copies of a number in a signed
 * undertaking is one edit away from a system that enforces 90 in one place and 30 in another, and
 * reports success from both. They should be one constant: `lib/env.ts` is the right home, because
 * it is the leaf — this module reaches lib/env.ts through lib/storage/client.ts, so an import the
 * other way round would be a cycle. That merge is not made here only because lib/env.ts belongs to
 * another slice of this change.
 */
export const LOG_RETENTION_FLOOR_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The most recent instant a pruning path is permitted to delete before.
 *
 * A deleter must remove rows strictly OLDER than this, never rows at or after it.
 */
export function retentionFloorCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - LOG_RETENTION_FLOOR_DAYS * DAY_MS);
}

/**
 * The guard every future pruning path MUST call before it deletes a log row.
 *
 * There is no pruning path in this application today, and this slice deliberately does not add one
 * — see the note at the top of app/api/cron/logs-archive/route.ts. This exists so that when one is
 * written, the floor is a function it has to get past rather than a number in a comment it has to
 * remember. Call it with the cutoff you are about to delete before:
 *
 *   assertRetentionFloor(cutoff, "audit_logs");
 *   await prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
 *
 * It throws rather than clamping. A silently clamped cutoff would let a job that believes it prunes
 * at 30 days run for months looking healthy — and the disagreement would surface only when somebody
 * is asked to produce a row the clamp happened to save and the job's own output says was deleted. A
 * throw is a failed cron run that somebody reads.
 */
export function assertRetentionFloor(cutoff: Date, what: string): void {
  const floor = retentionFloorCutoff();
  if (cutoff.getTime() > floor.getTime()) {
    const days = Math.round((Date.now() - cutoff.getTime()) / DAY_MS);
    throw new Error(
      `Refusing to delete ${what} newer than the ${LOG_RETENTION_FLOOR_DAYS}-day retention floor: the ` +
        `requested cutoff is ${days} day(s) old. Clause 4 of the CIC hosting undertaking requires these ` +
        `rows to be retained for a minimum of ${LOG_RETENTION_FLOOR_DAYS} days. See ` +
        "LOG_RETENTION_FLOOR_DAYS in lib/logArchive.ts."
    );
  }
}

/**
 * How far back a run looks for days it has not archived yet.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS WAS `= LOG_RETENTION_FLOOR_DAYS`, AND THE TWO NUMBERS ARE NOT THE SAME KIND OF NUMBER.
 *
 * The old reasoning read: "the window the clause obliges us to be able to PRODUCE is the same window
 * in which a hole is worth repairing". That confuses a FLOOR ON RETENTION with a RECOVERY WINDOW.
 * 90 is the earliest a deleter would ever be allowed to touch. It says nothing about how far back an
 * ARCHIVER should be willing to look — and used as a scan window it had a consequence nobody
 * intended: the window slides forward one day a night, so a day that went unarchived for ninety days
 * could never be archived again. `candidateDays` simply stopped returning it, `pendingDays` never saw
 * it, and from that night on the run reported "every closed day in the last 90 is already archived",
 * which was literally true and materially false.
 *
 * That is not hypothetical. `LOG_ARCHIVE_DESTINATION_IS_PRIVATE` defaults to refusing, so a
 * deployment that has not set it archives nothing at all; ninety-one nights later the first three
 * months of the site's history were permanently unarchivable, and the rows were all still sitting in
 * Postgres. The archiver has to be able to reach every row that still EXISTS, which is
 * `accessLogRetentionDays()` (180 by default) for `access_logs` and — since nothing deletes them at
 * all — the whole history for `audit_logs`.
 *
 * So: the longer of the floor and the configured access-log window, which is 180 out of the box. The
 * cost is HEAD requests, batched at `HEAD_CONCURRENCY`: 180 days across two sources is 36 round trips
 * on a nightly job, against never being able to repair a gap. `audit_logs` is still not covered to
 * infinity, and that is a deliberate stopping point rather than an oversight — a scan with no bound
 * grows a nightly job's cost for ever, and a gap older than the longest configured retention window
 * is one an operator has to repair by hand.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function archiveScanDays(): number {
  try {
    return Math.max(LOG_RETENTION_FLOOR_DAYS, accessLogRetentionDays());
  } catch {
    /*
     * `accessLogRetentionDays()` throws on a malformed value and on one below the 90-day floor. This
     * is a scan window, so the consequence of the throw escaping would be a cron run that archives
     * nothing because a number it only uses to bound a loop was mistyped — the wrong direction
     * entirely. `configurationWarnings()` already reports the bad value where an administrator reads
     * it, so falling back to the same default the accessor would have used costs nothing and keeps
     * the archive running. NOT a hand-copied 180: one constant, imported.
     */
    return Math.max(LOG_RETENTION_FLOOR_DAYS, ACCESS_LOG_RETENTION_DEFAULT_DAYS);
  }
}

/**
 * ⚠ THE KEY ROOT IS `files/logs`, NOT `logs`, AND THAT IS NOT A PREFERENCE.
 *
 * `isSafeObjectKey` (lib/storage/keys.ts:120) rejects any key whose first segment is not one of
 * `KEY_NAMESPACES` — `media`, `files`, `models`, `tmp` — and `putObject` asserts it on every write.
 * A key of `logs/…` throws a 400 `bad_object_key` before a byte leaves the function. Adding `logs`
 * to that array is a one-token change, but lib/storage/keys.ts belongs to another slice of this
 * change and is not edited here.
 *
 * ⚠ AND IF IT IS ADDED LATER, DO NOT MOVE THIS CONSTANT ON ITS OWN. The key scheme is a RETRIEVAL
 * CONTRACT: every reader finds an archive by computing its key from a date (see `dayPrefix`). Split
 * the history across two roots and every range query silently returns half an answer for the dates
 * that straddle the change, with nothing anywhere recording that a second root exists. Moving the
 * root means moving every object already under the old one, in the same change.
 *
 * There is no collision risk with real file assets. `buildObjectKey` always emits
 * `files/<YYYY>/<MM>/…`, and a four-digit year is never the literal `logs`.
 */
export const LOG_ARCHIVE_KEY_ROOT = "files/logs";

/**
 * NEWLINE-DELIMITED JSON, one row per line.
 *
 * Clause 4 says the logs must be "made available to CIC upon request", and what is actually
 * requested is a DATE RANGE — "everything between the 4th and the 11th". Three properties decided
 * the format, and each rules out an alternative:
 *
 *   • **Every line is independently valid JSON.** A file truncated by a failed transfer still
 *     yields every complete line before the cut. A single top-level JSON array yields NOTHING from
 *     a truncated file — the parser reaches EOF looking for `]` and throws away the 40 MB it has
 *     already read. For evidence, partial is worth immeasurably more than nothing.
 *   • **It streams and splits with the tools an incident responder already has.** `grep`, `wc -l`,
 *     `split`, `sort` and `jq -c` all work a line at a time. A JSON array has to be parsed whole
 *     before the first row can be looked at, which for a busy day means holding the day in memory
 *     to answer "did this address appear".
 *   • **`JSON.stringify` never emits a raw newline inside a string** — U+000A is escaped as `\n` —
 *     so one row is exactly one line, with no quoting rules to get wrong. This is the property the
 *     whole format rests on.
 *
 * REJECTED: CSV, because `before`/`after` on an audit row are nested JSON objects, so CSV forces
 * either a second encoding inside a cell or a schema that flattens away the part worth keeping —
 * and a comma or a quote inside a user-agent string has broken every naive CSV reader ever written.
 * REJECTED: one JSON array per day, for the truncation reason above. REJECTED: Parquet, which needs
 * tooling the recipient may not have and turns "open the file and read it" into a project.
 *
 * NOT COMPRESSED, and that is a known cost. `putObject` sets `ContentType` but takes no
 * `ContentEncoding`, so a `.ndjson.gz` would be served under a type that lies about its bytes;
 * gzip belongs in a change that also touches lib/storage/client.ts. NDJSON compresses at roughly
 * 10:1, so this is the largest saving still on the table.
 */
const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/**
 * ⚠ NOT `putObject`'s DEFAULT. It defaults to `public, max-age=31536000, immutable`, which is right
 * for an image derivative behind a CDN and wrong for an audit trail: it invites every proxy between
 * here and the reader to keep its own copy of the institute's record of who did what from which
 * address.
 */
const ARCHIVE_CACHE_CONTROL = "private, no-store";

/**
 * Rows per object, and the byte ceiling that closes one early.
 *
 * `ROWS_PER_PART` is also the database page size, so at most this many rows are ever in memory at
 * once. `MAX_PART_BYTES` exists because rows are not uniform: an audit row's `before`/`after` hold
 * the FULL serialised entity, so one row describing a long page can be a hundred times the size of
 * a sign-in row, and a thousand of the former would be the function's memory limit rather than a
 * file.
 *
 * ⚠ A single row larger than `MAX_PART_BYTES` still produces a one-row part over budget. That is
 * correct — splitting a row across two objects would break the "every line is a whole record"
 * property the format depends on.
 */
const ROWS_PER_PART = 1_000;
const MAX_PART_BYTES = 8 * 1024 * 1024;

/**
 * The point at which a day is refused rather than retried for ever.
 *
 * A day is archived all-or-nothing, so a day too large to finish inside one invocation would fail,
 * be retried tomorrow, fail again, and go on failing quietly until somebody read a response body.
 * Past this it fails with a reason that names the number, on every run, in `failed` — which is the
 * visible direction.
 *
 * ⚠ THE REFUSAL MUST COST NOTHING, AND FOR A WHILE IT COST EVERYTHING. This cap used to be tested at
 * the top of the loop with no idea how large the day was, so a day of 101,000 rows uploaded ONE
 * HUNDRED PARTS — up to `MAX_PARTS_PER_DAY * MAX_PART_BYTES`, 800 MB of PUTs — and only then threw.
 * Every one of those objects was orphaned (no manifest names them, so no reader sees them), the work
 * was discarded, and because nothing anywhere records a day as unarchivable, `pendingDays` returned
 * the same day the next night and the same 800 MB went up again. Nightly. For ever. On a plan the
 * rest of this design is explicitly cost-tuned for. The comment here said the cap made a too-large
 * day "fail loudly every run rather than time out silently for ever", and it did both: it spent the
 * whole invocation before failing.
 *
 * `archiveDay` now asks `source.count()` for the day first and refuses before the first PUT whenever
 * the ROW count alone cannot fit. See the guard there for the one case that still cannot be known in
 * advance.
 */
const MAX_PARTS_PER_DAY = 100;

/**
 * How long after midnight UTC a day is treated as closed.
 *
 * ⚠ THIS IS THE GAP NOBODY WOULD EVER FIND, AND THERE ARE TWO SEPARATE WAYS TO FALL INTO IT.
 *
 *   1. **Clock skew.** `audit_logs.createdAt` is defaulted by POSTGRES (`now()`), while the decision
 *      "is this day finished" is made with the FUNCTION's clock. If the function's clock runs even
 *      half a second fast, a row the database stamps 23:59:59.9 is written after this job has read
 *      the day, decided it complete, and written the manifest that stops it ever being read again.
 *   2. **Rows that arrive late by design.** `access_logs.at` is the instant the REQUEST STARTED,
 *      passed in explicitly, and the insert happens after the response is flushed. A request that
 *      began at 23:59:58 behind a handler that took four seconds is inserted at 00:00:02 carrying
 *      an `at` inside a day that has already ended. Without a margin, that row lands in a day this
 *      job archived ninety seconds earlier and will never look at again.
 *
 * Either way it is one row, permanently missing, from an archive that reports itself whole. An hour
 * of margin costs nothing against a job that runs once a night, and it is the difference between
 * "this archive is complete" being a claim and being true.
 */
const DAY_CLOSE_MARGIN_MS = 60 * 60 * 1000;

/** HEAD requests in flight at once while working out which days are already archived. */
const HEAD_CONCURRENCY = 10;

/**
 * One archivable table.
 *
 * Deliberately closures rather than a Prisma delegate type. The delegates are heavily overloaded
 * generics that do not satisfy a hand-written structural interface, and casting one into shape
 * would silently accept a model whose timestamp column is called something else — producing an
 * archive that is empty, or a day short, with a manifest claiming otherwise.
 *
 * ⚠ `page` must return rows `JSON.stringify` can encode. That is every column type these tables
 * use; a `BigInt` would THROW and a `Decimal` would serialise as an opaque object, so a source over
 * a table with either must convert inside its own closure.
 */
export interface LogArchiveSource {
  /** Key segment and manifest identity. Changing it once archives exist orphans every one of them. */
  readonly name: string;
  /** The physical table, recorded in the manifest so a reader knows what the rows are. */
  readonly table: string;
  /** The column the day partition is cut on, recorded for the same reason. */
  readonly timestampColumn: string;
  /**
   * The oldest row's timestamp, or null when the table is empty.
   *
   * ⚠ THIS IS WHAT STOPS THE ARCHIVE TELLING A LIE. Without it, back-filling would write a manifest
   * reading `rows: 0` for every day before the table had rows — positive evidence of "no activity
   * on that date" for dates on which we simply were not recording. A missing manifest honestly says
   * "there is no archive for this date"; an empty one says "there was nothing to archive", and only
   * one of those is true before the first row.
   */
  earliestAt(): Promise<Date | null>;
  /**
   * How many rows fall inside a closed day.
   *
   * ⚠ ITS ONLY CALLER IS THE BUDGET GUARD IN `archiveDay`, AND IT EXISTS SO THAT A DAY TOO LARGE TO
   * FINISH IS REFUSED BEFORE A SINGLE OBJECT IS WRITTEN. It is one indexed `count(*)` over a window
   * both tables already have an index on, against up to a hundred PUTs of wasted upload — see
   * `MAX_PARTS_PER_DAY`. It must count the same window `page` selects from, or the guard is
   * protecting the wrong number.
   */
  count(input: { from: Date; to: Date }): Promise<number>;
  /** One page of a closed day, ordered deterministically. */
  page(input: { from: Date; to: Date; skip: number; take: number }): Promise<unknown[]>;
}

/**
 * ⚠ OFFSET PAGINATION, WHICH IS ONLY CORRECT BECAUSE THE DAY IS CLOSED.
 *
 * `skip`/`take` over a live table double-counts and skips rows as the table shifts underneath it.
 * Here the window is a day that ended at least `DAY_CLOSE_MARGIN_MS` ago and no writer can still be
 * targeting it — the set is immutable and the ordering total, which makes the same offsets produce
 * the same partitioning on a retry. That determinism is what lets a retried day overwrite its parts
 * with identical bytes instead of producing a different, overlapping set.
 *
 * The one thing that would break it is a DELETE inside a closed day, which is exactly what the
 * retention floor above forbids. This applies to both sources below, not just this one.
 */
export const auditLogSource: LogArchiveSource = {
  name: "audit",
  table: "audit_logs",
  timestampColumn: "createdAt",
  async earliestAt() {
    const row = await prisma.auditLog.findFirst({
      orderBy: { createdAt: "asc" },
      select: { createdAt: true }
    });
    return row?.createdAt ?? null;
  },
  async count({ from, to }) {
    return prisma.auditLog.count({ where: { createdAt: { gte: from, lt: to } } });
  },
  async page({ from, to, skip, take }) {
    return prisma.auditLog.findMany({
      where: { createdAt: { gte: from, lt: to } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip,
      take
    });
  }
};

/**
 * The request log.
 *
 * ⚠ ITS TIMESTAMP COLUMN IS `at`, NOT `createdAt`, AND THAT IS WHY THIS IS A CLOSURE. `AccessLog`
 * was designed by the slice that writes it, and its `at` is passed in explicitly rather than
 * defaulted — the insert happens after the response is flushed, so `now()` would date every row by
 * however long the handler took (prisma/schema.prisma, `model AccessLog`). A generic archiver that
 * assumed one column name across both tables would have archived the audit trail correctly and
 * silently produced nothing for this one.
 *
 * `id` is an autoincrementing `Int`, which `JSON.stringify` encodes without complaint — the schema
 * chose `Int` over `BigInt` for exactly that reason, so the NDJSON contract below holds.
 *
 * Ordering on `at` then `id` rather than on `id` alone: `id` is monotonic per insert, but the rows
 * are written after their responses, so two requests can land in an order their ids do not reflect.
 * The archive is read chronologically, so it is sorted chronologically.
 */
export const requestLogSource: LogArchiveSource = {
  name: "requests",
  table: "access_logs",
  timestampColumn: "at",
  async earliestAt() {
    const row = await prisma.accessLog.findFirst({
      orderBy: { at: "asc" },
      select: { at: true }
    });
    return row?.at ?? null;
  },
  async count({ from, to }) {
    return prisma.accessLog.count({ where: { at: { gte: from, lt: to } } });
  },
  async page({ from, to, skip, take }) {
    return prisma.accessLog.findMany({
      where: { at: { gte: from, lt: to } },
      orderBy: [{ at: "asc" }, { id: "asc" }],
      skip,
      take
    });
  }
};

/**
 * Every table this job archives.
 *
 * Both of the tables clause 4 is about: `audit_logs`, which says what changed, and `access_logs`,
 * which says what was requested. They are separate sources rather than one merged stream because
 * they are separate questions with different shapes, and a reader asking "what did this address do
 * on the 9th" should not have to filter one out of the other. Each gets its own key prefix, so a
 * date range can be fetched for one without the other.
 *
 * A source added here needs nothing else: the route loops over whatever this returns, reports every
 * source BY NAME in `notes` on each run, and back-fills the new one from its first row.
 */
export function archiveSources(): LogArchiveSource[] {
  return [auditLogSource, requestLogSource];
}

/**
 * Is the archive destination actually private?
 *
 * ⚠ READ THIS BEFORE CHANGING THE DEFAULT. The media bucket grants anonymous `s3:GetObject` on
 * `arn:aws:s3:::<bucket>/*` — the WHOLE bucket, every prefix — because that is what makes
 * `NEXT_PUBLIC_CDN_URL` work (docker/minio-public-read.json, and docker-compose.yml:103 says a real
 * S3 bucket "needs the same care"). `s3:ListBucket` is denied, so keys cannot be enumerated, and for
 * media that is the whole defence: an upload key carries eight random bytes and is unguessable.
 *
 * ARCHIVE KEYS ARE THE OPPOSITE BY DESIGN. They are computed from a date precisely so a reader can
 * fetch a range without listing. Anonymous GetObject plus a derivable key is publication: anybody
 * who can type `/files/logs/audit/2026/09/15/manifest.json` gets the institute's record of who
 * signed in, from which address, and every before/after snapshot of every edit.
 *
 * So the write is gated on an operator ASSERTING that the destination is private, and the default
 * is to refuse — the same choice lib/cron.ts makes about `CRON_SECRET`, for the same reason: the
 * failure mode of the opposite default is not a broken feature, it is a disclosure.
 *
 * REJECTED: putting the keys behind an HMAC of a secret, which would be unguessable and still
 * date-derivable. It makes the archive unreadable for ever the first time anybody rotates or loses
 * that secret, and a compliance store that destroys its own evidence during a routine credential
 * rotation is worse than the problem it solves.
 *
 * REJECTED: writing anyway and documenting the risk. A leak documented in a comment is a leak.
 *
 * ⚠ TWO CALLERS NOW, AND THE SECOND ONE IS WHY THIS COMMENT MATTERS MORE THAN IT DID.
 * app/api/cron/logs-archive/route.ts is the obvious one. app/api/drains/logs/route.ts is the other:
 * the drain receiver writes `files/logs/vercel/<date>/…` into the same root in the same bucket, and
 * for a while it did so without asking this question at all — so a deployment on Pro could have the
 * archive job correctly refusing to write while the drain beside it published every client IP and
 * every request URL the CDN served. Anything that writes under `LOG_ARCHIVE_KEY_ROOT` must call this
 * first. `grep -rn archiveDestinationPrivacy` is how you check that it still does.
 *
 * ⚠ THE READ ITSELF MOVED TO lib/env.ts, beside `mediaPurgeAfterDays()`, which is where this comment
 * used to say it belonged. The SENTENCE stays here, because it names `LOG_ARCHIVE_KEY_ROOT` and the
 * scan window, and lib/env.ts importing this module would be a cycle — this one reaches lib/env.ts
 * through lib/storage/client.ts already.
 */
export function archiveDestinationPrivacy(): { confirmed: boolean; reason: string } {
  const privacy = logArchiveDestinationIsPrivate();
  if (privacy.confirmed) return { confirmed: true, reason: "" };

  return {
    confirmed: false,
    reason:
      (privacy.malformed
        ? `LOG_ARCHIVE_DESTINATION_IS_PRIVATE is "${privacy.raw}", which is not a yes, so `
        : "") +
      "no logs were archived: the destination has not been confirmed private. The media bucket " +
      "grants anonymous GetObject on every key, and archive keys are derived from the date by " +
      "design, so archiving into it as it stands would publish the audit trail to anyone who can " +
      `guess a URL. Give the archive a bucket policy that excludes "${LOG_ARCHIVE_KEY_ROOT}/*" from ` +
      "anonymous access (or a private bucket of its own), then set " +
      "LOG_ARCHIVE_DESTINATION_IS_PRIVATE=true. Nothing is lost meanwhile — no log row is ever " +
      `deleted, so the first runs after the change back-fill every pending day within the last ${archiveScanDays()}.`
  };
}

/* ───────────────────────────────── day arithmetic, all in UTC ─────────────────────────────── */

/**
 * ⚠ EVERY BOUNDARY HERE IS UTC, AND MIXING IN A LOCAL ONE WOULD BE INVISIBLE.
 *
 * Keys are partitioned by UTC date (lib/storage/keys.ts does the same for uploads), Vercel's
 * functions run UTC, and a developer's machine does not. A day cut on IST would be five and a half
 * hours out of step with the key it is written under: the archive would hold the wrong rows for the
 * date on its own label, be internally consistent, pass every check, and be wrong.
 */
function utcDayString(at: Date): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  const day = String(at.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The half-open window `[start, end)` of a `YYYY-MM-DD` UTC day. */
export function dayWindow(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * Closed UTC days within the scan window, oldest first, excluding any that precede the source's
 * first row.
 *
 * OLDEST FIRST MATTERS. A capped run that always took the newest day would archive yesterday every
 * night and never finish a backlog — the gap would sit there, one run short, for ever.
 * Oldest-first drains it.
 */
export function candidateDays(input: { now: Date; earliest: Date; scanDays: number }): string[] {
  const newestClosedEnd = input.now.getTime() - DAY_CLOSE_MARGIN_MS;
  const days: string[] = [];

  for (let back = input.scanDays; back >= 1; back -= 1) {
    const day = utcDayString(new Date(input.now.getTime() - back * DAY_MS));
    const { end } = dayWindow(day);
    // Not finished settling yet — see DAY_CLOSE_MARGIN_MS.
    if (end.getTime() > newestClosedEnd) continue;
    // Entirely before this table had any rows, so there is nothing to attest to.
    if (end.getTime() <= input.earliest.getTime()) continue;
    days.push(day);
  }

  return days;
}

/* ──────────────────────────────────────── key layout ──────────────────────────────────────── */

/**
 * ⚠ THE KEYS ARE DATE-PARTITIONED, AND THAT IS THE WHOLE RETRIEVAL DESIGN.
 *
 *   files/logs/<source>/<YYYY>/<MM>/<DD>/manifest.json
 *   files/logs/<source>/<YYYY>/<MM>/<DD>/part-0001.ndjson
 *
 * Clause 4 requires the logs to be "made available to CIC upon request", and a request is for a
 * DATE RANGE. One undifferentiated blob per table would satisfy "we kept the logs" and fail
 * "available": producing March would mean downloading and scanning everything ever written.
 *
 * Because the key is a pure function of (source, date), A READER ANSWERS A RANGE WITHOUT LISTING
 * THE BUCKET — for each date in the range, GET the manifest, then GET the parts it names. That
 * matters twice over: the bucket policy denies `s3:ListBucket` deliberately
 * (docker-compose.yml:94), and `listObjectKeys` throws above 200 keys (lib/storage/client.ts:301).
 * A scheme that needed a listing would be unusable in this bucket.
 *
 * `YYYY/MM/DD` rather than `YYYY-MM-DD`, so a month — or a year — is also a single prefix, which is
 * what an S3 lifecycle rule and a bulk copy both operate on.
 *
 * ⚠ A MISSING MANIFEST MEANS "NO ARCHIVE EXISTS FOR THIS DATE". It does not mean "no activity":
 * that is a manifest with `rows: 0`. Anybody reading a range must tell the two apart, and a reader
 * that treats an absent object as an empty day reports a gap as a quiet week.
 */
export function dayPrefix(source: string, day: string): string {
  const [year, month, date] = day.split("-");
  return `${LOG_ARCHIVE_KEY_ROOT}/${source}/${year}/${month}/${date}`;
}

export function manifestKey(source: string, day: string): string {
  return `${dayPrefix(source, day)}/manifest.json`;
}

export function partKey(source: string, day: string, index: number): string {
  return `${dayPrefix(source, day)}/part-${String(index).padStart(4, "0")}.ndjson`;
}

/* ──────────────────────────────────────── the manifest ────────────────────────────────────── */

export interface LogArchiveManifest {
  schemaVersion: 1;
  job: "logs-archive";
  source: string;
  table: string;
  timestampColumn: string;
  /** UTC, `YYYY-MM-DD`. */
  day: string;
  /** The half-open window the rows were selected on, so a reader need not re-derive it. */
  from: string;
  to: string;
  rows: number;
  bytes: number;
  /** Full object keys, in order. A part not named here is not part of the archive. */
  parts: string[];
  format: typeof NDJSON_CONTENT_TYPE;
  archivedAt: string;
  /** The policy this archive was written under, so the evidence states its own terms. */
  retentionFloorDays: number;
}

export interface DayArchiveOutcome {
  rows: number;
  bytes: number;
  parts: number;
  manifestKey: string;
}

/**
 * Has this day already been archived?
 *
 * The MANIFEST's presence is the answer, and nothing else is consulted — no database flag, no
 * cursor object, no "archived through" marker. Every one of those can disagree with the bucket, and
 * the direction they disagree in is the fatal one: a cursor reading "done through the 14th" after
 * the 9th failed leaves a hole nothing will ever look at again. The objects ARE the archive, so the
 * objects are the record of what has been archived.
 */
export async function isDayArchived(source: LogArchiveSource, day: string): Promise<boolean> {
  return (await headObject(manifestKey(source.name, day))) !== null;
}

/**
 * Which of these days still need archiving.
 *
 * HEADs go out in bounded batches rather than one at a time (a 90-day scan is 90 round trips, which
 * is most of a nightly function's budget spent on nothing) and rather than all at once (90 sockets
 * against a gateway that may rate-limit them, turning a scan into a failure).
 */
export async function pendingDays(source: LogArchiveSource, days: string[]): Promise<string[]> {
  const pending: string[] = [];

  for (let index = 0; index < days.length; index += HEAD_CONCURRENCY) {
    const batch = days.slice(index, index + HEAD_CONCURRENCY);
    const present = await Promise.all(batch.map((day) => isDayArchived(source, day)));
    batch.forEach((day, position) => {
      if (!present[position]) pending.push(day);
    });
  }

  return pending;
}

/**
 * Archive one closed day, all or nothing.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IDEMPOTENCE: PARTS FIRST, MANIFEST LAST. THE ORDER IS THE WHOLE GUARANTEE.
 *
 * This is app/api/cron/purge/route.ts's argument applied to a write instead of a delete. That file
 * deletes bytes before the row because the two failure modes are not equally bad: an orphan row is
 * visible and fixable, an orphan object is invisible and accumulates for ever. The same asymmetry
 * decides the order here:
 *
 *   • parts written, manifest written     → correct.
 *   • parts written, manifest NOT written → the day reads as unarchived. The next run does it again
 *     and overwrites the parts with identical bytes. Wasted work, no gap. RECOVERABLE.
 *   • manifest written, parts NOT written → a day that reports itself complete and is not. Nothing
 *     ever re-examines it, because the manifest is precisely what stops re-examination. INVISIBLE,
 *     and discovered by CIC asking for a date we cannot produce.
 *
 * So the manifest is written only after every part has landed, and a failure anywhere before that
 * leaves the day looking untouched — which it is.
 *
 * WHY A RETRY PRODUCES IDENTICAL PARTS: the window is a closed day, the ordering is total
 * (`createdAt`, then `id`), and the part boundaries are a deterministic function of that ordering.
 * Run it twice and the same rows land in the same parts under the same keys, byte for byte —
 * measured, not assumed. TWO CONCURRENT RUNS ARE SAFE FOR THE SAME REASON: they race to write
 * identical objects, and an S3 PUT is atomic per object, so the loser is indistinguishable from the
 * winner. There is no lock here and none is needed.
 *
 * ⚠ THE MANIFEST IS THE ONE OBJECT THAT IS NOT BYTE-STABLE, because `archivedAt` records when it
 * was written. Every other field is identical, so whichever copy survives a race is a truthful
 * record of when the surviving copy was made. Do not "fix" this by dropping the field or by
 * skipping the write when a manifest already exists: the second would mean a day that was
 * re-archived after rows were repaired still advertises the old row count.
 *
 * WHY THERE ARE NO DUPLICATE AND NO MISSING DAYS: a day is archived exactly when its manifest is
 * absent; the manifest appears only once the day is complete; and the day itself cannot change
 * afterwards, because it is closed and the retention floor forbids deleting into it. Re-running the
 * job an hour later, or ten times, converges on the same set of objects.
 *
 * ⚠ ONE RESIDUE. A run that wrote five parts and died, followed by a run whose day now needs four,
 * leaves `part-0005` behind. It is not in the manifest, and the manifest is the index — an unnamed
 * part is not part of the archive and no reader will see it. It can only arise if rows were deleted
 * from a closed day, which the retention floor forbids.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function archiveDay(source: LogArchiveSource, day: string): Promise<DayArchiveOutcome> {
  const { start, end } = dayWindow(day);

  /*
   * ⚠ ASKED BEFORE ANYTHING IS WRITTEN, AND THAT IS THE WHOLE REASON IT IS ASKED AT ALL.
   *
   * One indexed `count(*)` over the day, against up to a hundred wasted PUTs — see the note on
   * `MAX_PARTS_PER_DAY` for what this replaced. It is also the only number the guard below can be
   * exact with: `page` reveals the size of a day one page at a time, which is too late.
   */
  const total = await source.count({ from: start, to: end });

  const parts: string[] = [];
  let rows = 0;
  let bytes = 0;
  let offset = 0;

  for (;;) {
    /*
     * ⚠ THE BUDGET GUARD, AND IT IS AN EXACT STATEMENT RATHER THAN AN ESTIMATE.
     *
     * A part holds at most `ROWS_PER_PART` rows. So if the rows still to write exceed what the parts
     * still available could hold even at their maximum, this day CANNOT be finished — not "probably
     * will not", cannot. No estimate is involved and there is no false positive, which matters: a
     * day wrongly refused is a permanent hole in the ninety-day record, which is worse than the
     * wasted uploads this guard exists to prevent.
     *
     * On the first pass `rows` and `parts.length` are both zero, so this is exactly the up-front
     * question "does the day fit at all" — asked before the first PUT, which is the fix. On later
     * passes it catches nothing new for a row-bound day (the answer cannot change) and it is what
     * stops the loop running past the cap for a BYTE-bound one.
     *
     * ⚠ THE BYTE-BOUND CASE IS STILL DISCOVERED DURING THE RUN, NOT BEFORE IT, and that residue is
     * honest rather than overlooked. `MAX_PART_BYTES` can close a part early, so a day of 10,000
     * audit rows averaging 80 KB reaches the part cap at a tenth of the row budget — and there is no
     * cheap query that returns the serialised size of a day's rows. Refusing on a size ESTIMATE was
     * rejected for the reason above: an estimate that is wrong in the refusing direction loses
     * evidence. What this does guarantee is that such a day stops at the cap instead of running away,
     * and that the message says which budget actually bound it, so an operator does not raise
     * `MAX_PARTS_PER_DAY` when the constant in their way was `MAX_PART_BYTES`.
     */
    const remainingRows = total - rows;
    const remainingParts = MAX_PARTS_PER_DAY - parts.length;
    if (remainingRows > remainingParts * ROWS_PER_PART) {
      // Parts that closed early held fewer than ROWS_PER_PART rows, which only MAX_PART_BYTES does.
      const boundByBytes = parts.length > 0 && rows < parts.length * ROWS_PER_PART;
      throw new Error(
        boundByBytes
          ? `${source.table} on ${day} exceeded MAX_PART_BYTES across ${MAX_PARTS_PER_DAY} part(s) with ` +
            `${remainingRows} of ${total} row(s) still unwritten — its rows are large enough that parts ` +
            "are closing on the byte ceiling rather than on the row count, so raising MAX_PARTS_PER_DAY " +
            "alone will not help. Raise MAX_PART_BYTES (and this route's maxDuration) in " +
            "lib/logArchive.ts, or archive the day by hand — it will fail on every run until one of " +
            `those happens. ${parts.length} part(s) were written and are orphaned until then.`
          : `${source.table} holds ${total} row(s) on ${day}, more than the ` +
            `${MAX_PARTS_PER_DAY * ROWS_PER_PART} one invocation can archive. Raise MAX_PARTS_PER_DAY in ` +
            "lib/logArchive.ts and give this route a longer maxDuration, or archive the day by hand — " +
            "it will fail on every run until one of those happens. NOTHING WAS UPLOADED FOR THIS DAY, " +
            "so the refusal costs one count query per run and no storage traffic."
      );
    }

    const page = await source.page({ from: start, to: end, skip: offset, take: ROWS_PER_PART });
    if (page.length === 0) break;

    /*
     * ⚠ THE BACKSTOP, FOR THE ONE CASE THE GUARD ABOVE CANNOT SEE: `count` DISAGREEING WITH `page`.
     *
     * The guard is arithmetic over `total`, so it is only as true as `total` is. A day is closed and
     * `DAY_CLOSE_MARGIN_MS` exists precisely so no writer is still targeting it — but that is a
     * margin, not a proof, and if a row did land between the count and the pages the guard would
     * quietly stop firing and this loop would upload parts until the function was killed. So the cap
     * is also asserted here, AFTER the emptiness break, where it cannot misfire on a day that holds
     * exactly `MAX_PARTS_PER_DAY * ROWS_PER_PART` rows and has just finished writing the last of them.
     */
    if (parts.length >= MAX_PARTS_PER_DAY) {
      throw new Error(
        `${source.table} on ${day} still has rows after ${MAX_PARTS_PER_DAY} part(s), although ` +
          `source.count() reported only ${total}. Either a row was written into a day that was already ` +
          "closed — check DAY_CLOSE_MARGIN_MS against the clock skew between this function and " +
          "Postgres — or count() and page() are not selecting the same window."
      );
    }

    const lines: string[] = [];
    let partBytes = 0;
    for (const row of page) {
      const line = JSON.stringify(row);
      lines.push(line);
      partBytes += Buffer.byteLength(line, "utf8") + 1;
      if (partBytes >= MAX_PART_BYTES) break;
    }

    /*
     * ⚠ THE ROWS ARE COPIED VERBATIM. Nothing is redacted here, and that is deliberate.
     *
     * lib/audit.ts redacts by name AT WRITE TIME (`passwordHash`, `twoFactorSecret`,
     * `refreshTokenHash`, `secretAccessKey`, …), so what is in the table is already what may be
     * kept. An archiver that redacted a second time would produce an archive that DISAGREES with
     * the database — two records of the same event, and no way to say which one CIC was shown.
     * Redaction is the writer's job; this is a copier.
     *
     * The trailing newline is not decoration. A line-oriented reader that concatenates two parts
     * without it silently joins the last row of one to the first row of the next.
     */
    const body = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    const key = partKey(source.name, day, parts.length + 1);

    await putObject({
      key,
      body,
      contentType: NDJSON_CONTENT_TYPE,
      cacheControl: ARCHIVE_CACHE_CONTROL
    });

    parts.push(key);
    rows += lines.length;
    bytes += body.byteLength;
    offset += lines.length;
  }

  const manifest: LogArchiveManifest = {
    schemaVersion: 1,
    job: "logs-archive",
    source: source.name,
    table: source.table,
    timestampColumn: source.timestampColumn,
    day,
    from: start.toISOString(),
    to: end.toISOString(),
    rows,
    bytes,
    parts,
    format: NDJSON_CONTENT_TYPE,
    archivedAt: new Date().toISOString(),
    retentionFloorDays: LOG_RETENTION_FLOOR_DAYS
  };

  const key = manifestKey(source.name, day);
  await putObject({
    key,
    body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    contentType: "application/json",
    cacheControl: ARCHIVE_CACHE_CONTROL
  });

  return { rows, bytes, parts: parts.length, manifestKey: key };
}
