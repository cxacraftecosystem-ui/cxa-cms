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
 */

export const DELETED_ACTOR_LABEL = "Deleted user";

export interface AuditActorColumns {
  actor: { name?: string | null; email: string } | null;
  /** The actor's address when the row was written. Null on system rows and on the few 2026-10-10 rows. */
  actorEmail?: string | null;
}

/** The actor's address: as recorded on the row, else the joined account's current one. */
export function auditActorEmail(row: AuditActorColumns): string | null {
  return row.actorEmail ?? row.actor?.email ?? null;
}

/** A name to print: the account's name, else its address, else `fallback`. */
export function auditActorName(row: AuditActorColumns, fallback: string = DELETED_ACTOR_LABEL): string {
  return row.actor?.name?.trim() || auditActorEmail(row) || fallback;
}

/** The name AND the address — `Asha Rao <asha@…>` — for the audit screen; `fallback` when neither is known. */
export function auditActorLabel(row: AuditActorColumns, fallback: string = DELETED_ACTOR_LABEL): string {
  const name = row.actor?.name?.trim();
  const email = auditActorEmail(row);
  if (name && email && name !== email) return `${name} <${email}>`;
  return name || email || fallback;
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
