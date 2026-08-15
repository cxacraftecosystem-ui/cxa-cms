import type { Metadata } from "next";
import type { ContentStatus, Prisma, ProjectStatus } from "@prisma/client";
import { Plus } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { unique } from "@/lib/utils";
import { LinkButton } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { ProjectTable, type ProjectRow } from "./ProjectTable";

/**
 * Projects — the list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageResearch)` IS THE FIRST STATEMENT, and it throws rather than rendering
 * (contract §1.8). The same predicate guards `/api/studio/projects/*`.
 *
 * THE FILTERS ARE THE SAME THREE THE PUBLIC LISTING OFFERS — stage, research area, start year — and
 * they are worded the same way on purpose. An editor who filters "Start year 2024" here and sends a
 * colleague to `/projects?year=2024` must get the same set back, and the fastest way for the two to
 * disagree is for one of them to mean "running in 2024" while the other means "began in 2024".
 *
 * ⚠ THE YEAR LIST IS BUILT FROM A CAPPED SCAN, AND THE CAP IS ON SCREEN. It is derived from the most
 * recently started projects, so a truncated scan loses the OLDEST years — which is exactly what the
 * note under the toolbar says. A filter list that quietly stops is indistinguishable from a Centre
 * that has done nothing before 2019 (contract §1.6).
 *
 * ⚠ `area=none` IS A RESERVED VALUE, not an empty one. `buildQuery` drops the empty string, so
 * "filed under nothing" cannot be spelled as `area=` — it needs a word (lib/client/fetcher.ts).
 *
 * DATES ARE FORMATTED HERE, NOT IN THE TABLE: a client component is server-rendered first, so
 * formatting inside one runs in two different time zones and React keeps whichever it likes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Projects"
};

const PAGE_SIZE = 25;

/** Enough research areas for any real Centre. A truncated list is stated on screen. */
const AREA_OPTION_LIMIT = 60;

/**
 * How many projects the year list is derived from. Scanned newest-first, so a truncated scan loses the
 * OLDEST years — which is what the note under the toolbar says.
 */
const YEAR_SCAN_LIMIT = 500;

const STATUSES: readonly ContentStatus[] = ["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"];

/**
 * The stages, in the order an editor thinks about them.
 *
 * ⚠ The wording must stay in step with `app/(site)/projects/page.tsx`,
 * `components/sections/ProjectShowcaseSection.tsx` and this group's `ProjectTable`. One project cannot
 * be "Active" here and "In progress" there.
 */
const STAGE_ORDER: readonly ProjectStatus[] = ["ACTIVE", "COMPLETED", "PROPOSED", "ON_HOLD"];
const STAGE_LABELS: Record<ProjectStatus, string> = {
  ACTIVE: "Active",
  COMPLETED: "Completed",
  PROPOSED: "Proposed",
  ON_HOLD: "On hold"
};

const SORT_KEYS = ["title", "stage", "started", "progress", "updated"] as const;
type SortKey = (typeof SORT_KEYS)[number];

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
    key: (SORT_KEYS as readonly string[]).includes(key) ? (key as SortKey) : "updated",
    direction: dir === "asc" ? "asc" : "desc"
  };
}

function orderBy(sort: {
  key: SortKey;
  direction: "asc" | "desc";
}): Prisma.ProjectOrderByWithRelationInput[] {
  const dir = sort.direction;
  switch (sort.key) {
    case "title":
      return [{ title: dir }];
    case "stage":
      // Ties break on title so the order is total and never reshuffles between two requests.
      return [{ state: dir }, { title: "asc" }];
    case "started":
      // `nulls: "last"` — a project with no start date belongs at the end of a date order, not at the
      // top of it where it reads as the newest thing the Centre has done.
      return [{ startedOn: { sort: dir, nulls: "last" } }, { title: "asc" }];
    case "progress":
      return [{ progress: dir }, { title: "asc" }];
    case "updated":
    default:
      return [{ updatedAt: dir }, { title: "asc" }];
  }
}

/** A year range as a person would write it: "2021–2024", "2021 onwards", "—". */
function yearRange(startedOn: Date | null, endedOn: Date | null): string {
  const from = startedOn ? String(startedOn.getUTCFullYear()) : null;
  const to = endedOn ? String(endedOn.getUTCFullYear()) : null;
  if (from && to) return from === to ? from : `${from}–${to}`;
  if (from) return `${from} onwards`;
  if (to) return `Until ${to}`;
  return "No dates";
}

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
}

export default async function StudioProjectsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canManageResearch,
    "Projects need researcher access or higher. An administrator can raise yours."
  );

  const raw = await searchParams;
  const query = one(raw.q).trim();
  const statusValue = one(raw.status);
  const status = (STATUSES as readonly string[]).includes(statusValue)
    ? (statusValue as ContentStatus)
    : null;
  const stageValue = one(raw.state);
  const stage = (STAGE_ORDER as readonly string[]).includes(stageValue)
    ? (stageValue as ProjectStatus)
    : null;
  const areaValue = one(raw.area);
  const sort = readSort(raw);
  const pageNumber = Number.parseInt(one(raw.page), 10);
  const page = Number.isFinite(pageNumber) && pageNumber > 1 ? pageNumber : 1;

  const [areaRows, yearScan] = await Promise.all([
    prisma.researchArea.findMany({
      where: { deletedAt: null },
      select: { slug: true, title: true },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      take: AREA_OPTION_LIMIT + 1
    }),
    prisma.project.findMany({
      where: { deletedAt: null, startedOn: { not: null } },
      select: { startedOn: true },
      orderBy: { startedOn: "desc" },
      take: YEAR_SCAN_LIMIT + 1
    })
  ]);

  const areasTruncated = areaRows.length > AREA_OPTION_LIMIT;
  const areas = areaRows.slice(0, AREA_OPTION_LIMIT);

  const yearScanTruncated = yearScan.length > YEAR_SCAN_LIMIT;
  const years = unique(
    yearScan
      .slice(0, YEAR_SCAN_LIMIT)
      .map((row) => row.startedOn?.getUTCFullYear() ?? null)
      .filter((year): year is number => typeof year === "number" && Number.isFinite(year))
  ).sort((a, b) => b - a);

  const parsedYear = Number.parseInt(one(raw.year), 10);
  const year = Number.isFinite(parsedYear) && years.includes(parsedYear) ? parsedYear : null;

  const where: Prisma.ProjectWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(stage ? { state: stage } : {}),
    ...(areaValue === "none"
      ? { researchAreaId: null }
      : areaValue.length > 0
        ? { researchArea: { slug: areaValue } }
        : {}),
    ...(year !== null
      ? {
          startedOn: {
            gte: new Date(Date.UTC(year, 0, 1)),
            lt: new Date(Date.UTC(year + 1, 0, 1))
          }
        }
      : {}),
    ...(query.length > 0
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { tagline: { contains: query, mode: "insensitive" } },
            { summary: { contains: query, mode: "insensitive" } },
            { fundingBody: { contains: query, mode: "insensitive" } },
            { slug: { contains: query, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [rows, totalItems] = await prisma.$transaction([
    prisma.project.findMany({
      where,
      orderBy: orderBy(sort),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        slug: true,
        state: true,
        status: true,
        progress: true,
        startedOn: true,
        endedOn: true,
        fundingBody: true,
        fundingAmount: true,
        fundingCurrency: true,
        updatedAt: true,
        researchArea: { select: { title: true } },
        _count: { select: { members: true, milestones: true } }
      }
    }),
    prisma.project.count({ where })
  ]);

  const tableRows: ProjectRow[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    state: row.state,
    status: row.status,
    progress: row.progress,
    yearsLabel: yearRange(row.startedOn, row.endedOn),
    areaTitle: row.researchArea?.title ?? null,
    fundingBody: row.fundingBody,
    // The amount and its currency, exactly as an editor typed them — see the editor's header.
    fundingLabel:
      row.fundingAmount && row.fundingAmount.trim().length > 0
        ? [row.fundingCurrency?.trim(), row.fundingAmount.trim()].filter(Boolean).join(" ")
        : null,
    memberCount: row._count.members,
    milestoneCount: row._count.milestones,
    updatedLabel: shortDate(row.updatedAt)
  }));

  const search = new URLSearchParams();
  if (query.length > 0) search.set("q", query);
  if (status) search.set("status", status);
  if (stage) search.set("state", stage);
  if (areaValue.length > 0) search.set("area", areaValue);
  if (year !== null) search.set("year", String(year));
  search.set("sort", sort.key);
  search.set("dir", sort.direction);
  const baseHref = `/studio/projects?${search.toString()}`;

  const filtered =
    query.length > 0 || status !== null || stage !== null || areaValue.length > 0 || year !== null;

  return (
    <div className="mx-auto w-full max-w-[104rem] space-y-6">
      <StudioPageHeader
        title="Projects"
        description="Funded and in-house research: who is on it, how far along it is, what it has produced. Everything on a project's screen appears on its page on the public site."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {totalItems === 1 ? "1 project" : `${totalItems} projects`}
          </span>
        }
        actions={
          <LinkButton href="/studio/projects/new" icon={Plus}>
            New project
          </LinkButton>
        }
      >
        <FilterToolbar
          search={{
            label: "Search projects",
            placeholder: "Title, tagline, summary or funder"
          }}
          status={{ statuses: STATUSES }}
          selects={[
            {
              key: "state",
              label: "Stage",
              options: STAGE_ORDER.map((value) => ({ value, label: STAGE_LABELS[value] }))
            },
            {
              key: "area",
              label: "Research area",
              options: [
                ...areas.map((area) => ({ value: area.slug, label: area.title })),
                // A reserved word, not an empty value — see the header.
                { value: "none", label: "Not filed under an area" }
              ]
            },
            {
              key: "year",
              label: "Start year",
              placeholder: "Any start year",
              options: years.map((value) => ({ value: String(value), label: String(value) }))
            }
          ]}
        />

        {areasTruncated || yearScanTruncated ? (
          <div className="mt-3 space-y-1.5">
            {areasTruncated ? (
              <HelpText>
                The research area filter lists the first {AREA_OPTION_LIMIT} areas by position. There are
                more; search by name instead if the one you want is missing.
              </HelpText>
            ) : null}
            {yearScanTruncated ? (
              <HelpText>
                The start year filter is built from the {YEAR_SCAN_LIMIT} most recently started projects,
                so years earlier than the oldest one listed may be missing from it.
              </HelpText>
            ) : null}
          </div>
        ) : null}
      </StudioPageHeader>

      <ProjectTable
        rows={tableRows}
        totalItems={totalItems}
        filtered={filtered}
        canDelete={canManageResearch(user)}
        canPublish={canPublish(user)}
      />

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        totalItems={totalItems}
        baseHref={baseHref}
        label="Projects"
        itemNoun={{ singular: "project", plural: "projects" }}
      />
    </div>
  );
}
