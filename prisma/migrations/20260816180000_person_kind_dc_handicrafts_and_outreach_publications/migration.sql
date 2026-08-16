-- One new personnel group and two new publication types.
--
-- Written by hand to match what `prisma migrate diff` produces for the three values appended to
-- `PersonKind` and `PublicationKind` in schema.prisma in the same change, so a later `prisma migrate
-- dev` finds nothing left to do. Purely additive: no column changes, no backfill, no row rewritten.
-- Every existing `people.kind` and `publications.kind` keeps the value it has, so this is safe to
-- apply to a populated database with no downtime.
--
-- ⚠ AN ENUM VALUE ADDED HERE CANNOT BE REMOVED LATER WITHOUT A REWRITE. Postgres offers
-- `ALTER TYPE … ADD VALUE` and no `DROP VALUE`: undoing any one of these three means creating a
-- replacement type, `ALTER TABLE … ALTER COLUMN … TYPE` on every column typed as the old one — which
-- takes an ACCESS EXCLUSIVE lock and rewrites the table — repointing every default, and dropping the
-- old type. On `people.kind` and `publications.kind` that is also a data decision, because every row
-- already carrying the value being dropped has to be re-filed as something else first. Treat
-- 'DC_HANDICRAFTS', 'FLYER' and 'BOOKLET' as permanent.
--
-- ⚠ ALL THREE ARE APPENDED AT THE END OF THEIR TYPE, WHICH IS WHY THERE IS NO `BEFORE`/`AFTER` CLAUSE.
-- Reading order on screen is decided in TypeScript — `PERSON_KIND_ORDER` in
-- components/site/PersonCard.tsx and `PUBLICATION_KIND_ORDER` in app/(site)/publications/filters.ts —
-- precisely so that the enum's declaration order never has to be curated. Nothing sorts by these
-- columns, so appending changes no existing page. (`Person` is ordered by `sortOrder, name, id` and
-- grouped in code; `Publication` is ordered by year.)
--
-- ON RUNNING THIS AGAINST POSTGRES 11 OR OLDER: it would need splitting into one migration per value,
-- because those versions refuse more than one `ADD VALUE` in a transaction and Prisma wraps a
-- migration in one. The stack runs Postgres 16 (docker-compose.yml), where several appends in one
-- transaction are fine — the restriction that remains is that a value added in a transaction cannot be
-- USED in that same transaction, and nothing below inserts or compares against these values.

-- AlterEnum
ALTER TYPE "PersonKind" ADD VALUE 'DC_HANDICRAFTS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PublicationKind" ADD VALUE 'FLYER';
ALTER TYPE "PublicationKind" ADD VALUE 'BOOKLET';
