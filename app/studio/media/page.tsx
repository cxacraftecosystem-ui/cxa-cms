import type { Metadata } from "next";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { cdnBaseUrl, mediaPurgeAfterDays, storageConfigured } from "@/lib/env";
import { canManageMedia } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import {
  MEDIA_PAGE_SIZE,
  mediaFiltersAreDefault,
  readMediaFilters,
  type MediaFolderNode,
  type MediaKindName,
  type MediaListResponse,
  type MediaTagsResponse,
  type StudioMediaAsset
} from "@/components/studio/media/MediaGrid";
import { MediaLibrary } from "./MediaLibrary";

/**
 * The media library.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageMedia)` IS THE FIRST STATEMENT, and it is the same predicate the
 * `/api/studio/media/*` handlers call. It THROWS rather than rendering: a failing permission check
 * renders nothing at all, never a screen of disabled controls (contract §1.8). Middleware has already
 * refused an anonymous request to this path, so this is the second of the two guards rather than the
 * only one.
 *
 * A SERVER COMPONENT READING PRISMA DIRECTLY, IN ONE BATCH, so the first paint has the folder tree, the
 * first page of files, the tag list and the accessibility counts already in it. Everything after that
 * — every filter, every page, every save — goes over HTTP through `lib/client/fetcher.ts`, because it
 * is reacting to a click rather than to a navigation.
 *
 * THE FIRST PAGE IS ONLY HANDED DOWN WHEN THE URL CARRIES NO FILTERS. A link such as
 * `/studio/media?alt=missing` (which the dashboard sends) would otherwise paint the whole library for
 * one frame before the filtered answer arrived, and a reader who came to clear the accessibility
 * backlog would watch it appear to be empty. With no seed the browser fetches the filtered page and
 * shows a loading state, which is the honest thing to show.
 *
 * NO `loading.tsx` FOR THIS SEGMENT, and none may be added: a `loading.tsx` flushes the response
 * headers as `200 OK` before the body is decided, which turns any later `notFound()` into a soft-404
 * (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Media"
};

/**
 * How many rows are read to build the tag filter.
 *
 * The tags live in a Postgres array column, and counting the DISTINCT values of an array's members is a
 * `GROUP BY` over `UNNEST` that Prisma's query builder cannot express. Reading one narrow column and
 * counting in memory is a cheap, safe alternative — and the cap is STATED ON SCREEN when it bites, so a
 * shortened tag list is never mistaken for a complete one (contract §1.6).
 */
const TAG_SCAN_LIMIT = 5000;

/** How many tags the filter offers. Past this the dropdown is a worse tool than the search box. */
const TAG_LIMIT = 60;

interface AssetRow {
  id: string;
  kind: MediaKindName;
  objectKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  checksum: string | null;
  blurDataUrl: string | null;
  altText: string | null;
  caption: string | null;
  credit: string | null;
  copyright: string | null;
  tags: string[];
  folderId: string | null;
  uploaderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  variants: { label: string; format: string; objectKey: string; width: number }[];
}

/**
 * A row as the browser will see it.
 *
 * The dates become ISO STRINGS here, deliberately: that is what the API returns for the same shape, and
 * a screen whose seeded rows carried `Date` objects while its fetched rows carried strings would work
 * until the first `new Date(row.createdAt)`.
 */
function toStudioAsset(row: AssetRow): StudioMediaAsset {
  return {
    id: row.id,
    kind: row.kind,
    objectKey: row.objectKey,
    fileName: row.fileName,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    duration: row.duration,
    checksum: row.checksum,
    blurDataUrl: row.blurDataUrl,
    altText: row.altText,
    caption: row.caption,
    credit: row.credit,
    copyright: row.copyright,
    tags: row.tags,
    folderId: row.folderId,
    uploaderId: row.uploaderId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    variants: row.variants
  };
}

export default async function StudioMediaPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStudioCapability(
    canManageMedia,
    "The media library needs media manager access or higher. An administrator can raise yours."
  );

  const filters = readMediaFilters(await searchParams);
  const seedFirstPage = mediaFiltersAreDefault(filters);

  const variantSelect = {
    select: { label: true, format: true, objectKey: true, width: true },
    orderBy: { width: "asc" as const }
  };

  const [folderRows, assetRows, totalAssets, altMissing, altDecorative, tagRows] =
    await prisma.$transaction([
      // The asset count comes back with each folder as a FILTERED relation count, so a tree twenty
      // folders deep is one query rather than twenty round trips for twenty small integers — and the
      // filter is what keeps files in the recycle bin out of the number beside a folder name.
      prisma.mediaFolder.findMany({
        select: {
          id: true,
          name: true,
          parentId: true,
          path: true,
          _count: { select: { assets: { where: { deletedAt: null } } } }
        },
        orderBy: { path: "asc" }
      }),

      // The recycle bin is filtered out everywhere. A soft-deleted asset belongs to /studio/recycle-bin,
      // and a library that showed it would offer a file that no longer appears on the site.
      // Read unconditionally, used conditionally. Making the batch's shape depend on the URL would make
      // the returned tuple's type depend on it too, which TypeScript cannot follow — and one page of
      // rows inside a transaction that was happening anyway is cheaper than a second round trip.
      prisma.mediaAsset.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: MEDIA_PAGE_SIZE,
        include: { variants: variantSelect }
      }),

      prisma.mediaAsset.count({ where: { deletedAt: null } }),

      // ⚠ THE TWO ALT-TEXT COUNTS ARE SEPARATE QUERIES BECAUSE THEY ARE SEPARATE FACTS. `altText IS
      // NULL` means nobody has written a description; `altText = ''` means somebody decided the picture
      // is decorative, which is a real answer in HTML and counts as finished. Collapsing them into one
      // number is what makes an accessibility backlog impossible to clear.
      prisma.mediaAsset.count({
        where: { deletedAt: null, kind: { in: ["IMAGE", "PANORAMA"] }, altText: null }
      }),
      prisma.mediaAsset.count({
        where: { deletedAt: null, kind: { in: ["IMAGE", "PANORAMA"] }, altText: "" }
      }),

      prisma.mediaAsset.findMany({
        where: { deletedAt: null, NOT: { tags: { isEmpty: true } } },
        select: { tags: true },
        orderBy: { createdAt: "desc" },
        take: TAG_SCAN_LIMIT
      })
    ]);

  const folders: MediaFolderNode[] = folderRows.map((folder) => ({
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    path: folder.path,
    assetCount: folder._count.assets
  }));

  const tagCounts = new Map<string, number>();
  for (const row of tagRows) {
    for (const tag of row.tags) {
      const trimmed = tag.trim();
      if (trimmed.length === 0) continue;
      tagCounts.set(trimmed, (tagCounts.get(trimmed) ?? 0) + 1);
    }
  }
  const orderedTags = [...tagCounts.entries()]
    // Most used first, ties broken alphabetically so the order is total and never reshuffles between
    // requests — an unstable sort renders a different list every time and looks like data changing.
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([tag, count]) => ({ tag, count }));

  const initialTags: MediaTagsResponse = {
    items: orderedTags.slice(0, TAG_LIMIT),
    truncated: orderedTags.length > TAG_LIMIT || tagRows.length >= TAG_SCAN_LIMIT
  };

  const initialAssets: MediaListResponse | null = seedFirstPage
    ? {
        items: assetRows.map(toStudioAsset),
        total: totalAssets,
        page: 1,
        pageSize: MEDIA_PAGE_SIZE,
        altBacklog: { missing: altMissing, decorative: altDecorative }
      }
    : null;

  /**
   * The two configuration facts that change what this screen can do, said in the words that matter
   * here. `configurationWarnings()` in lib/env carries the full list for Settings → Diagnostics; this
   * is the copy that appears where the hole actually is.
   */
  const storageReady = storageConfigured();
  const warnings: string[] = [];
  if (!storageReady) {
    warnings.push(
      "The file store is not set up, so nothing can be uploaded or replaced. Everything already in the library can still be described, tagged and filed."
    );
  }
  if (!cdnBaseUrl()) {
    warnings.push(
      "No public web address is configured for stored files, so thumbnails cannot be shown and pictures cannot be cropped here. The files themselves are unaffected."
    );
  }

  return (
    <div className="mx-auto w-full max-w-[110rem] space-y-6">
      <StudioPageHeader
        title="Media"
        description="Every photograph, video, recording and document the site uses. The most important thing on this screen is the description on each picture — it is what somebody using a screen reader is told instead of the image, and it is set here and nowhere else."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {totalAssets === 1 ? "1 file" : `${totalAssets} files`}
          </span>
        }
      />

      <MediaLibrary
        initialFilters={filters}
        initialAssets={initialAssets}
        initialFolders={folders}
        initialTags={initialTags}
        storageReady={storageReady}
        /*
          Read HERE, on the server, because `MEDIA_PURGE_AFTER_DAYS` has no `NEXT_PUBLIC_` prefix and
          the browser therefore cannot see it — which is correct, and is why every confirmation that
          promises a file can be restored takes the number as a prop rather than writing "30 days" into
          its own copy. It is the same function the purge job reads, so the promise and the deletion
          cannot drift apart.
        */
        recoveryDays={mediaPurgeAfterDays()}
        configurationWarnings={warnings}
      />
    </div>
  );
}
