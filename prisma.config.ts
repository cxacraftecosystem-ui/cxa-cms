import { existsSync } from "node:fs";

import { defineConfig } from "prisma/config";

/**
 * The Prisma CLI's configuration (Prisma 7): where the schema and migrations live, how to seed, and
 * which database `prisma migrate` talks to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE CLI NO LONGER READS `.env`. Prisma 6 loaded it for every command; Prisma 7 does not, so a local
 * `npx prisma migrate dev` would otherwise find no database at all. `.env` is loaded here, only if it
 * exists, and a variable already in the environment wins over the file (Node's own rule) — CI, Vercel
 * and the container set the real values and never ship a `.env`.
 *
 * MIGRATIONS GO OVER `DIRECT_DATABASE_URL`, falling back to `DATABASE_URL`. That is the job the schema's
 * `directUrl` used to do (docs/DEPLOYMENT.md §1.4): a migration needs one continuous session, which a
 * transaction pooler cannot give it. The application never reads this file — it connects through
 * lib/prisma-adapter.ts from `DATABASE_URL`.
 *
 * NOT `env()` from prisma/config: it throws when the variable is unset, and `prisma generate` — which
 * needs no database — runs in places that have none (the image build's first steps, a fresh clone).
 * A command that does need one fails with Prisma's own "datasource.url is required" instead.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
if (existsSync(".env")) process.loadEnvFile(".env");

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts"
  },
  ...(url ? { datasource: { url } } : {})
});
