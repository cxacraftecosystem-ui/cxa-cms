import "server-only";
// `Prisma` is imported as a VALUE, not just a type: `Prisma.JsonNull` is a runtime sentinel. A
// nullable Json column cannot be set with a plain `null` — Prisma rejects it, because `null` is
// ambiguous between "JSON null" and "SQL NULL" and it refuses to guess.
import { Prisma, type AuditAction } from "@prisma/client";
import { ApiError } from "@/lib/api";
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
 * The Prisma failures that mean "the database did not get to it", not "the change was rejected".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS. `toErrorResponse` (lib/api.ts) treats anything that is not an `ApiError` as a BUG
 * and answers "Something went wrong on our side. The change was not saved." — deliberately, because
 * an unexpected error's message leaks table names and connection strings. But a transaction that ran
 * out of time is not a bug in this application and it is not a sentence anybody can act on: it sent
 * an editor whose only fault was a slow database hunting for a fault that did not exist, and it hid a
 * real, reproducible failure of the people board behind a shrug.
 *
 * So the handful of codes that mean "transient infrastructure" are translated by NAME into sentences
 * that say what happened and what to do. Everything else is left exactly as it was and still becomes
 * the generic 500 — this widens what the reader is told, never what a stranger can learn.
 *
 * EVERY ONE OF THESE IS SAFE TO PROMISE "NOTHING HAS BEEN CHANGED". They all abort the transaction
 * before it commits, and Postgres rolls back what was already issued inside it.
 *
 * The codes are read STRUCTURALLY, the way `prismaErrorCode` in lib/studio/crud.ts does, so this does
 * not depend on `instanceof` against a class that fails silently when two copies of the client are
 * resolved.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const TRANSIENT_WRITE_FAILURES: Record<string, { status: number; message: string }> = {
  // The interactive transaction outlived its window, or was already closed when a statement reached it.
  P2028: {
    status: 503,
    message:
      "The database took too long to answer, so nothing has been changed. This usually clears within a moment — try again."
  },
  // No connection could be taken from the pool in time.
  P2024: {
    status: 503,
    message:
      "The database was busy and this change never reached it, so nothing has been changed. Try again in a moment."
  },
  // Two writes touched the same rows at once and Postgres broke the tie.
  P2034: {
    status: 409,
    message:
      "Somebody else was saving at the same moment, so nothing has been changed. Try again — it should go through this time."
  },
  // The connection died mid-flight: unreachable, timed out, or closed by the server.
  P1001: {
    status: 503,
    message: "The database could not be reached, so nothing has been changed. Try again in a moment."
  },
  P1002: {
    status: 503,
    message: "The database did not answer in time, so nothing has been changed. Try again in a moment."
  },
  P1008: {
    status: 503,
    message: "The database did not answer in time, so nothing has been changed. Try again in a moment."
  },
  P1017: {
    status: 503,
    message:
      "The connection to the database closed while this was being saved, so nothing has been changed. Try again in a moment."
  }
};

/**
 * Translate a transient database failure into something the reader can act on; leave everything else
 * untouched, including the `ApiError`s a mutation callback throws on purpose.
 */
export function asWriteFailure(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  if (typeof error !== "object" || error === null) return error;

  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return error;

  const known = TRANSIENT_WRITE_FAILURES[code];
  if (!known) return error;

  // Still logged: "the database was slow" is a fact an operator wants to see accumulating, and the
  // reader's sentence deliberately carries none of the detail.
  console.error(`[audit] transient write failure ${code}`, error);
  return new ApiError(known.status, known.message, { code: "write_failed", cause: error });
}

/**
 * The standard "save an entity" wrapper: mutate, snapshot a revision, log — atomically.
 *
 * Returns whatever the mutation returned, so a call site reads as one statement. Anything that
 * throws inside rolls back all three, which is the property the whole module exists to provide.
 *
 * A transient database failure is translated on the way out by `asWriteFailure`; see the note there
 * for why a timeout must not reach an editor as "something went wrong on our side".
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
  try {
    return await prisma.$transaction(async (tx) => {
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
  } catch (error) {
    // `await` above rather than a bare `return`, so a rejection lands in THIS catch rather than in the
    // caller's — a returned promise would leave nothing here to translate.
    throw asWriteFailure(error);
  }
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
