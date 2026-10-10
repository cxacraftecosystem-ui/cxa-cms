import "server-only";
import type { Prisma } from "@prisma/client";
import { auditActorEmailSearch } from "@/lib/audit-actor";
import { auditEmailHashCandidates, auditIpSearchClauses } from "@/lib/audit-ip";
import { describesAnAccount, lockHolderIds, type AccountRef, type AccountRowColumns } from "@/lib/audit-subject";
import { prisma } from "@/lib/db";

/**
 * The database half of lib/audit-subject.ts: the joins that name the account an audit row is about by
 * its current name, and the searches that find account rows by address.
 *
 * Rows carry the address themselves again (owner decision, 2026-10-10 — docs/AUDIT-PRIVACY.md), so an
 * ordinary `entityLabel` / `actorEmail` search finds them; these joins exist for the rows written
 * between the 2026-10-10 deploy and that decision, which hold only an id and a fingerprint.
 */

/** How many accounts a text search may resolve to. A broader search is a filter problem, not a join. */
const ACCOUNT_SEARCH_LIMIT = 50;

/**
 * `entityId → account` for every account row in `rows`, in one query. Soft-deleted accounts are
 * included (history, not the studio); a hard-deleted one is simply absent, and the row's own label
 * names it.
 */
export async function accountsForAuditRows(
  rows: readonly AccountRowColumns[]
): Promise<Map<string, AccountRef>> {
  const ids = [
    ...new Set(rows.flatMap((row) => (describesAnAccount(row) && row.entityId ? [row.entityId] : [])))
  ];
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true }
  });
  return new Map(users.map((user) => [user.id, { name: user.name, email: user.email }]));
}

/**
 * The extra clauses that let a text search find ACCOUNT rows by address when the row itself does not
 * hold one: rows about an account whose current address contains `q`, and — when `q` is a whole
 * address — refused sign-ins whose typed address fingerprints to it under any search key.
 */
export async function auditAccountSearch(q: string): Promise<Prisma.AuditLogWhereInput[]> {
  const term = q.trim();
  if (term.length === 0) return [];
  const clauses: Prisma.AuditLogWhereInput[] = [];

  const users = await prisma.user.findMany({
    where: { email: { contains: term, mode: "insensitive" } },
    select: { id: true },
    take: ACCOUNT_SEARCH_LIMIT
  });
  if (users.length > 0) {
    clauses.push({ entityType: "User", entityId: { in: users.map((user) => user.id) } });
  }

  const fingerprints = term.includes("@") ? auditEmailHashCandidates(term) : [];
  for (const candidate of fingerprints) {
    clauses.push({ after: { path: ["emailHash"], equals: candidate } });
  }
  return clauses;
}

/**
 * `account id → account` for every lock holder named in `rows` (`lockHolderIds`), in one query, for
 * `withLockHolderNames`. Soft-deleted accounts are included; a hard-deleted one reads as the address
 * recorded on the row.
 */
export async function lockHoldersForAuditRows(
  rows: readonly { before?: unknown; after?: unknown }[]
): Promise<Map<string, AccountRef>> {
  const ids = lockHolderIds(rows);
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true }
  });
  return new Map(users.map((user) => [user.id, { name: user.name, email: user.email }]));
}

/**
 * Every clause of the audit screens' free-text search (the studio page and /api/studio/audit share it):
 * the label and entity id, the actor's address (recorded, or joined), the account clauses above, and —
 * when `q` is a whole IP address — the rows from that address, exactly (`auditIpSearchClauses`).
 */
export async function auditTextSearch(q: string): Promise<Prisma.AuditLogWhereInput[]> {
  return [
    { entityLabel: { contains: q, mode: "insensitive" } },
    { entityId: { contains: q, mode: "insensitive" } },
    ...auditActorEmailSearch(q),
    ...auditIpSearchClauses(q),
    ...(await auditAccountSearch(q))
  ];
}
