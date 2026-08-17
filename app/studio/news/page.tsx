import type { Metadata } from "next";
import Link from "next/link";
import { Newspaper, Tags } from "lucide-react";
import type { ContentStatus, Prisma } from "@prisma/client";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/env";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { canAuthor, canEditRecord, canManageContent, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { CENTRE_TIME_ZONE, centreZoneName } from "@/components/site/EventDateBlock";
import type { FilterToolbarOption } from "@/components/studio/FilterToolbar";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { NewsTable, type StudioPostRow } from "./NewsTable";

/**
 * The newsroom list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canAuthor)` IS THE FIRST STATEMENT, and it is the SAME predicate `StudioNav` hides
 * the sidebar entry with and the `/api/studio/news/*` handlers enforce. A sidebar that offers a screen
 * the screen then refuses is the exact failure contract §1.7 is about.
 *
 * WHO MAY EDIT WHICH ROW IS DECIDED HERE, ROW BY ROW. `canEditRecord(user, post.authorId)` is own-content
 * for an author and anyone's for an editor, and it is the predicate the PATCH handler applies — so it is
 * the one that decides whether a row offers an action at all. Deleting adds a second condition: taking a
 * LIVE article off the site is a publishing act, so it additionally needs `canPublish`.
 *
 * ⚠ THE BODY IS NOT SELECTED. Reading time comes from the stored `readingMinutes`; recomputing it would
 * mean fetching twenty-five whole Tiptap documents to print twenty-five small integers. `mdx` IS selected,
 * because it is null on almost every article and it is the only way to know which of the two mutually
 * exclusive writing modes a row is in — a fact worth knowing before clicking into a different editor.
 *
 * `?category=none` IS A RESERVED WORD, not an empty value. `buildQuery` drops the empty string, so
 * "articles with no category" and "every article" would otherwise be spelled identically in the URL
 * (lib/client/fetcher.ts). It is mapped back to `categoryId: null` below.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "News"
};

const PAGE_SIZE = 25;

/** How many tags the filter offers. Past this the dropdown is a worse tool than the search box. */
const TAG_FILTER_LIMIT = 40;

const STATUSES: readonly ContentStatus[] = [
  "DRAFT",
  "IN_REVIEW",
  "SCHEDULED",
  "PUBLISHED",
  "ARCHIVED"
];

const SORT_COLUMNS: Record<string, keyof Prisma.PostOrderByWithRelationInput> = {
  title: "title",
  status: "status",
  published: "publishedAt",
  updated: "updatedAt"
};

/** The reserved value meaning "filed in no category at all". See the header. */
const NO_CATEGORY = "none";

function firstValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

export default async function StudioNewsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canAuthor,
    "The newsroom needs author access or higher. An administrator can raise yours."
  );

  const raw = await searchParams;
  const query = firstValue(raw.q).trim();
  const statusRaw = firstValue(raw.status);
  const status = STATUSES.find((value) => value === statusRaw) ?? null;
  const categoryFilter = firstValue(raw.category);
  const tagFilter = firstValue(raw.tag);
  const sortKey = firstValue(raw.sort);
  const direction = firstValue(raw.dir) === "asc" ? "asc" : "desc";
  const requestedPage = Number.parseInt(firstValue(raw.page), 10);
  const currentPage = Number.isFinite(requestedPage) && requestedPage > 1 ? requestedPage : 1;

  const where: Prisma.PostWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(categoryFilter === NO_CATEGORY
      ? { categoryId: null }
      : categoryFilter.length > 0
        ? { categoryId: categoryFilter }
        : {}),
    // A tag filter is a filter on the join table. `some` rather than `every`, because an article tagged
    // "textiles" and "Bagru" must match a search for either.
    ...(tagFilter.length > 0 ? { tags: { some: { tag: { slug: tagFilter } } } } : {}),
    ...(query.length > 0
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" as const } },
            { subtitle: { contains: query, mode: "insensitive" as const } },
            { excerpt: { contains: query, mode: "insensitive" as const } },
            { slug: { contains: query, mode: "insensitive" as const } }
          ]
        }
      : {})
  };

  const column = SORT_COLUMNS[sortKey] ?? "publishedAt";
  /**
   * A second key, always, so the order is TOTAL. Sorting by `publishedAt` alone puts every unpublished
   * draft — all with a null — in whatever order the planner chose, and a list that reshuffles between
   * requests looks like data changing under the reader.
   */
  const orderBy: Prisma.PostOrderByWithRelationInput[] = [
    { [column]: direction } as Prisma.PostOrderByWithRelationInput,
    { updatedAt: "desc" }
  ];

  const [total, postRows, categories, tagCounts] = await prisma.$transaction([
    prisma.post.count({ where }),
    prisma.post.findMany({
      where,
      orderBy,
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        subtitle: true,
        slug: true,
        status: true,
        publishedAt: true,
        publishAt: true,
        unpublishAt: true,
        deletedAt: true,
        isFeatured: true,
        readingMinutes: true,
        authorId: true,
        updatedAt: true,
        // Selected deliberately; `body` is not. See the header.
        mdx: true,
        author: { select: { name: true } },
        category: { select: { name: true } },
        cover: { select: MEDIA_IMAGE_SELECT }
      }
    }),
    prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true }
    }),
    // Most-used tags first, so the dropdown offers the ones an editor actually files under. The count is
    // over live articles only — a tag used by three articles in the recycle bin is not a useful filter.
    prisma.tag.findMany({
      orderBy: [{ posts: { _count: "desc" } }, { name: "asc" }],
      take: TAG_FILTER_LIMIT + 1,
      select: { slug: true, name: true, _count: { select: { posts: true } } }
    })
  ]);

  const categoryOptions: FilterToolbarOption[] = categories.map((category) => ({
    value: category.id,
    label: category.name
  }));

  const tagsTruncated = tagCounts.length > TAG_FILTER_LIMIT;
  const tagOptions: FilterToolbarOption[] = tagCounts.slice(0, TAG_FILTER_LIMIT).map((tag) => ({
    value: tag.slug,
    label: tag._count.posts > 0 ? `${tag.name} (${tag._count.posts})` : tag.name
  }));

  const dateFormatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: CENTRE_TIME_ZONE
  });

  const now = new Date();
  const mayPublish = canPublish(user);

  const rows: StudioPostRow[] = postRows.map((row) => {
    const live = isLive(row, now);
    return {
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      path: `/news/${row.slug}`,
      status: row.status,
      isLive: live,
      isFeatured: row.isFeatured,
      categoryName: row.category?.name ?? null,
      authorName: row.author?.name ?? null,
      cover: row.cover,
      readingMinutes: row.readingMinutes,
      writingMode: (row.mdx ?? "").trim().length > 0 ? "mdx" : "formatted",
      publishedLabel: row.publishedAt ? dateFormatter.format(row.publishedAt) : null,
      updatedLabel: dateFormatter.format(row.updatedAt),
      canEdit: canEditRecord(user, row.authorId),
      // Deleting is stricter than editing, and taking something off the public site is a publishing act.
      canDelete: canEditRecord(user, row.authorId) && (!live || mayPublish)
    };
  });

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="News"
        description="Announcements, reports and stories for the newsroom. An author writes and edits their own drafts; an editor publishes them and can edit anyone's."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 article" : `${total} articles`}
          </span>
        }
        actions={
          <>
            {/*
              Categories and tags are an editor's job (`canManageContent`), so the link is absent for an
              author rather than leading to a screen that refuses them (contract §1.8).
            */}
            {canManageContent(user) ? (
              <Link
                href="/studio/news/taxonomy"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
              >
                <Tags aria-hidden="true" className="h-4 w-4" />
                Categories and tags
              </Link>
            ) : null}

            <LinkButton href="/studio/news/new" icon={Newspaper}>
              New article
            </LinkButton>
          </>
        }
      />

      <NewsTable
        rows={rows}
        total={total}
        page={currentPage}
        pageSize={PAGE_SIZE}
        siteOrigin={siteUrl().replace(/\/+$/, "")}
        filtersActive={
          query.length > 0 || status !== null || categoryFilter.length > 0 || tagFilter.length > 0
        }
        categoryOptions={categoryOptions}
        tagOptions={tagOptions}
        tagsTruncated={tagsTruncated}
        timeZoneLabel={centreZoneName(now, "long") || CENTRE_TIME_ZONE}
      />
    </div>
  );
}
