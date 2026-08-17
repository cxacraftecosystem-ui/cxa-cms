-- A PDF rendition of a file-store version whose own format no browser can draw.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ WRITTEN BY HAND, and it has to match `prisma migrate diff` character for character. There is no
-- local database on this machine, so `prisma migrate dev` cannot be run here; this file is written to be
-- exactly what Prisma emits for four nullable fields plus one unique index appended to `FileVersion` in
-- prisma/schema.prisma in the same change. Get that wrong and the first `prisma migrate dev` on a machine
-- that HAS a database generates a second, duplicate migration.
--
-- WHY A COLUMN RATHER THAN A CONVENTION. The alternative is deriving the preview's key from the
-- original's — `<key>.preview.pdf` — which reads as tidier and cannot express the three states this
-- feature actually has: converted, tried and failed, never tried. A missing object would then be
-- indistinguishable from a conversion nobody has attempted, so every page render would have to ask
-- storage, and a failure would have nowhere to record WHY.
--
-- WHY NO `previewState`. Three columns already say it: a key means there is a preview, a reason means the
-- last attempt failed, a null timestamp means nobody has tried. A fourth column holding the same fact
-- would have to be written correctly everywhere instead of read correctly once, and the first time it
-- disagreed the studio would offer to convert something it had already converted.
--
-- `previewObjectKey` IS UNIQUE for the same reason `objectKey` is: two rows pointing at one object mean a
-- delete for one silently empties the other.
--
-- PURELY ADDITIVE AND SAFE ON A POPULATED DATABASE. Four nullable columns with no default: Postgres 11+
-- adds those as a catalogue-only change, so there is no table rewrite and no long lock. Every existing row
-- reads as "no preview has been made", which is exactly what is true of all of them.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "file_versions" ADD COLUMN     "previewAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "previewByteSize" INTEGER,
ADD COLUMN     "previewFailedReason" TEXT,
ADD COLUMN     "previewObjectKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "file_versions_previewObjectKey_key" ON "file_versions"("previewObjectKey");
