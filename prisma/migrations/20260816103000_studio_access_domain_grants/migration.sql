-- Domain grants on the studio access list.
--
-- Written by hand to match what `prisma migrate diff` produces for the `AccessKind` enum and the `kind`
-- column added to `StudioAccess` in the same change, so a later `prisma migrate dev` finds nothing left
-- to do. Purely additive: one new type, one new column with a default. No backfill, no rewrite of an
-- existing value, and therefore safe to apply to a populated database with no downtime.
--
-- ⚠ THE DEFAULT IS 'EMAIL' AND THAT IS THE WHOLE SAFETY OF THIS MIGRATION. Every row that exists today is
-- one address. Adding this column with any other default — or adding it nullable and letting the reader
-- guess — would silently reinterpret each of those rows as "anybody at that person's mail provider",
-- which for the handful of grants written against @gmail.com would open the CMS to the world, in one
-- migration, with no audit entry and nothing on screen to show it had happened. `NOT NULL DEFAULT 'EMAIL'`
-- makes widening a grant something a master admin has to do on purpose, one row at a time.
--
-- NO NEW UNIQUE INDEX IS NEEDED. A domain is stored in the existing `email` column WITH its leading "@"
-- ("@iitkgp.ac.in"), so `studio_access_email_key` already enforces "listed at most once" for domains as
-- well as addresses — and the two can never collide, because a real address always has a local part in
-- front of its "@". See the comment on `StudioAccess.email` in schema.prisma for why one column carries
-- both rather than a second nullable `domain` column: two nullable unique columns cannot express this,
-- since Postgres does not compare NULLs and would happily accept the same domain twice.
--
-- ⚠ NO PARTIAL CHECK CONSTRAINT EITHER, e.g. `CHECK (kind <> 'DOMAIN' OR email LIKE '@%')`. It was
-- tempting and it is the wrong layer: `resolveAccess()` in lib/auth/access.ts already refuses to honour a
-- domain match whose row does not agree on both halves, so a row edited straight in psql fails CLOSED —
-- it grants nobody anything. A constraint would move that decision into the database, where the sign-in
-- path cannot see it, and add a migration hazard for a rule the only writer (app/api/studio/access) has
-- already applied.

-- CreateEnum
CREATE TYPE "AccessKind" AS ENUM ('EMAIL', 'DOMAIN');

-- AlterTable
ALTER TABLE "studio_access" ADD COLUMN     "kind" "AccessKind" NOT NULL DEFAULT 'EMAIL';
