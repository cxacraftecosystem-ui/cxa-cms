import type { Metadata } from "next";
import { FilePlus2 } from "lucide-react";
import type { ContentStatus, Prisma } from "@prisma/client";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/env";
import { pagePath } from "@/lib/pages";
import { canManageStructure } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
// The single declared home of the Centre's time zone (see its header). A second copy of the constant
// here is how the studio starts printing a different hour from the site.
import { CENTRE_TIME_ZONE, centreZoneName } from "@/components/site/EventDateBlock";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { PagesTable, type StudioPageRow } from "./PagesTable";

/**
 * The Pages list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageStructure)` IS THE FIRST STATEMENT, and it is the same predicate the
 * `/api/studio/pages/*` handlers enforce. It THROWS rather than rendering: a failing permission check
 * renders nothing at all, never a screen of controls that will be refused (contract §1.8). Middleware
 * has already turned an anonymous request away, so this is the second of two guards, not the only one.
 *
 * A SERVER COMPONENT READING PRISMA DIRECTLY. The filters live in the URL, so narrowing this list is a
 * navigation and not a fetch — which is why there is no `useResource` here and no `null` "loading" row
 * state in `PagesTable` (see its header).
 *
 * "WHO EDITED IT LAST" TAKES TWO QUERIES, AND THAT IS THE CHEAP WAY. `Page` has no author column, so
 * the answer lives in the polymorphic `Revision` table — and "the newest revision for each of these
 * twenty-five pages" is a per-group maximum. `groupBy` asks for the version numbers and a second
 * `findMany` fetches exactly those rows. The alternatives are worse: `distinct` on a polymorphic table
 * relies on the connector pushing DISTINCT ON down, and fetching every revision for twenty-five pages
 * to reduce in memory reads thousands of rows to print twenty-five names.
 *
 * THE SORT PARAMETERS ARE READ BY HAND rather than through `readTableSort()`. That helper lives in
 * `components/studio/DataTable.tsx`, which is `"use client"` — every export of a client module becomes
 * a client reference in the server graph, so calling one here would throw at request time. The two
 * parameter names (`sort`, `dir`) and the ascending/descending vocabulary are DataTable's convention
 * and are matched exactly; only the reading is duplicated.
 *
 * NO `loading.tsx` FOR THIS SEGMENT, and none may be added: it would flush the response headers as
 * `200 OK` before the body is decided, turning any later `notFound()` beneath it into a soft-404
 * (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pages"
};

/** One screenful. Small enough that the whole list is scannable without scrolling twice. */
const PAGE_SIZE = 25;

const STATUSES: readonly ContentStatus[] = [
  "DRAFT",
  "IN_REVIEW",
  "SCHEDULED",
  "PUBLISHED",
  "ARCHIVED"
];

/** Which column a `?sort=` value orders by. Anything else falls back to the newest edit. */
const SORT_COLUMNS: Record<string, keyof Prisma.PageOrderByWithRelationInput> = {
  title: "title",
  slug: "slug",
  status: "status",
  updated: "updatedAt"
};

function firstValue(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

export default async function StudioPagesPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canManageStructure,
    "Pages need editor access or higher, because a page changes the shape of the public site. An administrator can raise yours."
  );

  const raw = await searchParams;
  const query = firstValue(raw.q).trim();
  const statusRaw = firstValue(raw.status);
  const status = STATUSES.find((value) => value === statusRaw) ?? null;
  const sortKey = firstValue(raw.sort);
  const direction = firstValue(raw.dir) === "asc" ? "asc" : "desc";
  const requestedPage = Number.parseInt(firstValue(raw.page), 10);
  const currentPage = Number.isFinite(requestedPage) && requestedPage > 1 ? requestedPage : 1;

  /**
   * The recycle bin is filtered out here and everywhere. A soft-deleted page belongs to
   * `/studio/recycle-bin`; listing it here would offer an editor a page that no longer answers.
   *
   * The search covers the TITLE AND THE ADDRESS, because an administrator hunting for a page knows one
   * or the other and rarely both — and `mode: "insensitive"` because nobody types their own page titles
   * back in the same case they wrote them.
   */
  const where: Prisma.PageWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(query.length > 0
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" as const } },
            { slug: { contains: query, mode: "insensitive" as const } },
            { navLabel: { contains: query, mode: "insensitive" as const } }
          ]
        }
      : {})
  };

  const column = SORT_COLUMNS[sortKey] ?? "updatedAt";
  const orderBy: Prisma.PageOrderByWithRelationInput[] =
    // A second key, always, so the order is TOTAL. Two pages sharing a status would otherwise come back
    // in whatever order the planner chose, and a list that reshuffles between requests looks like data
    // changing under the reader.
    column === "updatedAt"
      ? [{ updatedAt: direction }, { slug: "asc" }]
      : [{ [column]: direction } as Prisma.PageOrderByWithRelationInput, { slug: "asc" }];

  const [total, pageRows] = await prisma.$transaction([
    prisma.page.count({ where }),
    prisma.page.findMany({
      where,
      orderBy,
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        slug: true,
        navLabel: true,
        status: true,
        publishedAt: true,
        publishAt: true,
        unpublishAt: true,
        deletedAt: true,
        isSystem: true,
        updatedAt: true,
        _count: { select: { sections: true } }
      }
    })
  ]);

  // ── Who edited each of these last ────────────────────────────────────────
  const pageIds = pageRows.map((row) => row.id);

  const newestVersions =
    pageIds.length === 0
      ? []
      : await prisma.revision.groupBy({
          by: ["entityId"],
          where: { entityType: "Page", entityId: { in: pageIds } },
          _max: { version: true }
        });

  const newestPairs = newestVersions.flatMap((entry) =>
    entry._max.version === null ? [] : [{ entityId: entry.entityId, version: entry._max.version }]
  );

  const newestRevisions =
    newestPairs.length === 0
      ? []
      : await prisma.revision.findMany({
          where: { entityType: "Page", OR: newestPairs },
          select: { entityId: true, author: { select: { name: true } } }
        });

  const editorNames = new Map<string, string>();
  for (const revision of newestRevisions) {
    // A revision whose author has since been deleted keeps the revision but loses the name
    // (`onDelete: SetNull`). Saying so beats an empty cell that reads as a missing feature.
    editorNames.set(revision.entityId, revision.author?.name ?? "An account since removed");
  }

  const dateFormatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: CENTRE_TIME_ZONE
  });

  const now = new Date();

  const rows: StudioPageRow[] = pageRows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    path: pagePath(row.slug),
    navLabel: row.navLabel,
    status: row.status,
    // Resolved at READ time, from lib/content.ts — the one definition of "a visitor can reach this".
    // The status column alone would call a page whose `unpublishAt` has passed "Published".
    isLive: isLive(row, now),
    isSystem: row.isSystem,
    sectionCount: row._count.sections,
    updatedLabel: dateFormatter.format(row.updatedAt),
    lastEditedBy: editorNames.get(row.id) ?? null
  }));

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Pages"
        description="Every web address on the site that you build yourself, block by block. Pages marked “Built in” are ones the site's own code and menus rely on — they can be edited but not deleted."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 page" : `${total} pages`}
          </span>
        }
        actions={
          <LinkButton href="/studio/pages/new" icon={FilePlus2}>
            New page
          </LinkButton>
        }
      />

      <PagesTable
        rows={rows}
        total={total}
        page={currentPage}
        pageSize={PAGE_SIZE}
        siteOrigin={siteUrl().replace(/\/+$/, "")}
        filtersActive={query.length > 0 || status !== null}
        // The same predicate the DELETE handler checks. Hiding the control is for the reader's benefit;
        // the handler refusing it is the boundary (contract §1.7).
        canDelete={canManageStructure(user)}
        timeZoneLabel={centreZoneName(now, "long") || CENTRE_TIME_ZONE}
      />
    </div>
  );
}
