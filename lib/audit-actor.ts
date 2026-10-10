import type { Prisma } from "@prisma/client";

/**
 * Naming the person behind an audit row.
 *
 * Every row records `actorId` AND `actorEmail` — the actor's address at the time (owner decision,
 * 2026-10-10: docs/AUDIT-PRIVACY.md). Screens join `actor` for the account's current name; a
 * soft-deleted account still joins, because `deletedAt` hides a user from the studio, not from history.
 * When the join finds nothing the account was hard-deleted (`onDelete: SetNull`), and the recorded
 * `actorEmail` names it instead.
 *
 * Rows written between the 2026-10-10 deploy and its reversal carry no `actorEmail`; for those the
 * joined address is used, and "Deleted user" only when neither exists.
 *
 * ⚠ ROWS NOBODY WROTE ARE NAMED "Scheduled job", NOT "Somebody" OR "Deleted user". The cron routes
 * (app/api/cron/*) record with `{ actor: null }` and no request, so their rows carry no actor, no
 * address and no client IP — and both fallbacks above were wrong about them: "Deleted user" invents
 * an account that never existed, and "Somebody archived …" eight nights running reads as a person
 * doing something odd. See `isScheduledJobRow` for the rule and why it is that narrow.
 */

export const DELETED_ACTOR_LABEL = "Deleted user";

/** What a row written by a cron route is called, wherever an actor's name would be. */
export const SCHEDULED_JOB_LABEL = "Scheduled job";

/**
 * Entity types only the scheduled log archive writes (app/api/cron/logs-archive/route.ts):
 * `LogArchive` — a day archived, routine; `LogArchiveRun` — a night it archived nothing;
 * `LogArchiveGap` — a day about to leave the scan window unarchived.
 */
export const LOG_ARCHIVE_ENTITY_TYPES: readonly string[] = ["LogArchive", "LogArchiveRun", "LogArchiveGap"];

/** The two of those that report a PROBLEM rather than work done. */
export const LOG_ARCHIVE_PROBLEM_TYPES: readonly string[] = ["LogArchiveRun", "LogArchiveGap"];

/**
 * Actions a cron route writes with no actor: the scheduler's PUBLISH (app/api/cron/publish), the
 * purge's PURGE (app/api/cron/purge) and the archive's ARCHIVE. No anonymous PUBLIC writer uses any
 * of them — a refused sign-in is LOGIN_FAILED and an enquiry or an event registration is CREATE.
 */
const SCHEDULED_ACTIONS: readonly string[] = ["PUBLISH", "PURGE", "ARCHIVE"];

export interface AuditActorColumns {
  actor: { name?: string | null; email: string } | null;
  /** The actor's address when the row was written. Null on system rows and on the few 2026-10-10 rows. */
  actorEmail?: string | null;
  /*
   * The rest is needed only to recognise a scheduled job's row (`isScheduledJobRow`). A caller that
   * does not select them gets the person-shaped fallbacks, exactly as before.
   */
  actorId?: string | null;
  ipAddress?: string | null;
  ipHash?: string | null;
  action?: string;
  entityType?: string;
}

/**
 * Was this row written by a scheduled job rather than by a person?
 *
 * ALL of: no `actorId`, no joined account, no `actorEmail`, no client address (`ipAddress` or
 * `ipHash`) — and an entity type only the log archive writes, or an action only a cron writes without
 * an actor (`SCHEDULED_ACTIONS`).
 *
 * WHY BOTH HALVES. "No actor" alone also matches the ANONYMOUS PUBLIC rows — a refused sign-in, a
 * contact enquiry, an event registration — whose screens name the address that was TYPED, from the
 * row's label; those must keep that wording, and they always carry the client's IP besides. And a
 * PUBLISH by a person whose account was later hard-deleted has no `actorId` either, but it has the
 * `actorEmail` and the IP the studio request recorded. Only a cron row has none of them.
 *
 * No separate "System" label: every actor-less writer outside the public routes is a cron today. A
 * new one that is not should get its own rule here rather than borrow this one.
 */
export function isScheduledJobRow(row: AuditActorColumns): boolean {
  if (row.action === undefined || row.entityType === undefined) return false;
  if (row.actorId || row.actor || row.actorEmail || row.ipAddress || row.ipHash) return false;
  return LOG_ARCHIVE_ENTITY_TYPES.includes(row.entityType) || SCHEDULED_ACTIONS.includes(row.action);
}

/** The actor's address: as recorded on the row, else the joined account's current one. */
export function auditActorEmail(row: AuditActorColumns): string | null {
  return row.actorEmail ?? row.actor?.email ?? null;
}

/**
 * A name to print: the account's name, else its address, else "Scheduled job" for a cron's row, else
 * `fallback`.
 */
export function auditActorName(row: AuditActorColumns, fallback: string = DELETED_ACTOR_LABEL): string {
  return (
    row.actor?.name?.trim() || auditActorEmail(row) || (isScheduledJobRow(row) ? SCHEDULED_JOB_LABEL : fallback)
  );
}

/** The name AND the address — `Asha Rao <asha@…>` — for the audit screen; `fallback` when neither is known. */
export function auditActorLabel(row: AuditActorColumns, fallback: string = DELETED_ACTOR_LABEL): string {
  const name = row.actor?.name?.trim();
  const email = auditActorEmail(row);
  if (name && email && name !== email) return `${name} <${email}>`;
  return name || email || (isScheduledJobRow(row) ? SCHEDULED_JOB_LABEL : fallback);
}

/**
 * The search clause for "rows by somebody whose address contains q": the recorded column, and the join
 * for the rows that do not have one.
 */
export function auditActorEmailSearch(q: string): Prisma.AuditLogWhereInput[] {
  return [
    { actorEmail: { contains: q, mode: "insensitive" } },
    { actor: { is: { email: { contains: q, mode: "insensitive" } } } }
  ];
}
