import "server-only";
// `Prisma` is imported as a VALUE, not just a type: `Prisma.JsonNull` is a runtime sentinel. A
// nullable Json column cannot be set with a plain `null` — Prisma rejects it, because `null` is
// ambiguous between "JSON null" and "SQL NULL" and it refuses to guess.
import { Prisma, type AuditAction } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/current-user";

/**
 * The audit trail and the revision history.
 *
 * ONE RULE: **the log entry and the change it describes are written in the SAME transaction.** A log
 * that can exist without the change (or a change without the log) is a log nobody can trust during
 * an incident, which is the only time anybody reads it. Every helper here therefore either takes a
 * transaction client or opens one.
 *
 * `before` and `after` hold the FULL serialised entity rather than a diff. A diff computed at write
 * time is only as good as the differ that produced it, and a rollback needs the whole prior state
 * anyway — "restore version 4" reads `after` from version 4 and writes it back.
 */

export type TxClient = Prisma.TransactionClient;

/** The subset of a request an audit entry needs. Assembled once per route. */
export interface AuditContext {
  actor: Pick<SessionUser, "id" | "email"> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Strip values that must never reach the audit log.
 *
 * Password hashes, TOTP secrets and recovery codes are removed by NAME, recursively. An audit log is
 * read by more people than the users table is, and it is exported; a hash that leaks into it has
 * escaped every control the users table has.
 */
const REDACTED_KEYS = new Set([
  "passwordHash",
  "password",
  "twoFactorSecret",
  "twoFactorRecoveryCodes",
  "refreshTokenHash",
  "secretAccessKey",
  "accessKeyId"
]);

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key) ? "[redacted]" : redact(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Redact, then coerce to something a nullable Json column accepts.
 *
 * `Prisma.JsonNull` writes a JSON `null` into the column; a bare `null` is a TYPE ERROR in Prisma
 * because it cannot tell "the JSON value null" from "SQL NULL". Every write of a Json field in this
 * codebase goes through here so that distinction is made in exactly one place.
 */
function toJsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const redacted = redact(value);
  if (redacted === undefined) return Prisma.JsonNull;
  return redacted as Prisma.InputJsonValue;
}

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  /** A human handle — a title, a name, an email. Denormalised so a purged row still reads sensibly. */
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Write an audit entry on an existing transaction. Prefer this — see the rule at the top. */
export async function writeAudit(
  tx: TxClient,
  context: AuditContext,
  input: AuditInput
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: context.actor?.id ?? null,
      actorEmail: context.actor?.email ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      entityLabel: input.entityLabel ?? null,
      before: toJsonColumn(input.before),
      after: toJsonColumn(input.after),
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent?.slice(0, 512) ?? null
    }
  });
}

/**
 * Write an audit entry OUTSIDE a transaction.
 *
 * For events with no row to pair with — a sign-in, a failed sign-in, a sign-out. Deliberately does
 * NOT throw: a login that succeeded must not be reported as failed because the audit insert hit a
 * constraint. The failure is logged to the server console instead, where an operator will see it.
 */
export async function recordEvent(context: AuditContext, input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: context.actor?.id ?? null,
        actorEmail: context.actor?.email ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        entityLabel: input.entityLabel ?? null,
        before: toJsonColumn(input.before),
        after: toJsonColumn(input.after),
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent?.slice(0, 512) ?? null
      }
    });
  } catch (error) {
    console.error("[audit] could not record event", input.action, input.entityType, error);
  }
}

/**
 * Append a revision.
 *
 * The version number is computed INSIDE the transaction with a `max` read, not by counting rows:
 * counting is wrong the moment a revision is ever pruned, and two concurrent saves would compute the
 * same count. The unique index on (entityType, entityId, version) is the backstop — a genuine race
 * fails the insert rather than silently overwriting version 7.
 */
export async function writeRevision(
  tx: TxClient,
  input: {
    entityType: string;
    entityId: string;
    data: unknown;
    summary?: string | null;
    authorId?: string | null;
  }
): Promise<number> {
  const latest = await tx.revision.aggregate({
    where: { entityType: input.entityType, entityId: input.entityId },
    _max: { version: true }
  });
  const version = (latest._max.version ?? 0) + 1;

  await tx.revision.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      version,
      data: (redact(input.data) ?? {}) as Prisma.InputJsonValue,
      summary: input.summary ?? null,
      authorId: input.authorId ?? null
    }
  });

  return version;
}

/**
 * The standard "save an entity" wrapper: mutate, snapshot a revision, log — atomically.
 *
 * Returns whatever the mutation returned, so a call site reads as one statement. Anything that
 * throws inside rolls back all three, which is the property the whole module exists to provide.
 */
export async function mutateWithHistory<T>(
  context: AuditContext,
  input: {
    action: AuditAction;
    entityType: string;
    entityLabel?: string | null;
    before?: unknown;
    /** Set false for a mutation that should be logged but not versioned (a delete, a reorder). */
    revise?: boolean;
    summary?: string | null;
  },
  mutate: (tx: TxClient) => Promise<{ id: string } & Record<string, unknown>>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await mutate(tx);

    if (input.revise !== false) {
      await writeRevision(tx, {
        entityType: input.entityType,
        entityId: result.id,
        data: result,
        summary: input.summary ?? null,
        authorId: context.actor?.id ?? null
      });
    }

    await writeAudit(tx, context, {
      action: input.action,
      entityType: input.entityType,
      entityId: result.id,
      entityLabel: input.entityLabel ?? null,
      before: input.before,
      after: result
    });

    return result as T;
  });
}

/** The revision list for an entity, newest first. `data` is omitted — a history list does not need it. */
export async function listRevisions(entityType: string, entityId: string, take = 50) {
  return prisma.revision.findMany({
    where: { entityType, entityId },
    orderBy: { version: "desc" },
    take,
    select: {
      id: true,
      version: true,
      summary: true,
      createdAt: true,
      author: { select: { id: true, name: true, email: true } }
    }
  });
}

export async function getRevision(entityType: string, entityId: string, version: number) {
  return prisma.revision.findUnique({
    where: { entityType_entityId_version: { entityType, entityId, version } }
  });
}
