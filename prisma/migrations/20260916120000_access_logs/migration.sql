-- The access log: one row per request that reached a route handler.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY THIS TABLE EXISTS. The hosting undertaking signed with IIT KGP's Computer and Informatics
-- Centre requires that website logs be retained for a minimum of 90 days and produced on request.
-- The deployment is on Vercel's Hobby plan, which retains runtime logs for ONE HOUR and gates Log
-- Drains behind Pro — so `console.log` satisfies nothing, and the obligation has to be met from
-- inside the application, in storage we already operate. This is that storage.
--
-- `audit_logs` cannot be it. An audit row exists only where something CHANGED, and the question an
-- incident actually asks — "which address asked for what, when, and what did it get" — is about the
-- requests that changed nothing, which is most of them and all reconnaissance. The long note on
-- `model AccessLog` in prisma/schema.prisma sets out the four reasons these are separate tables; the
-- one that decides it is that lib/audit.ts guarantees every row was written in the same transaction
-- as the change it describes, and an access row has no change and therefore no transaction to join.
--
-- PURELY ADDITIVE AND SAFE AGAINST A POPULATED PRODUCTION DATABASE. One new table, one new sequence,
-- three new indexes. Nothing existing is altered, renamed, dropped or backfilled; no existing table
-- is locked, read or rewritten. `CREATE TABLE` takes no lock on anything that already exists, and
-- building an index on a table with zero rows is instantaneous, so this applies during traffic with
-- no downtime. `vercel.json`'s buildCommand runs `prisma migrate deploy`, so it ships with the deploy
-- that carries the code — and the code tolerates the table being absent (see lib/requestLog.ts: the
-- write is wrapped, never throws, and a failed insert costs a console line and nothing else), so the
-- window between the two is not a failure mode.
--
-- "id" IS SERIAL, NOT TEXT — the only table in this schema whose primary key is not `cuid()`. Nothing
-- addresses an access row by URL, so an unguessable id buys nothing; what a range read needs is a
-- stable cursor, and "at" cannot be one because thousands of rows share a millisecond. A monotonic
-- integer makes a paginated 90-day export to CIC resumable instead of duplicating or skipping rows at
-- every page boundary. int4 and not int8 because `JSON.stringify` throws on a JavaScript BigInt and
-- would take out `NextResponse.json` on any screen that lists these; two billion rows is decades at
-- this site's volume.
--
-- ⚠ NO FOREIGN KEY ON "actorId", unlike `audit_logs_actorId_fkey`. That constraint is ON DELETE SET
-- NULL, which on a table written once per request turns deleting one user into an UPDATE across every
-- row that user ever produced — and it would erase exactly the column an auditor needs to answer
-- "everything this account did", at exactly the moment somebody is most likely to ask it. "actorEmail"
-- is denormalised for the same reason it is on audit_logs; here "actorId" is denormalised too. The
-- price is a dangling id, which is the honest thing for a log to say about a deleted account.
--
-- ⚠ NOT INDEXED: "status" and "path". Every index is paid for on every insert and this is the
-- hottest-written table in the schema. "every 401 last week" and "who hit /api/studio/users" both
-- arrive with a date range attached and ride "access_logs_at_idx"; a private index for each would
-- nearly double the write cost to save a bounded scan on a query nobody runs hourly.
--
-- ⚠ NO RETENTION IS INSTALLED BY THIS MIGRATION. The table grows without bound until a purge job
-- deletes on a window, and none exists in this change. Until one does, this satisfies "retained for a
-- minimum of 90 days" by omission rather than by policy — which is the same state `audit_logs` has
-- always been in, and which cannot be shown to CIC as a policy. Whoever adds it wants
-- `DELETE FROM "access_logs" WHERE "at" < $cutoff` bounded per run, against `access_logs_at_idx`,
-- with the window from `accessLogRetentionDays()` in lib/env.ts (already present, defaulting to 180
-- with a hard floor of 90).
--
-- GENERATED, NOT HAND-WRITTEN. There is no local database on this machine, so `prisma migrate dev`
-- cannot be run here — but `prisma migrate diff --from-schema-datamodel <schema before>
-- --to-schema-datamodel prisma/schema.prisma --script` needs none, and this DDL is its output
-- verbatim. A later `migrate dev` therefore finds nothing left to do. THE SCHEMA BLOCK MUST LAND IN
-- THE SAME COMMIT: without it `prisma migrate` reports drift the other way and @prisma/client never
-- exposes `prisma.accessLog`, so every write of it is a type error.
--
-- ROLLING BACK is `DROP TABLE "access_logs"` (the sequence and the three indexes go with it). It
-- loses the retained request history and puts the clause-4 obligation back where it was.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "access_logs" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "query" TEXT,
    "status" INTEGER NOT NULL,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_logs_at_idx" ON "access_logs"("at");

-- CreateIndex
CREATE INDEX "access_logs_actorId_at_idx" ON "access_logs"("actorId", "at");

-- CreateIndex
CREATE INDEX "access_logs_ipAddress_at_idx" ON "access_logs"("ipAddress", "at");
