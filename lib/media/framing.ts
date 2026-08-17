import "server-only";

import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { screenFramingMediaIds, type ScreenFraming } from "@/lib/media/screens";
import type { MediaLike } from "@/lib/media/url";

/**
 * Fetch the alternate photographs a RECORD's per-screen framing names.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A RECORD NEEDS THIS AND A PAGE BLOCK DOES NOT. `lib/sections/resolve.ts` already takes a census of
 * every media id a page's blocks mention and fetches them in one `IN (…)`, so a section's framing gets its
 * alternates for free — the framing ids simply join that census. A person, a project or a gallery row has
 * no such census: its cover arrives through a Prisma RELATION (`cover: { select: MEDIA_IMAGE_SELECT }`),
 * and a framing's alternates are arbitrary ids sitting in a JSONB column that no relation can join.
 *
 * ⚠ IT COSTS NOTHING WHEN NOTHING IS FRAMED, which is the overwhelmingly common case. No framing means no
 * ids, and no ids means this returns an empty map WITHOUT touching the database — the query is only issued
 * for a record somebody has actually given a per-screen alternate. That property is why this can be called
 * unconditionally from a page rather than guarded at each call site, and guarding it at each site is how
 * one of them ends up guarded wrongly.
 *
 * ⚠ THE RESULT IS SHAPED FOR `pictureFromMap`, deliberately: a plain `Record<string, MediaLike>` rather
 * than a Map or an array. Every renderer already has that shape from `resolved.media`, so a record page and
 * a section renderer call the resolver identically, and there is one fewer way for the two to diverge.
 *
 * A soft-deleted asset is excluded. A bucket naming one therefore INHERITS, which is the right answer: a
 * photograph in the recycle bin must not appear on the public site because a framing still mentions it,
 * and the picture the reader gets is the base one rather than a hole.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function framingAssets(
  ...framings: (ScreenFraming | null | undefined)[]
): Promise<Record<string, MediaLike | undefined>> {
  const ids = new Set<string>();
  for (const framing of framings) {
    for (const id of screenFramingMediaIds(framing)) ids.add(id);
  }
  if (ids.size === 0) return {};

  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: [...ids] }, deletedAt: null },
    select: { ...MEDIA_IMAGE_SELECT, id: true }
  });

  const map: Record<string, MediaLike | undefined> = {};
  for (const row of rows) map[row.id] = row;
  return map;
}

/**
 * The same map, plus the record's OWN picture under its id.
 *
 * `pictureFromMap` looks the base photograph up by id like any other, so a caller that passed only the
 * alternates would get null for every picture — the base would be missing from the very map meant to
 * resolve it. This is the shape almost every call site wants, and having it here means no page has to
 * remember that.
 */
export function withBaseAsset(
  map: Record<string, MediaLike | undefined>,
  baseId: string | null | undefined,
  base: MediaLike | null | undefined
): Record<string, MediaLike | undefined> {
  if (!baseId || !base) return map;
  return { ...map, [baseId]: base };
}
