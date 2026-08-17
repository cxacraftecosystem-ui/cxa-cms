import type { Metadata } from "next";
import Link from "next/link";
import { EyeOff, ImageOff, Images, Plus, SearchX } from "lucide-react";
import type { ContentStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { canManageContent } from "@/lib/permissions";
import { describeStatus } from "@/lib/content";
import { getSettingCached } from "@/lib/settings/service";
import { EmptyState } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";
import { MediaImage } from "@/components/ui/MediaImage";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";

/**
 * The gallery — the list of photo albums.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageContent)` IS THE FIRST STATEMENT, and it is the same predicate the
 * `/api/studio/gallery/*` handlers call and the same one `StudioNav` hides the sidebar entry with. It
 * THROWS rather than rendering: a failing permission check renders nothing at all, never a screen of
 * disabled controls (contract §1.8). Middleware has already refused an anonymous request to this path,
 * so this is the second of the two guards rather than the only one.
 *
 * A SERVER COMPONENT THAT READS PRISMA DIRECTLY, and it stays one. The whole screen is a navigation:
 * the filters live in the URL (FilterToolbar writes them), the pages are real links, and every row goes
 * to an editor. There is nothing here reacting to a click, so there is nothing to fetch over HTTP
 * (contract §9) — which also means the first paint has the albums in it rather than a skeleton.
 *
 * THE TABLE IS RENDERED BY HAND RATHER THAN THROUGH `DataTable`. That component takes a `render`
 * function per column, and a function cannot cross the server/client boundary — handing one to it from
 * here fails at runtime. The alternative would be making this screen a client component and fetching
 * its own list, which would cost the first paint for no gain on a page with no interactive state.
 *
 * NO `loading.tsx` FOR THIS SEGMENT, and none may be added: a `loading.tsx` flushes the response
 * headers as `200 OK` before the body is decided, which turns the `notFound()` in the editor beneath it
 * into a soft-404 (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gallery"
};

/** Rows per page. Twenty-five album rows with a thumbnail each is about one screen and a scroll. */
const PAGE_SIZE = 25;

/**
 * How many distinct categories the filter offers.
 *
 * Categories are free text on the album rather than a table, so the list is whatever editors have
 * typed. The cap is STATED ON SCREEN when it bites — a shortened list is otherwise indistinguishable
 * from a complete one, and somebody would conclude their category had been lost (contract §1.6).
 */
const CATEGORY_LIMIT = 40;

/** The orders this list offers, and the Prisma clause each one means. */
const SORTS = {
  updated: { updatedAt: "desc" as const },
  happened: { happenedOn: "desc" as const },
  title: { title: "asc" as const },
  order: { sortOrder: "asc" as const }
} satisfies Record<string, Prisma.GalleryAlbumOrderByWithRelationInput>;

type SortKey = keyof typeof SORTS;

function isSortKey(value: string): value is SortKey {
  return Object.prototype.hasOwnProperty.call(SORTS, value);
}

const STATUSES: readonly ContentStatus[] = ["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"];

function isStatus(value: string): value is ContentStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/** The first value for a parameter, whichever shape Next hands over. */
function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/** A date as an editor writes it, or an em dash. Fixed to UTC so the server and the browser agree. */
function formatDay(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
}

export default async function StudioGalleryPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireStudioCapability(
    canManageContent,
    "The gallery needs editor access or higher. An administrator can raise yours."
  );

  const params = await searchParams;

  const q = first(params.q).trim();
  const statusFilter = first(params.status);
  const categoryFilter = first(params.category);
  const sortParam = first(params.sort);
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "updated";
  const pageParam = Number.parseInt(first(params.page), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  /**
   * The recycle bin is filtered out everywhere. A soft-deleted album belongs to /studio/recycle-bin,
   * and listing it here would offer an album that no longer appears on the site.
   */
  const where: Prisma.GalleryAlbumWhereInput = {
    deletedAt: null,
    ...(isStatus(statusFilter) ? { status: statusFilter } : {}),
    ...(categoryFilter.length > 0 ? { category: categoryFilter } : {}),
    ...(q.length > 0
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
            { location: { contains: q, mode: "insensitive" } },
            { credit: { contains: q, mode: "insensitive" } },
            { slug: { contains: q, mode: "insensitive" } },
            { tags: { has: q } }
          ]
        }
      : {})
  };

  // One batch rather than three awaited queries: sequentially each pays a full round trip, and on a
  // pooled connection over a network that is most of a second of blank screen for three small answers.
  const [albums, total, categoryRows] = await prisma.$transaction([
    prisma.galleryAlbum.findMany({
      where,
      // A SECOND ORDERING KEY on every sort, so the order is total and stable. An unstable sort renders
      // a different list on each request and reads as data changing under the reader.
      orderBy: [SORTS[sort], { title: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        slug: true,
        title: true,
        category: true,
        location: true,
        happenedOn: true,
        status: true,
        publishedAt: true,
        updatedAt: true,
        tags: true,
        cover: { select: MEDIA_IMAGE_SELECT },
        _count: { select: { items: true } }
      }
    }),
    prisma.galleryAlbum.count({ where }),
    prisma.galleryAlbum.findMany({
      where: { deletedAt: null, NOT: { category: null } },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
      // One more than the cap, so "there are more than this" is a fact rather than a guess.
      take: CATEGORY_LIMIT + 1
    })
  ]);

  /**
   * The feature flags, through the settings service rather than a raw `Setting` row.
   *
   * `getSettingCached` is memoised for the request and REPAIRS a stored document that no longer
   * validates, field by field, rather than letting one bad value blank the group (settings/service.ts).
   * Reading the row inside the batch above would save a round trip and lose all of that.
   */
  const featureFlags = await getSettingCached("features");

  const categories = categoryRows
    .map((row) => row.category)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const categoriesTruncated = categories.length > CATEGORY_LIMIT;
  const categoryOptions = categories.slice(0, CATEGORY_LIMIT).map((value) => ({ value, label: value }));

  /**
   * The pagination links keep every filter that is currently set.
   *
   * Built from the parameters this screen owns rather than from the raw query, so a stale or
   * hand-edited parameter cannot be carried forward into a link the screen then cannot read back.
   */
  const carried = new URLSearchParams();
  if (q.length > 0) carried.set("q", q);
  if (isStatus(statusFilter)) carried.set("status", statusFilter);
  if (categoryFilter.length > 0) carried.set("category", categoryFilter);
  if (sort !== "updated") carried.set("sort", sort);
  const baseHref = carried.toString().length > 0 ? `/studio/gallery?${carried.toString()}` : "/studio/gallery";

  const filtered = q.length > 0 || statusFilter.length > 0 || categoryFilter.length > 0;

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Gallery"
        description="Photo albums, grouped by occasion. Each album holds pictures in a set order, with a caption on each one, and can present a picture as a video, a panorama or the way into a virtual tour."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 album" : `${total} albums`}
          </span>
        }
        actions={
          <LinkButton href="/studio/gallery/new" icon={Plus}>
            New album
          </LinkButton>
        }
      >
        <FilterToolbar
          search={{ label: "Search albums by title, place, credit or tag", placeholder: "Search albums" }}
          status={{ statuses: STATUSES }}
          selects={[
            {
              key: "category",
              label: "Category",
              options: categoryOptions,
              placeholder: "Any category"
            },
            {
              key: "sort",
              label: "Order",
              options: [
                { value: "updated", label: "Recently changed" },
                { value: "happened", label: "Date of the occasion" },
                { value: "title", label: "Title, A to Z" },
                { value: "order", label: "The order set on each album" }
              ],
              placeholder: "Recently changed"
            }
          ]}
        />
      </StudioPageHeader>

      {/* A whole section switched off is the sort of thing an editor finds out from a colleague a
          fortnight later. Said here, where the albums are. */}
      {!featureFlags.gallery ? (
        <HelpText tone="warn" icon={EyeOff}>
          The gallery is switched off for the public site, so none of these albums can be reached by a
          visitor and the menu entry for them is hidden. An administrator can turn it back on in
          Settings → Features. Everything on this screen still works, and nothing has been deleted.
        </HelpText>
      ) : null}

      {categoriesTruncated ? (
        <HelpText>
          The category filter lists only the first {CATEGORY_LIMIT} categories in alphabetical order.
          There are more than that in use — search for an album by name if its category is not offered.
        </HelpText>
      ) : null}

      {albums.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={SearchX}
            title="No albums match these filters"
            description="Nothing fits all of what you have asked for. That is a fact about the filters rather than about the gallery — clear them to see every album again."
            action={
              <LinkButton href="/studio/gallery" variant="secondary">
                Clear the filters
              </LinkButton>
            }
          />
        ) : (
          <EmptyState
            icon={Images}
            title="There are no albums yet"
            description="An album is a set of pictures from one occasion — a workshop, a field visit, an exhibition. Make the first one, then choose its pictures from the media library."
            action={
              <LinkButton href="/studio/gallery/new" icon={Plus}>
                New album
              </LinkButton>
            }
          />
        )
      ) : (
        <>
          {/*
            `overflow-x-auto` on the wrapper, so a narrow window scrolls the table sideways instead of
            crushing six columns into four characters each. The lower-priority columns drop out below
            their breakpoints rather than shrinking.
          */}
          <div className="overflow-x-auto rounded-md border border-line-200 bg-card">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Gallery albums, {total === 1 ? "1 in total" : `${total} in total`}
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500"
                  >
                    Album
                  </th>
                  <th
                    scope="col"
                    className="hidden border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500 md:table-cell"
                  >
                    Category
                  </th>
                  <th
                    scope="col"
                    className="border-b border-line-200 bg-surface-50 px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-ink-500"
                  >
                    Pictures
                  </th>
                  <th
                    scope="col"
                    className="hidden border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500 lg:table-cell"
                  >
                    Occasion
                  </th>
                  <th
                    scope="col"
                    className="border-b border-line-200 bg-surface-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500"
                  >
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {albums.map((album) => (
                  <tr
                    key={album.id}
                    // `group` is what lets the one link in the row pick up the brand colour when the
                    // pointer is anywhere on it: the row reads as a target without being one, which a
                    // row wrapped in an `<a>` cannot manage without swallowing every control inside.
                    className="group border-b border-line-200 transition-colors last:border-b-0 hover:bg-surface-50"
                  >
                    <td className="min-w-0 px-3 py-2.5 align-middle">
                      <div className="flex min-w-0 items-center gap-3">
                        {album.cover ? (
                          <MediaImage
                            media={album.cover}
                            // The title beside it names the album, so the thumbnail is decorative here.
                            alt=""
                            aspect="none"
                            rounded="sm"
                            sizes="80px"
                            className="h-10 w-14 shrink-0"
                          />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="inline-flex h-10 w-14 shrink-0 items-center justify-center rounded-sm border border-line-200 bg-surface-100 text-ink-300"
                          >
                            <ImageOff className="h-4 w-4" />
                          </span>
                        )}

                        <span className="min-w-0">
                          <Link
                            href={`/studio/gallery/${album.id}`}
                            className="rounded font-medium text-ink-900 underline-offset-4 transition-colors hover:text-purple-700 hover:underline group-hover:text-purple-700"
                          >
                            {album.title}
                          </Link>
                          <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-ink-500">
                            /gallery/{album.slug}
                          </span>
                        </span>
                      </div>
                    </td>

                    <td className="hidden px-3 py-2.5 align-middle text-ink-700 md:table-cell">
                      {album.category ?? <span className="text-ink-300">Not set</span>}
                    </td>

                    <td className="px-3 py-2.5 text-right align-middle tabular-nums text-ink-700">
                      {album._count.items}
                    </td>

                    <td className="hidden px-3 py-2.5 align-middle text-ink-700 lg:table-cell">
                      <span className="block">{formatDay(album.happenedOn)}</span>
                      {album.location ? (
                        <span className="mt-0.5 block truncate text-xs text-ink-500">
                          {album.location}
                        </span>
                      ) : null}
                    </td>

                    <td className="px-3 py-2.5 align-middle">
                      <StatusBadge status={album.status} size="sm" />
                      {/*
                        The WHOLE truth, from lib/content.ts — a published album with a picture count of
                        zero still says "Published", and `describeStatus` is the one place the sentence
                        is worded. Fixed to UTC inside that helper's own formatting, so the server's
                        HTML and the browser's hydration agree.
                      */}
                      <span className="mt-1 block text-xs text-ink-500">
                        {describeStatus({
                          status: album.status,
                          publishedAt: album.publishedAt,
                          deletedAt: null
                        })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            totalItems={total}
            baseHref={baseHref}
            itemNoun={{ singular: "album", plural: "albums" }}
            label="Gallery"
          />
        </>
      )}
    </div>
  );
}
