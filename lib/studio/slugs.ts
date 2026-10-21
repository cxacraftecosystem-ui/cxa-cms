import { prisma } from "@/lib/db";
import { slugify } from "@/lib/utils";

/**
 * Free-slug search in ONE query.
 *
 * Both callers used to ask the database about one candidate at a time — `base`, then `base-2`, `base-3` —
 * so the third "Annual report" cost three round trips and the fiftieth cost fifty. The candidates are now
 * listed up front, read in one `WHERE slug IN (…)`, and the first one not in use is chosen in memory: the
 * same answer the loop gave, for one statement. It is a check rather than a guarantee, as it always was —
 * the unique index on `slug` is the backstop for two saves in the same instant.
 * (app/studio/templates/page.tsx chooses a page address the same way.)
 */

/** `base`, `base-2`, `base-3` … — `count` candidates in the order they are tried. */
export function slugCandidates(base: string, count: number): string[] {
  return Array.from({ length: count }, (_, attempt) => (attempt === 0 ? base : `${base}-${attempt + 1}`));
}

/** How many numbered candidates a file's address tries before falling back to a timestamp. */
const FILE_SLUG_ATTEMPTS = 50;

/**
 * A slug for a new file that nobody else is using.
 *
 * The slug is the PUBLIC download address and therefore the thing a citation records, so it is derived
 * from the title once and then left alone. A numeric suffix is appended rather than the title being
 * refused: an editor uploading "Annual report" for the third year running should not have to invent a
 * different name for the file to be accepted.
 */
export async function freeFileSlug(title: string): Promise<string> {
  const base = slugify(title) || "file";
  const candidates = slugCandidates(base, FILE_SLUG_ATTEMPTS);

  const taken = new Set(
    (
      await prisma.fileAsset.findMany({
        where: { slug: { in: candidates } },
        select: { slug: true }
      })
    ).map((row) => row.slug)
  );

  const free = candidates.find((candidate) => !taken.has(candidate));
  // Fifty entries whose titles all slugify identically. A timestamp is ugly and it is unique, which is
  // the only property that matters at this point.
  return free ?? `${base}-${Date.now().toString(36)}`;
}
