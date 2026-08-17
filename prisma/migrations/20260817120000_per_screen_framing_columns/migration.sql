-- Per-screen framing for every picture chosen against a RECORD rather than inside a page block.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ WRITTEN BY HAND, and it has to match `prisma migrate diff` character for character. There is no
-- local database on this machine, so `prisma migrate dev` cannot be run here; this file is written to be
-- exactly what Prisma emits for twelve nullable `Json` fields appended to twelve models in
-- prisma/schema.prisma in the same change. Get that wrong and the first `prisma migrate dev` on a
-- machine that HAS a database generates a second, duplicate migration.
--
-- ⚠ THE MATCHING SCHEMA BLOCKS MUST LAND IN THE SAME COMMIT. Without them `prisma migrate` reports drift
-- in the opposite direction — the database has columns the schema does not — and `@prisma/client` will not
-- expose the fields at all, so every read of them is a type error.
--
-- WHAT THIS IS FOR. A page BLOCK stores its framing inside `PageSection.data`, which is JSONB already, so
-- the nine section fields needed no migration at all. A picture chosen against a record — a person's
-- photograph, a project's cover, one row of a gallery — has nowhere to put it, so each gets one column
-- beside the foreign key it frames.
--
-- WHY JSONB AND NOT SIX COLUMNS PER PICTURE. The alternative is `photoBaseCropX`, `photoSmCropX`, and so
-- on: six buckets times four numbers plus a media id and an aspect, which is thirty-six columns per
-- picture and four hundred and thirty-two across these twelve. Nothing queries INSIDE a framing — it is
-- read whole, by one resolver, at render — so a column per number buys nothing and costs a migration
-- every time a bucket is added. `lib/media/screens.ts` owns the shape and `screens-check` asserts it.
--
-- WHY NO CHECK CONSTRAINT, and this is the same argument the crop migration makes at length
-- (20260816190000_media_asset_crop): the ranges are enforced where a person can be TOLD about them —
-- the Zod schema at the API boundary answers a sentence — and the render side treats any unusable
-- rectangle as "no crop for this bucket". A constraint violation reaches an editor as "something went
-- wrong on our side", which is the outcome this codebase spends a great deal of effort avoiding.
--
-- PURELY ADDITIVE AND SAFE ON A POPULATED DATABASE. Twelve nullable columns with no default: Postgres 11+
-- adds those as a catalogue-only change, so there is no table rewrite, no long lock, and every existing
-- row reads as "nobody has framed this" — which renders exactly as it does today.
--
-- ⚠ THREE PICTURE FIELDS ARE DELIBERATELY NOT HERE, and the reason is the same in each case: there is
-- only one size to frame, so the control would do nothing.
--
--   • `User.avatarId` — drawn at 32-48px in the studio chrome and at 1:1 on a byline.
--   • `Page.seoImageId` — the share card. `lib/seo.ts` asks for the `og` variant, which
--     lib/storage/derivatives.ts builds at a forced 1200x630; a social card has exactly one shape by
--     definition of the format.
--   • `MediaAsset`'s own crop columns — already per-asset, and they remain the BASE of every cascade
--     here rather than being replaced by it.
--
-- ROLLING BACK is `ALTER TABLE … DROP COLUMN` twelve times, and it loses every per-screen framing an
-- editor has set. The asset-level crops are untouched either way, so a rollback returns each picture to
-- one framing everywhere rather than to none.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "people" ADD COLUMN     "photoScreens" JSONB;

-- AlterTable
ALTER TABLE "research_areas" ADD COLUMN     "coverScreens" JSONB;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "coverScreens" JSONB;

-- AlterTable
ALTER TABLE "project_media" ADD COLUMN     "assetScreens" JSONB;

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "coverScreens" JSONB;

-- AlterTable
ALTER TABLE "events" ADD COLUMN     "coverScreens" JSONB;

-- AlterTable
ALTER TABLE "event_media" ADD COLUMN     "assetScreens" JSONB;

-- AlterTable
ALTER TABLE "crafts" ADD COLUMN     "coverScreens" JSONB;

-- AlterTable
ALTER TABLE "craft_media" ADD COLUMN     "assetScreens" JSONB;

-- AlterTable
ALTER TABLE "gallery_albums" ADD COLUMN     "coverScreens" JSONB;

-- AlterTable
ALTER TABLE "gallery_items" ADD COLUMN     "assetScreens" JSONB;

-- AlterTable
ALTER TABLE "partners" ADD COLUMN     "logoScreens" JSONB;
