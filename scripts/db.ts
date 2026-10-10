import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { prismaAdapter } from "../lib/prisma-adapter";

/**
 * The database client for everything that runs under plain Node rather than inside Next: the seed, the
 * smoke test, the leak check and the maintenance scripts.
 *
 * ⚠ IMPORT THIS FIRST in a script, because importing it loads `.env`. Prisma 6's client read `.env` the
 * moment `@prisma/client` was imported; Prisma 7's does not, and the scripts' headers ("reads
 * DATABASE_URL from the environment — point it at the right database") were written against that. A
 * variable already set in the environment wins over the file, as it always did.
 */
if (existsSync(".env")) process.loadEnvFile(".env");

export function createScriptClient(): PrismaClient {
  return new PrismaClient({ adapter: prismaAdapter(process.env.DATABASE_URL) });
}
