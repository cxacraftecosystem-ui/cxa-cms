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
     * Both are generous against localhost. Production's database is Supabase Postgres in Mumbai
     * (`ap-south-1`), reached through its transaction pooler, with the functions pinned beside it
     * (`regions: ["bom1"]` in vercel.json, 2026-10-09) — so a warm round trip is short, and the
     * compute does not scale to zero, so nothing waits for a database to wake. The defaults are
     * still too tight, for reasons that did not move with the region:
     *
     *  - a function copy that has just started holds no connection yet, so its first transaction
     *    waits inside `maxWait` while one is opened through the pooler (TCP, TLS, the pooler's own
     *    authentication);
     *  - under Fluid compute one copy serves several requests at once through one pool of
     *    `connection_limit` connections (docs/DEPLOYMENT.md §1.4), so a burst of saves queues for a
     *    free one — and the pooler itself queues once every server connection it has is lent out;
     *  - a function that runs away from Mumbai pays a long round trip per statement: a deployment
     *    that loses the region pin falls back to the project's default, Washington (`iad1`), where a
     *    transaction holding a handful of statements can spend the whole `timeout` on round trips
     *    alone (docs/DEPLOYMENT.md §1.6 has the measurements).
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
