import { prisma } from "@/lib/db";

/**
 * The distinct values a studio filter offers — entity types in the audit log, enquiry forms, file and album
 * categories, publication years — as `GROUP BY … ORDER BY … LIMIT`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ NOT `findMany({ distinct })`. Prisma does not send `distinct` to the database: it reads EVERY matching
 * row, de-duplicates in memory and only then applies `take`. For the audit log that was
 * `SELECT id, "entityType" FROM audit_logs ORDER BY "entityType"` with no LIMIT — every row the
 * installation has ever logged, on every open of the audit screen, growing for as long as the site runs.
 * `groupBy` is real SQL: the database returns one row per value and stops at the cap, and for the audit log
 * it can answer from the leading column of the `(entityType, entityId)` index.
 *
 * Same rows, same order, same cap as the `distinct` reads they replace: a NULL value is one group, sorted
 * where `ORDER BY` puts it, exactly as it was one distinct value before.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Each returns the query unawaited, so it can sit inside the callers' `prisma.$transaction([...])` batches.
 */

/** The audit log's entity types, alphabetically, at most `take`. */
export function auditEntityTypeOptions(take: number) {
  return prisma.auditLog.groupBy({
    by: ["entityType"],
    orderBy: { entityType: "asc" },
    take
  });
}

/** The forms enquiries in the inbox arrived through, alphabetically, at most `take`. */
export function inquiryFormKeyOptions(take: number) {
  return prisma.contactSubmission.groupBy({
    by: ["formKey"],
    where: { deletedAt: null },
    orderBy: { formKey: "asc" },
    take
  });
}

/** Categories used by files outside the recycle bin, alphabetically, at most `take`. */
export function fileCategoryOptions(take: number) {
  return prisma.fileAsset.groupBy({
    by: ["category"],
    where: { deletedAt: null, NOT: { category: null } },
    orderBy: { category: "asc" },
    take
  });
}

/** Categories used by albums outside the recycle bin, alphabetically, at most `take`. */
export function albumCategoryOptions(take: number) {
  return prisma.galleryAlbum.groupBy({
    by: ["category"],
    where: { deletedAt: null, NOT: { category: null } },
    orderBy: { category: "asc" },
    take
  });
}

/** The years publications outside the recycle bin carry, newest first, at most `take`. */
export function publicationYearOptions(take: number) {
  return prisma.publication.groupBy({
    by: ["year"],
    where: { deletedAt: null },
    orderBy: { year: "desc" },
    take
  });
}
