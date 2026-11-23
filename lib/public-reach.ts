import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { ContentStatus } from "@prisma/client";

import { isLive } from "@/lib/content";

/**
 * Did this request change anything a visitor can see? Recorded while the request runs, read by
 * `route()` (lib/api.ts) when it decides whether to mark the public site stale (lib/public-refresh.ts).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. The studio autosaves a DRAFT about four seconds after the last keystroke, through
 * the same routes that save live records — so the route alone cannot tell "a draft was saved" from "a
 * live page changed", and treating every save as public marked the whole site stale every four seconds
 * while anybody was writing. Every visitor then got a fresh render instead of the cached page, for
 * nothing: a draft is on no public page.
 *
 * The facts are already in hand at the one place most saves pass through: `mutateWithHistory`
 * (lib/audit.ts) holds the record before and after, and `isLive()` (lib/content.ts) is the site's own
 * definition of public. A save whose record was not live before AND is not live after changed nothing
 * a visitor can see. A save that publishes, withdraws or edits a live record did.
 *
 * ⚠ ONLY A PROVEN "PRIVATE" STANDS THE REFRESH DOWN. A record without a status (settings, menus,
 * media), a partial select that left out a field the verdict needs, or a write that never went through
 * `mutateWithHistory` all count as UNKNOWN, and unknown refreshes. The cost of a wrong "unknown" is a
 * wasted re-render; the cost of a wrong "private" is an edit that silently does not appear — which is
 * the complaint the whole mechanism exists to end.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export type PublicReach = "public" | "private" | "unknown";

interface ReachScope {
  /** Verdicts recorded by `mutateWithHistory`, one per save in this request. */
  verdicts: PublicReach[];
  /** Set by a route that knows better than the rows it saved (page blocks: see `declarePublicReach`). */
  declared: boolean | null;
}

const scopes = new AsyncLocalStorage<ReachScope>();

/** Run a request handler with its own record of what it reached. Used by `route()` only. */
export function runWithPublicReach<T>(fn: () => T): { result: T; scope: ReachScope } {
  const scope: ReachScope = { verdicts: [], declared: null };
  return { result: scopes.run(scope, fn), scope };
}

/**
 * Should a successful write that ran under this scope mark the public site stale?
 *
 * A route's declaration wins. Otherwise: refresh unless at least one save was recorded and EVERY save
 * was proven private. No record at all means the write went some other way, which is unknown.
 */
export function scopeReachesPublic(scope: ReachScope): boolean {
  if (scope.declared !== null) return scope.declared;
  if (scope.verdicts.length === 0) return true;
  return scope.verdicts.some((verdict) => verdict !== "private");
}

/** Record one save's verdict. A no-op outside a request scope (a script, a seed, a cron). */
export function notePublicReach(verdict: PublicReach): void {
  scopes.getStore()?.verdicts.push(verdict);
}

/**
 * For a route whose rows carry no status of their own but belong to a record that does: a page's
 * BLOCKS are public exactly when their page is live, and the page builder autosaves blocks of draft
 * pages constantly. Several declarations in one request combine: any `true` wins.
 */
export function declarePublicReach(reachesPublic: boolean): void {
  const scope = scopes.getStore();
  if (!scope) return;
  scope.declared = (scope.declared ?? false) || reachesPublic;
}

const STATUSES: ReadonlySet<string> = new Set(["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"]);

/** A date-ish column as a Date: Prisma rows carry Dates, a revision's JSON carries strings. */
function asDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/**
 * Is this row live, as far as it can tell? `null` when it cannot say.
 *
 * It cannot say when the row has no publication status at all, or when the status needs a date the
 * row does not carry — a SCHEDULED row selected without `publishAt` may be live already, and guessing
 * "not yet" would be the dangerous direction. A missing `unpublishAt` or `deletedAt` reads as absent,
 * which can only make a row look MORE live, the safe direction.
 */
export function rowIsLive(row: unknown, now: Date = new Date()): boolean | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;

  const publishAt = asDate(record.publishAt);
  if (status === "SCHEDULED" && publishAt === undefined) return null;

  return isLive(
    {
      status: status as ContentStatus,
      publishAt: publishAt ?? null,
      unpublishAt: asDate(record.unpublishAt) ?? null,
      deletedAt: asDate(record.deletedAt) ?? null
    },
    now
  );
}

/**
 * The verdict for one save. A CREATE has no "before", so only the new row decides; any other action
 * needs both sides, because a draft that is being PUBLISHED is private before and public after.
 */
export function saveReach(action: string, before: unknown, after: unknown, now: Date = new Date()): PublicReach {
  const liveAfter = rowIsLive(after, now);
  if (liveAfter === null) return "unknown";
  if (liveAfter) return "public";

  if (action === "CREATE") return "private";

  const liveBefore = rowIsLive(before, now);
  if (liveBefore === null) return "unknown";
  return liveBefore ? "public" : "private";
}
