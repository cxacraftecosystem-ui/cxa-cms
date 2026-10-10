import type { Prisma } from "@prisma/client";

import {
  LOG_ARCHIVE_ENTITY_TYPES,
  LOG_ARCHIVE_PROBLEM_TYPES,
  isScheduledJobRow,
  type AuditActorColumns
} from "@/lib/audit-actor";

/**
 * What the dashboard's "Recent activity" panel shows, and what it lifts out of it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PANEL IS FOR WHAT PEOPLE DID. Before this, eight nights of the log archive refusing to write
 * filled all eight lines with "Somebody archived logs-archive archived nothing — destination_not_private",
 * and the one edit an administrator opened the dashboard to check was below the cap. So:
 *
 *   • ROUTINE SCHEDULED ROWS ARE LEFT OUT — `LogArchive`, one per source per archived day. They are
 *     bookkeeping about the log itself; the full audit log still has every one.
 *   • PROBLEMS ARE LIFTED OUT, NOT HIDDEN — `LogArchiveRun` (a night that archived nothing) and
 *     `LogArchiveGap` (a day about to become unarchivable) go to their own block above the panel,
 *     where they read as a warning instead of as somebody's activity. See `isScheduledProblem`.
 *   • IDENTICAL SCHEDULED ROWS COLLAPSE into one line with a count and the latest time — "×8, latest
 *     13 hours ago". Identical means the same action, entity type, entity id and label, ANYWHERE in
 *     the window rather than only when adjacent: a nightly refusal is interleaved with whatever people
 *     did that day, and collapsing only adjacent runs would leave one line per night.
 *
 * PEOPLE'S ROWS ARE NEVER COLLAPSED. Two identical edits by a person are two edits, and an anonymous
 * public row (a refused sign-in, an enquiry) is not a scheduled row — `isScheduledJobRow` says why.
 *
 * Nothing here changes what is STORED or what /studio/audit lists: that screen keeps every row.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The columns this module reads, on top of the ones `isScheduledJobRow` does. */
export interface ActivityRow extends AuditActorColumns {
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  createdAt: Date;
}

/** One line on screen: the newest row of its group, and how many rows the group stands for. */
export interface ActivityLine<T extends ActivityRow> {
  /** The NEWEST row in the group — its time is the "latest" a collapsed line shows. */
  entry: T;
  /** 1 for a single row. */
  count: number;
  /** The oldest row's time; equal to `entry.createdAt` when `count` is 1. */
  earliestAt: Date;
}

/** A scheduled row that is routine bookkeeping: left out of the panel entirely. */
export function isRoutineScheduledRow(row: ActivityRow): boolean {
  return (
    isScheduledJobRow(row) &&
    LOG_ARCHIVE_ENTITY_TYPES.includes(row.entityType) &&
    !LOG_ARCHIVE_PROBLEM_TYPES.includes(row.entityType)
  );
}

/** A scheduled row that reports a problem: shown in the dashboard's "Scheduled jobs" block. */
export function isScheduledProblem(row: ActivityRow): boolean {
  return isScheduledJobRow(row) && LOG_ARCHIVE_PROBLEM_TYPES.includes(row.entityType);
}

function groupKey(row: ActivityRow): string {
  return JSON.stringify([row.action, row.entityType, row.entityId, row.entityLabel]);
}

/**
 * Rows (newest first) → lines (newest first). Scheduled rows with the same key merge into the line of
 * the newest of them; every other row is a line of its own.
 */
export function collapseScheduledRows<T extends ActivityRow>(rows: readonly T[]): ActivityLine<T>[] {
  const lines: ActivityLine<T>[] = [];
  const byKey = new Map<string, ActivityLine<T>>();

  for (const row of rows) {
    if (!isScheduledJobRow(row)) {
      lines.push({ entry: row, count: 1, earliestAt: row.createdAt });
      continue;
    }

    const key = groupKey(row);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (row.createdAt < existing.earliestAt) existing.earliestAt = row.createdAt;
      // Rows arrive newest first, but a caller that did not sort must still get the newest as `entry`.
      if (row.createdAt > existing.entry.createdAt) existing.entry = row;
      continue;
    }

    const line: ActivityLine<T> = { entry: row, count: 1, earliestAt: row.createdAt };
    byKey.set(key, line);
    lines.push(line);
  }

  return lines;
}

/**
 * The panel's lines: routine and problem rows out, identical scheduled rows collapsed, at most
 * `limit` lines. `omitted` counts the routine rows left out, so the caption can say so.
 */
export function summariseRecentActivity<T extends ActivityRow>(
  rows: readonly T[],
  limit: number
): { lines: ActivityLine<T>[]; omitted: number; capped: boolean } {
  const kept = rows.filter((row) => !isRoutineScheduledRow(row) && !isScheduledProblem(row));
  const lines = collapseScheduledRows(kept);
  return {
    lines: lines.slice(0, limit),
    omitted: rows.length - kept.length,
    capped: lines.length > limit
  };
}

/**
 * The dashboard panel's query: everything except the log archive's own actor-less rows.
 *
 * Excluded in the DATABASE as well as by `summariseRecentActivity`, because a back-fill night writes one
 * `LogArchive` row per source per day, and reading a fixed number of rows and filtering afterwards would
 * let them crowd out the very activity the panel exists to show. Those entity types are written only by
 * the cron route, so "no actorId and no actorEmail" is a belt rather than the rule.
 */
export function recentActivityWhere(): Prisma.AuditLogWhereInput {
  return { NOT: { entityType: { in: [...LOG_ARCHIVE_ENTITY_TYPES] }, actorId: null, actorEmail: null } };
}

/** The "Scheduled jobs need attention" block's query: log-archive problems since `since`. */
export function scheduledProblemWhere(since: Date): Prisma.AuditLogWhereInput {
  return {
    entityType: { in: [...LOG_ARCHIVE_PROBLEM_TYPES] },
    actorId: null,
    actorEmail: null,
    createdAt: { gte: since }
  };
}

/** "×8" after a collapsed line; nothing after a single one. */
export function collapsedCount(count: number): string {
  return count > 1 ? ` ×${count}` : "";
}
