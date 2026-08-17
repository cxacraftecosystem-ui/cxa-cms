import "server-only";
import { PrismaClient } from "@prisma/client";

/**
 * The Prisma singleton.
 *
 * Next.js's dev server re-evaluates modules on every hot reload. A `new PrismaClient()` at module
 * scope therefore opens a fresh connection pool per reload and exhausts the database's connection
 * limit within a few minutes of editing — the classic symptom being "too many clients already" on a
 * machine nobody is load-testing. Stashing the instance on `globalThis` is the documented fix.
 *
 * In production the module is evaluated once, so the global is simply unused.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
    /**
     * ⚠ PRISMA'S DEFAULTS ARE SIZED FOR A DATABASE ON THE SAME MACHINE, AND THIS ONE IS NOT.
     *
     * An interactive transaction — which is every write in this application, because they all go
     * through `mutateWithHistory` (lib/audit.ts) — gets 2s to acquire a connection and 5s to finish.
     * Both are generous against localhost and neither is generous against a managed Postgres several
     * hundred milliseconds away that is allowed to fall asleep when nobody is using it: waking it can
     * spend the whole `maxWait`, and a transaction holding a handful of statements can spend the whole
     * `timeout` on round trips alone.
     *
     * When either runs out Prisma raises `P2028`, which is not an `ApiError`, so before
     * `asWriteFailure` (lib/audit.ts) existed the only thing an editor was ever told was "Something
     * went wrong on our side" — for a save that was merely slow. These numbers are the first half of
     * that fix and the translation is the second; neither replaces keeping the work inside a
     * transaction small, which is why `app/api/studio/people/reorder/route.ts` renumbers a whole group
     * in one statement rather than one per profile.
     *
     * They are still bounded. A transaction holds its row locks for as long as it runs, so "wait
     * longer" is not free and these are not a licence to put slow work inside one.
     */
    transactionOptions: {
      maxWait: 10_000,
      timeout: 20_000
    }
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { Prisma } from "@prisma/client";
