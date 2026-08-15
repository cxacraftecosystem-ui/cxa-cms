import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { recordEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { canManageSettings } from "@/lib/permissions";
import { SEARCH_ENTITY_TYPES, reindexAll, searchTypeLabel } from "@/lib/search/index";
import { buildAuditContext } from "@/lib/studio/crud";

/**
 * Rebuild the whole search index.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ TWO REBUILDS MUST NEVER OVERLAP, AND THE REASON IS SUBTLE ENOUGH TO BE WORTH SPELLING OUT.
 *
 * `reindexAll()` finishes with a sweep: it deletes every index row whose `updatedAt` is older than the
 * instant the run started, because Prisma's `@updatedAt` bumps on every upsert and anything the run touched
 * therefore has a newer timestamp. That is exactly right for one run, and destructive for two.
 *
 * Run A starts at 10:00 and is half way through. Run B starts at 10:02 and finishes first. B's sweep deletes
 * everything with `updatedAt < 10:02` — which includes every row A wrote between 10:00 and 10:02. The index
 * is now missing those records, nothing failed, and both runs report success.
 *
 * So a second request while a rebuild is in flight is REFUSED with a 409, not queued. The guard lives on
 * `globalThis` for the same reason the Prisma client does: the dev server re-evaluates modules on every hot
 * reload, and a module-scoped flag would clear itself on every file save — which is precisely when somebody
 * is most likely to be testing this.
 *
 * ⚠ THIS IS A SINGLE-PROCESS GUARD, AND THE ANSWER SAYS SO. Two instances behind a load balancer have two
 * `globalThis` objects and cannot see each other's flag. A database lock would be the real fix; until there
 * is one, the honest thing is to name the limitation rather than let an operator believe it is impossible.
 *
 * BOUNDED, AND IT REPORTS WHAT IT DID. `reindexAll()` reads a hundred rows at a time with keyset pagination
 * and commits each batch in its own transaction, so no single statement holds a write lock for the length of
 * the rebuild. The answer carries the per-type counts, the total and how long it took — a maintenance action
 * that says only "done" leaves an operator with no way to tell a rebuild of six thousand records from a
 * rebuild of six.
 *
 * `recordEvent`, NOT `mutateWithHistory`: there is no row whose change this describes. A rebuild touches
 * every index row and none of them is the entity — the same choice `app/api/cron/purge` makes, and for the
 * same reason.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `canManageSettings` — administrator. A rebuild is a maintenance action on the whole corpus, and while it
 * runs the index is briefly a mixture of old and new rows.
 */

export const dynamic = "force-dynamic";

/**
 * A generous ceiling for a long job.
 *
 * The rebuild is batched, so a large corpus is many short transactions rather than one long one — but the
 * REQUEST still has to survive all of them. Five minutes is far more than any Centre-sized corpus needs and
 * short enough that a stuck run is reported rather than hanging.
 */
export const maxDuration = 300;

interface ReindexState {
  /** The instant the current run began, or null when nothing is running. */
  startedAt: number | null;
}

const globalForReindex = globalThis as unknown as { __cxaReindexState?: ReindexState };
const state: ReindexState = globalForReindex.__cxaReindexState ?? { startedAt: null };
globalForReindex.__cxaReindexState = state;

/**
 * How long a run may hold the flag before a new request is allowed through.
 *
 * Without this a process killed mid-rebuild — a deploy, an out-of-memory — would leave the flag set for the
 * life of the instance and no rebuild could ever be started again. Comfortably longer than `maxDuration`, so
 * it can only ever release a flag whose owner is genuinely gone.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageSettings,
    "Rebuilding the search index needs administrator access."
  );

  const now = Date.now();
  if (state.startedAt !== null && now - state.startedAt < STALE_AFTER_MS) {
    const runningFor = Math.round((now - state.startedAt) / 1000);
    throw new ApiError(
      409,
      `A rebuild has been running for ${runningFor} ${runningFor === 1 ? "second" : "seconds"} and has not ` +
        "finished. Wait for it: two rebuilds at once would leave the index missing whatever the first one had " +
        "already written. Nothing has been changed.",
      { code: "conflict" }
    );
  }

  state.startedAt = now;

  const context = buildAuditContext(request, user);

  /** What was there before, so the answer can say whether the rebuild found MORE or FEWER records. */
  const documentsBefore = await prisma.searchDocument.count();

  try {
    const result = await reindexAll();
    const elapsedMs = Date.now() - now;

    /**
     * Every known type appears, including the ones that produced nothing.
     *
     * A `byType` that omitted the empty ones would be indistinguishable from a rebuild that skipped them —
     * and "why are there no crafts in the search box" is exactly the question this report has to answer.
     */
    const byType = SEARCH_ENTITY_TYPES.map((type) => ({
      type,
      label: searchTypeLabel(type),
      indexed: result.byType[type] ?? 0
    }));

    await recordEvent(context, {
      action: "UPDATE",
      entityType: "SearchDocument",
      entityLabel: "The search index was rebuilt",
      before: { documents: documentsBefore },
      after: { documents: result.indexed, byType: result.byType, elapsedMs }
    });

    const stale = documentsBefore - result.indexed;

    return ok({
      indexed: result.indexed,
      byType,
      documentsBefore,
      /**
       * How many rows the closing sweep removed: index entries for records that have since been deleted, or
       * for entity types a previous release carried and this one does not. A positive number is normal after
       * a period without a rebuild; a large one is worth a second look.
       */
      staleRemoved: stale > 0 ? stale : 0,
      elapsedMs,
      /** ⚠ Named rather than implied. See the header. */
      singleProcessGuardOnly: true,
      message:
        `${result.indexed} ${result.indexed === 1 ? "record is" : "records are"} in the search index, rebuilt in ` +
        `${(elapsedMs / 1000).toFixed(1)} seconds.` +
        (stale > 0
          ? ` ${stale} old ${stale === 1 ? "entry" : "entries"} were removed — those records have been deleted ` +
            "since the last rebuild."
          : "") +
        (stale < 0
          ? ` ${Math.abs(stale)} more ${Math.abs(stale) === 1 ? "record" : "records"} are indexed than before.`
          : "") +
        " Drafts are indexed too, marked as not published, so the studio can find them and the public search " +
        "cannot."
    });
  } catch (thrown) {
    /**
     * A failure part-way through leaves the PREVIOUS index in place: `reindexAll()` throws before its sweep,
     * so a half-finished rebuild does not delete most of the corpus. Worth saying, because the natural fear
     * on seeing this error is that search is now empty.
     */
    console.error("[reindex] the rebuild failed", thrown);
    throw new ApiError(
      500,
      "The rebuild stopped part-way through and the previous index is still in place, so search is still " +
        "working — it may be missing recent changes. Try again; if it fails a second time, the server log names " +
        "the record it stopped on.",
      { code: "server_error", cause: thrown }
    );
  } finally {
    // ALWAYS released, including on the throw above. A flag left set by a failure would block every future
    // rebuild until the instance restarted.
    state.startedAt = null;
  }
});

/**
 * What the index holds now, without touching it.
 *
 * The counts a maintenance panel needs in order to decide whether a rebuild is worth starting: how many
 * documents there are per type, and how many of them are not public.
 */
export const GET = route(async () => {
  await requireCapability(
    canManageSettings,
    "The search index panel needs administrator access."
  );

  const [total, published] = await prisma.$transaction([
    prisma.searchDocument.count(),
    prisma.searchDocument.count({ where: { isPublished: true } })
  ]);

  /**
   * ⚠ Read on its own rather than inside the transaction above.
   *
   * `$transaction([…])` unifies the element types of its array, and a `groupBy`'s `_count` payload does not
   * survive the unification — it comes back as a union nothing can read. Read alone it is typed exactly.
   */
  const grouped = await prisma.searchDocument.groupBy({
    by: ["entityType"],
    orderBy: { entityType: "asc" },
    _count: { _all: true }
  });

  const counts = new Map<string, number>();
  for (const entry of grouped) counts.set(entry.entityType, entry._count._all);

  return ok({
    total,
    published,
    /** Drafts and retired work. Present in the index on purpose, so the studio's own search can find them. */
    notPublished: total - published,
    byType: SEARCH_ENTITY_TYPES.map((type) => ({
      type,
      label: searchTypeLabel(type),
      documents: counts.get(type) ?? 0
    })),
    /** A type in the table that this build does not know about — from an older release. Worth surfacing. */
    unknownTypes: [...counts.keys()].filter(
      (type) => !(SEARCH_ENTITY_TYPES as readonly string[]).includes(type)
    ),
    rebuildRunning: state.startedAt !== null && Date.now() - state.startedAt < STALE_AFTER_MS
  });
});
