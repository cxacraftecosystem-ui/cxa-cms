import type { Prisma } from "@prisma/client";

/**
 * Naming the person behind an audit row, now that the row no longer carries their address.
 *
 * New rows store `actorId` only (lib/audit.ts). Every screen joins `actor` and shows the CURRENT
 * address of that account — a soft-deleted account still joins, because `deletedAt` hides a user
 * from the studio, not from history. When the join finds nothing the account was hard-deleted
 * (`onDelete: SetNull`), and the row says so in words rather than going blank.
 *
 * `actorEmail` is consulted last, for rows written before the change (docs/AUDIT-PRIVACY.md). Nothing
 * writes it any more; it disappears entirely once the optional scrub is run.
 */

export const DELETED_ACTOR_LABEL = "Deleted user";

export interface AuditActorColumns {
  actor: { name?: string | null; email: string } | null;
  /** Legacy column — present on rows written before 2026-10, null on every row since. */
  actorEmail?: string | null;
}

/** The actor's address, from the join; the legacy column only for rows that predate it. */
export function auditActorEmail(row: AuditActorColumns): string | null {
  return row.actor?.email ?? row.actorEmail ?? null;
}

/** A name to print: the account's name, else its address, else `fallback`. */
export function auditActorName(row: AuditActorColumns, fallback: string = DELETED_ACTOR_LABEL): string {
  return row.actor?.name?.trim() || auditActorEmail(row) || fallback;
}

/**
 * The search clause for "rows by somebody whose address contains q": through the join for current
 * rows, and the legacy column for the rows that still have one.
 */
export function auditActorEmailSearch(q: string): Prisma.AuditLogWhereInput[] {
  return [
    { actor: { is: { email: { contains: q, mode: "insensitive" } } } },
    { actorEmail: { contains: q, mode: "insensitive" } }
  ];
}
