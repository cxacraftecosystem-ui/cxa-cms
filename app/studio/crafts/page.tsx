import type { Metadata } from "next";
import Link from "next/link";
import type { ContentStatus, Prisma } from "@prisma/client";
import { MapPin, Plus } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { CraftTable, type CraftRow } from "./CraftTable";

/**
 * The craft archive — the list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageResearch)` IS THE FIRST STATEMENT, and it throws rather than rendering
 * (contract §1.8).
 *
 * THE ORIGIN YEAR IS FORMATTED HERE, AND A NEGATIVE NUMBER MEANS BCE. `-3000` in the column would be
 * read as a data error by every reader who met it; "c. 3000 BCE" is the same number said properly. The
 * "c." is not decoration either — the schema calls this an approximate year, and a bare "3000 BCE"
 * claims a precision no craft historian would sign.
 *
 * DATES AND YEARS ARE FORMATTED ON THE SERVER, because a client component is server-rendered first and
 * formatting inside one runs in two different time zones.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Craft archive"
};

const PAGE_SIZE = 25;
const REGION_OPTION_LIMIT = 80;
const SCHOOL_OPTION_LIMIT = 80;

const STATUSES: readonly ContentStatus[] = ["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"];

const SORT_KEYS = ["name", "origin", "status", "updated"] as const;
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
    key: (SORT_KEYS as readonly string[]).includes(key) ? (key as SortKey) : "name",
    direction: dir === "desc" ? "desc" : "asc"
  };
}

function orderBy(sort: {
  key: SortKey;
  direction: "asc" | "desc";
}): Prisma.CraftOrderByWithRelationInput[] {
  const dir = sort.direction;
  switch (sort.key) {
    case "origin":
      // `nulls: "last"` — "sometime in the medieval period" is a real answer, and a craft with no year
      // belongs at the end of a chronological list rather than at the start of it.
      return [{ originYear: { sort: dir, nulls: "last" } }, { name: "asc" }];
    case "status":
      return [{ status: dir }, { name: "asc" }];
    case "updated":
      return [{ updatedAt: dir }, { name: "asc" }];
    case "name":
    default:
      return [{ name: dir }];
  }
}

/**
 * An approximate origin year as a person would write it.
 *
 * A NEGATIVE YEAR IS BCE — that is the whole convention in the column, and the only place in this
 * product where a minus sign carries meaning rather than being a mistake.
 */
function originLabel(year: number | null): string | null {
  if (year === null) return null;
  if (year < 0) return `c. ${Math.abs(year)} BCE`;
  return `c. ${year}`;
}

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
}

export default async function StudioCraftsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canManageResearch,
    "The craft archive needs researcher access or higher. An administrator can raise yours."
  );

  const raw = await searchParams;
  const query = one(raw.q).trim();
  const statusValue = one(raw.status);
  const status = (STATUSES as readonly string[]).includes(statusValue)
    ? (statusValue as ContentStatus)
    : null;
  const regionValue = one(raw.region);
  const schoolValue = one(raw.school);
  const sort = readSort(raw);
  const pageNumber = Number.parseInt(one(raw.page), 10);
  const page = Number.isFinite(pageNumber) && pageNumber > 1 ? pageNumber : 1;

  const [regionRows, schoolRows] = await Promise.all([
    prisma.craftRegion.findMany({
      select: { slug: true, name: true, level: true },
      orderBy: { name: "asc" },
      take: REGION_OPTION_LIMIT + 1
    }),
    prisma.craftSchool.findMany({
      select: { slug: true, name: true },
      orderBy: { name: "asc" },
      take: SCHOOL_OPTION_LIMIT + 1
    })
  ]);

  const regionsTruncated = regionRows.length > REGION_OPTION_LIMIT;
  const regions = regionRows.slice(0, REGION_OPTION_LIMIT);
  const schoolsTruncated = schoolRows.length > SCHOOL_OPTION_LIMIT;
  const schools = schoolRows.slice(0, SCHOOL_OPTION_LIMIT);

  const where: Prisma.CraftWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(regionValue === "none"
      ? { regionId: null }
      : regionValue.length > 0
        ? { region: { slug: regionValue } }
        : {}),
    ...(schoolValue === "none"
      ? { schoolId: null }
      : schoolValue.length > 0
        ? { school: { slug: schoolValue } }
        : {}),
    ...(query.length > 0
      ? {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            // The local name is searched too, so an editor who knows the craft by its own name in its
            // own script can find it by pasting that.
            { localName: { contains: query, mode: "insensitive" } },
            { summary: { contains: query, mode: "insensitive" } },
            { slug: { contains: query, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [rows, totalItems] = await prisma.$transaction([
    prisma.craft.findMany({
      where,
      orderBy: orderBy(sort),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        slug: true,
        localName: true,
        localNameLang: true,
        originYear: true,
        materials: true,
        techniques: true,
        modelObjectKey: true,
        status: true,
        isFeatured: true,
        updatedAt: true,
        region: { select: { name: true, level: true } },
        school: { select: { name: true } },
        _count: { select: { media: true } }
      }
    }),
    prisma.craft.count({ where })
  ]);

  const tableRows: CraftRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    localName: row.localName,
    localNameLang: row.localNameLang,
    originLabel: originLabel(row.originYear),
    regionName: row.region?.name ?? null,
    regionLevel: row.region?.level ?? null,
    schoolName: row.school?.name ?? null,
    materialCount: row.materials.length,
    techniqueCount: row.techniques.length,
    mediaCount: row._count.media,
    hasModel: row.modelObjectKey !== null,
    isFeatured: row.isFeatured,
    status: row.status,
    updatedLabel: shortDate(row.updatedAt)
  }));

  const search = new URLSearchParams();
  if (query.length > 0) search.set("q", query);
  if (status) search.set("status", status);
  if (regionValue.length > 0) search.set("region", regionValue);
  if (schoolValue.length > 0) search.set("school", schoolValue);
  search.set("sort", sort.key);
  search.set("dir", sort.direction);
  const baseHref = `/studio/crafts?${search.toString()}`;

  const filtered =
    query.length > 0 || status !== null || regionValue.length > 0 || schoolValue.length > 0;

  return (
    <div className="mx-auto w-full max-w-[104rem] space-y-6">
      <StudioPageHeader
        title="Craft archive"
        description="The living record of crafts: where each one comes from, what it is made of, how it is made, and the photographs and 3D scans that document it."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {totalItems === 1 ? "1 craft" : `${totalItems} crafts`}
          </span>
        }
        actions={
          <>
            {/*
              The coordinates screen shares this page's own predicate (`canManageResearch`), so the
              link needs no gate of its own — nobody who can stand here is refused there (contract
              §1.7). Without a link the screen is reachable only by typing the address, the defect
              StudioNav.ts records this repository producing eight times.
            */}
            <Link
              href="/studio/crafts/regions"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
            >
              <MapPin aria-hidden="true" className="h-4 w-4" />
              Regions on the map
            </Link>

            <LinkButton href="/studio/crafts/new" icon={Plus}>
              New craft record
            </LinkButton>
          </>
        }
      >
        <FilterToolbar
          search={{
            label: "Search crafts",
            placeholder: "Name, local name or summary"
          }}
          status={{ statuses: STATUSES }}
          selects={[
            {
              key: "region",
              label: "Region",
              options: [
                ...regions.map((region) => ({
                  value: region.slug,
                  // The level is in the label because "Jaipur" as a district and "Jaipur" as a cluster
                  // are two different places in this archive.
                  label: `${region.name} (${region.level.toLowerCase()})`
                })),
                { value: "none", label: "No region recorded" }
              ]
            },
            {
              key: "school",
              label: "School or tradition",
              options: [
                ...schools.map((school) => ({ value: school.slug, label: school.name })),
                { value: "none", label: "No school recorded" }
              ]
            }
          ]}
        />

        {regionsTruncated || schoolsTruncated ? (
          <div className="mt-3 space-y-1.5">
            {regionsTruncated ? (
              <HelpText>
                The region filter lists the first {REGION_OPTION_LIMIT} regions alphabetically. There are
                more.
              </HelpText>
            ) : null}
            {schoolsTruncated ? (
              <HelpText>
                The school filter lists the first {SCHOOL_OPTION_LIMIT} schools alphabetically. There are
                more.
              </HelpText>
            ) : null}
          </div>
        ) : null}
      </StudioPageHeader>

      <CraftTable
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
        label="Crafts"
        itemNoun={{ singular: "craft", plural: "crafts" }}
      />
    </div>
  );
}
