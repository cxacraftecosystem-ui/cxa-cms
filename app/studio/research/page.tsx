import type { Metadata } from "next";
import type { ContentStatus, Prisma } from "@prisma/client";
import { Plus } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { ResearchAreaTable, type ResearchAreaRow } from "./ResearchAreaTable";

/**
 * Research areas — the list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageResearch)` IS THE FIRST STATEMENT, and it is the same predicate the
 * `/api/studio/research/*` handlers call. It THROWS rather than rendering — a failing permission check
 * renders nothing at all, never a screen of disabled controls (contract §1.8).
 *
 * A SERVER COMPONENT READING PRISMA DIRECTLY. The filters live in the URL, so changing one is a
 * navigation and this function runs again with the new answer; there is no client-side list fetch and
 * therefore no fetch race to guard. `FilterToolbar` and `DataTable` write the URL, Next re-renders,
 * and an administrator who hits a row lands on it with no hydration in between.
 *
 * ⚠ THE TABLE ITSELF IS A CLIENT COMPONENT AND HAS TO BE. `DataTable`'s columns carry `render`
 * FUNCTIONS and its row menu carries `onSelect` callbacks, and a function cannot cross the server →
 * client boundary. So this file does the guard, the query and the page frame; `ResearchAreaTable.tsx`
 * owns the table. The same split is used by every list screen in this group.
 *
 * ⚠ AND `readTableSort` FROM DataTable IS DELIBERATELY NOT IMPORTED HERE. Every export of a
 * `"use client"` module becomes a client reference, so calling one on the server fails at request time
 * rather than at build time. The two parameter names — `sort` and `dir` — are the contract, and
 * `readSort` below reads them the same way the table writes them.
 *
 * DATES ARE FORMATTED HERE, NOT IN THE TABLE. A client component is server-rendered first, so
 * `toLocaleDateString()` inside one runs once in the server's time zone and again in the reader's, and
 * React resolves the mismatch by keeping whichever it likes. Formatting on the server and passing a
 * finished string means the two can never disagree.
 *
 * NO `loading.tsx` FOR THIS SEGMENT, and none may be added: it would flush the response headers as
 * `200 OK` before `notFound()` in `[id]` had a chance to decide otherwise (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Research areas"
};

/** Rows per page. Thirty fits a laptop screen without the reader losing the header. */
const PAGE_SIZE = 30;

/** The statuses this list can hold. Research areas carry `status` only — they cannot be scheduled. */
const STATUSES: readonly ContentStatus[] = ["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"];

/** Sort keys the table offers, mapped to what the database is asked for. */
const SORT_KEYS = ["title", "order", "status", "updated"] as const;
type SortKey = (typeof SORT_KEYS)[number];

/** One value out of a query parameter. A repeated key is a hand-edited link; the first one wins. */
function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function readSort(raw: Record<string, string | string[] | undefined>): {
  key: SortKey;
  direction: "asc" | "desc";
} {
  const key = one(raw.sort);
  const dir = one(raw.dir);
  return {
    key: (SORT_KEYS as readonly string[]).includes(key) ? (key as SortKey) : "order",
    direction: dir === "desc" ? "desc" : "asc"
  };
}

/**
 * A date the reader can read. UTC is named in the column heading rather than guessed at: the Centre's
 * display time zone is a setting, and a bare date beside a record is one somebody will mis-read.
 */
function shortDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
}

function orderBy(sort: {
  key: SortKey;
  direction: "asc" | "desc";
}): Prisma.ResearchAreaOrderByWithRelationInput[] {
  const dir = sort.direction;
  switch (sort.key) {
    case "title":
      return [{ title: dir }];
    case "status":
      // Ties break on title, so the order is TOTAL. An unstable sort renders a different list on every
      // request and looks exactly like data changing underneath the reader.
      return [{ status: dir }, { title: "asc" }];
    case "updated":
      return [{ updatedAt: dir }, { title: "asc" }];
    case "order":
    default:
      return [{ sortOrder: dir }, { title: "asc" }];
  }
}

export default async function StudioResearchPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canManageResearch,
    "Research areas need researcher access or higher. An administrator can raise yours."
  );

  const raw = await searchParams;
  const query = one(raw.q).trim();
  const statusFilter = one(raw.status);
  const status = (STATUSES as readonly string[]).includes(statusFilter)
    ? (statusFilter as ContentStatus)
    : null;
  const sort = readSort(raw);
  const pageNumber = Number.parseInt(one(raw.page), 10);
  const page = Number.isFinite(pageNumber) && pageNumber > 1 ? pageNumber : 1;

  // The recycle bin is filtered out of every read path. A soft-deleted area belongs to
  // /studio/recycle-bin, and listing it here would offer a heading the public site no longer renders.
  const where: Prisma.ResearchAreaWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(query.length > 0
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { summary: { contains: query, mode: "insensitive" } },
            { slug: { contains: query, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [rows, totalItems] = await prisma.$transaction([
    prisma.researchArea.findMany({
      where,
      orderBy: orderBy(sort),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        slug: true,
        summary: true,
        icon: true,
        accentColor: true,
        sortOrder: true,
        status: true,
        updatedAt: true,
        // Filtered relation counts, so the number beside an area does not include work that is in the
        // recycle bin — and one query rather than two per row.
        _count: {
          select: {
            projects: { where: { deletedAt: null } },
            publications: { where: { deletedAt: null } }
          }
        }
      }
    }),
    prisma.researchArea.count({ where })
  ]);

  const tableRows: ResearchAreaRow[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    icon: row.icon,
    accentColor: row.accentColor,
    sortOrder: row.sortOrder,
    status: row.status,
    projectCount: row._count.projects,
    publicationCount: row._count.publications,
    updatedLabel: shortDate(row.updatedAt)
  }));

  // Everything the toolbar and the table do not own is preserved, so a sorted, filtered view stays
  // sorted and filtered as the reader pages through it.
  const search = new URLSearchParams();
  if (query.length > 0) search.set("q", query);
  if (status) search.set("status", status);
  search.set("sort", sort.key);
  search.set("dir", sort.direction);
  const baseHref = `/studio/research?${search.toString()}`;

  return (
    <div className="mx-auto w-full max-w-[96rem] space-y-6">
      <StudioPageHeader
        title="Research areas"
        description="The themes the Centre works on. Every project and every publication is filed under one of these, and the research page draws its diagram from them — so an area with nothing filed under it appears on the site as an empty heading."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {totalItems === 1 ? "1 area" : `${totalItems} areas`}
          </span>
        }
        actions={
          <LinkButton href="/studio/research/new" icon={Plus}>
            New research area
          </LinkButton>
        }
      >
        <FilterToolbar
          search={{ label: "Search research areas", placeholder: "Name, summary or web address" }}
          status={{ statuses: STATUSES }}
        />
      </StudioPageHeader>

      <ResearchAreaTable
        rows={tableRows}
        totalItems={totalItems}
        filtered={query.length > 0 || status !== null}
        // The same predicates the route handlers enforce. Hiding a control here is a courtesy; the
        // handler refusing it is the boundary (contract §1.7).
        canDelete={canManageResearch(user)}
        canPublish={canPublish(user)}
      />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        totalItems={totalItems}
        baseHref={baseHref}
        label="Research areas"
        itemNoun={{ singular: "research area", plural: "research areas" }}
      />
    </div>
  );
}
