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
        : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { Prisma } from "@prisma/client";
