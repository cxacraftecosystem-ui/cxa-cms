import type { Metadata } from "next";
import type { ContentStatus, Prisma, PublicationKind } from "@prisma/client";
import { Plus, Upload } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { publicationDisplayVenue } from "@/lib/citation";
import { prisma } from "@/lib/db";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { FilterToolbar } from "@/components/studio/FilterToolbar";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { PublicationTable, type PublicationRow } from "./PublicationTable";

/**
 * Publications — the list, and the busiest filter set in the studio.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageResearch)` IS THE FIRST STATEMENT, and it throws rather than rendering
 * (contract §1.8).
 *
 * FIVE FILTERS, AND EACH ONE IS A QUESTION AN EDITOR ACTUALLY ASKS: what type is it, what year, which
 * research area, which of our people wrote it, and is it on the site yet. The search box covers the
 * title and the abstract, which is what the placeholder says — a reader hunting for a co-author uses
 * the author filter, because an external co-author exists only inside the author line and cannot be
 * filtered at all (schema, `Publication.authorLine`).
 *
 * THE AUTHOR FILTER IS THE CENTRE'S OWN PEOPLE, AND NOTHING ELSE. It joins `PublicationAuthor`, which
 * links only the subset of authors who have a profile here. That is stated under the toolbar, because
 * "filter by author" reasonably reads as "any author" and a list that came back short would look like
 * missing data.
 *
 * ⚠ EVERY CAP IS ON SCREEN. The year list, the area list and the author list are all capped, and each
 * says so when it bites. A filter list that quietly stops is indistinguishable from a corpus that
 * really does contain nothing before 2019 (contract §1.6).
 *
 * THE VENUE LINE COMES FROM `publicationDisplayVenue()`, the same function the public cards use, so a
 * journal reads identically in both halves of the product.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Publications"
};

const PAGE_SIZE = 25;

const AREA_OPTION_LIMIT = 60;
const AUTHOR_OPTION_LIMIT = 120;
const YEAR_OPTION_LIMIT = 120;

const STATUSES: readonly ContentStatus[] = ["DRAFT", "IN_REVIEW", "PUBLISHED", "ARCHIVED"];

/**
 * The words a reader uses for each kind.
 *
 * ⚠ A COPY, kept in step by hand with `app/(site)/publications/filters.ts` and
 * `components/sections/PublicationListSection.tsx`. That file's own header explains why each surface
 * carries its own: nothing outside those three files should depend on a public route's internals. One
 * publication cannot be a "Journal article" here and a "Paper" there.
 */
const KIND_LABELS: Record<PublicationKind, string> = {
  JOURNAL_ARTICLE: "Journal article",
  CONFERENCE_PAPER: "Conference paper",
  BOOK: "Book",
  BOOK_CHAPTER: "Book chapter",
  PATENT: "Patent",
  DATASET: "Dataset",
  SOFTWARE: "Software",
  PREPRINT: "Preprint",
  THESIS: "Thesis",
  REPORT: "Report",
  FLYER: "Flyer",
  BOOKLET: "Booklet"
};

/**
 * The order of the "Type" filter's options, mirroring `PUBLICATION_KIND_ORDER` in
 * app/(site)/publications/filters.ts.
 *
 * ⚠ UNLIKE `KIND_LABELS` THIS IS NOT A TOTAL RECORD, so a kind left out of it is not a compile error —
 * it is a type an editor can save a publication as and then never filter the table by. Check it
 * whenever the enum grows.
 */
const KIND_ORDER: readonly PublicationKind[] = [
  "JOURNAL_ARTICLE",
  "CONFERENCE_PAPER",
  "BOOK",
  "BOOK_CHAPTER",
  "PREPRINT",
  "PATENT",
  "DATASET",
  "SOFTWARE",
  "THESIS",
  "REPORT",
  "BOOKLET",
  "FLYER"
];

const SORT_KEYS = ["title", "year", "kind", "status", "updated"] as const;
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
    // Newest first is what a publication list is for.
    key: (SORT_KEYS as readonly string[]).includes(key) ? (key as SortKey) : "year",
    direction: dir === "asc" ? "asc" : "desc"
  };
}

/**
 * A TOTAL order for every sort.
 *
 * The final `id` key is not decoration: two publications in the same year with the same title are
 * ordinary in a proceedings volume, and without a unique tiebreaker Postgres may return them in either
 * order on either request — which pages one row into two adjacent pages and drops another entirely.
 */
function orderBy(sort: {
  key: SortKey;
  direction: "asc" | "desc";
}): Prisma.PublicationOrderByWithRelationInput[] {
  const dir = sort.direction;
  switch (sort.key) {
    case "title":
      return [{ title: dir }, { year: "desc" }, { id: "asc" }];
    case "kind":
      return [{ kind: dir }, { year: "desc" }, { id: "asc" }];
    case "status":
      return [{ status: dir }, { year: "desc" }, { id: "asc" }];
    case "updated":
      return [{ updatedAt: dir }, { id: "asc" }];
    case "year":
    default:
      return [{ year: dir }, { title: "asc" }, { id: "asc" }];
  }
}

function shortDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
}

export default async function StudioPublicationsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canManageResearch,
    "Publications need researcher access or higher. An administrator can raise yours."
  );

  const raw = await searchParams;
  const query = one(raw.q).trim().slice(0, 120);
  const statusValue = one(raw.status);
  const status = (STATUSES as readonly string[]).includes(statusValue)
    ? (statusValue as ContentStatus)
    : null;
  const kindValue = one(raw.kind);
  const kind = (KIND_ORDER as readonly string[]).includes(kindValue)
    ? (kindValue as PublicationKind)
    : null;
  const areaValue = one(raw.area);
  const authorValue = one(raw.author);
  const sort = readSort(raw);
  const pageNumber = Number.parseInt(one(raw.page), 10);
  const page = Number.isFinite(pageNumber) && pageNumber > 1 ? pageNumber : 1;

  const [areaRows, authorRows, yearRows] = await Promise.all([
    prisma.researchArea.findMany({
      where: { deletedAt: null },
      select: { slug: true, title: true },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      take: AREA_OPTION_LIMIT + 1
    }),
    // Only people who are actually linked to something: a filter offering three hundred names, most of
    // which return nothing, is a filter nobody uses twice.
    prisma.person.findMany({
      where: { deletedAt: null, publications: { some: {} } },
      select: { slug: true, name: true },
      orderBy: { name: "asc" },
      take: AUTHOR_OPTION_LIMIT + 1
    }),
    // `distinct` asks the database for the years that exist, rather than scanning rows and counting in
    // memory — so this list is exact rather than a sample.
    prisma.publication.findMany({
      where: { deletedAt: null },
      distinct: ["year"],
      select: { year: true },
      orderBy: { year: "desc" },
      take: YEAR_OPTION_LIMIT + 1
    })
  ]);

  const areasTruncated = areaRows.length > AREA_OPTION_LIMIT;
  const areas = areaRows.slice(0, AREA_OPTION_LIMIT);
  const authorsTruncated = authorRows.length > AUTHOR_OPTION_LIMIT;
  const authors = authorRows.slice(0, AUTHOR_OPTION_LIMIT);
  const yearsTruncated = yearRows.length > YEAR_OPTION_LIMIT;
  const years = yearRows.slice(0, YEAR_OPTION_LIMIT).map((row) => row.year);

  const parsedYear = Number.parseInt(one(raw.year), 10);
  const year = Number.isInteger(parsedYear) && years.includes(parsedYear) ? parsedYear : null;

  const where: Prisma.PublicationWhereInput = {
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(year !== null ? { year } : {}),
    ...(areaValue === "none"
      ? { researchAreaId: null }
      : areaValue.length > 0
        ? { researchArea: { slug: areaValue } }
        : {}),
    ...(authorValue.length > 0
      ? { authors: { some: { person: { slug: authorValue } } } }
      : {}),
    ...(query.length > 0
      ? {
          // Under `AND` rather than at the top level: a top-level `OR` would overwrite any `OR` a
          // publication-state filter needs the day this model gains scheduling columns.
          AND: [
            {
              OR: [
                { title: { contains: query, mode: "insensitive" } },
                { abstract: { contains: query, mode: "insensitive" } }
              ]
            }
          ]
        }
      : {})
  };

  const [rows, totalItems] = await prisma.$transaction([
    prisma.publication.findMany({
      where,
      orderBy: orderBy(sort),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        title: true,
        slug: true,
        kind: true,
        year: true,
        authorLine: true,
        venue: true,
        publisher: true,
        volume: true,
        issue: true,
        patentNumber: true,
        arxivId: true,
        doi: true,
        status: true,
        isFeatured: true,
        pdfFileId: true,
        updatedAt: true,
        researchArea: { select: { title: true } },
        _count: { select: { authors: true } }
      }
    }),
    prisma.publication.count({ where })
  ]);

  const tableRows: PublicationRow[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug,
    kindLabel: KIND_LABELS[row.kind],
    year: row.year,
    authorLine: row.authorLine,
    // The same one-line venue the public cards render, from lib/citation.ts.
    venueLabel: publicationDisplayVenue({
      kind: row.kind,
      title: row.title,
      authorLine: row.authorLine,
      year: row.year,
      venue: row.venue,
      publisher: row.publisher,
      volume: row.volume,
      issue: row.issue,
      patentNumber: row.patentNumber,
      arxivId: row.arxivId
    }),
    areaTitle: row.researchArea?.title ?? null,
    linkedAuthorCount: row._count.authors,
    hasDoi: Boolean(row.doi && row.doi.trim().length > 0),
    hasPdf: row.pdfFileId !== null,
    isFeatured: row.isFeatured,
    status: row.status,
    updatedLabel: shortDate(row.updatedAt)
  }));

  const search = new URLSearchParams();
  if (query.length > 0) search.set("q", query);
  if (status) search.set("status", status);
  if (kind) search.set("kind", kind);
  if (year !== null) search.set("year", String(year));
  if (areaValue.length > 0) search.set("area", areaValue);
  if (authorValue.length > 0) search.set("author", authorValue);
  search.set("sort", sort.key);
  search.set("dir", sort.direction);
  const baseHref = `/studio/publications?${search.toString()}`;

  const filtered =
    query.length > 0 ||
    status !== null ||
    kind !== null ||
    year !== null ||
    areaValue.length > 0 ||
    authorValue.length > 0;

  return (
    <div className="mx-auto w-full max-w-[110rem] space-y-6">
      <StudioPageHeader
        title="Publications"
        description="Papers, chapters, books, patents, datasets and software. The author line and the DOI are the two fields other people quote, so they are worth checking twice."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {totalItems === 1 ? "1 publication" : `${totalItems} publications`}
          </span>
        }
        actions={
          <>
            <LinkButton href="/studio/publications/import" variant="secondary" icon={Upload}>
              Import from BibTeX or DOIs
            </LinkButton>
            <LinkButton href="/studio/publications/new" icon={Plus}>
              New publication
            </LinkButton>
          </>
        }
      >
        <FilterToolbar
          search={{
            label: "Search publications",
            placeholder: "Words in the title or the abstract"
          }}
          status={{ statuses: STATUSES }}
          selects={[
            {
              key: "kind",
              label: "Type",
              options: KIND_ORDER.map((value) => ({ value, label: KIND_LABELS[value] }))
            },
            {
              key: "year",
              label: "Year",
              options: years.map((value) => ({ value: String(value), label: String(value) }))
            },
            {
              key: "area",
              label: "Research area",
              options: [
                ...areas.map((area) => ({ value: area.slug, label: area.title })),
                // A reserved word, because an empty value cannot be told from "no filter".
                { value: "none", label: "Not filed under an area" }
              ]
            },
            {
              key: "author",
              label: "Author at the Centre",
              placeholder: "Anyone at the Centre",
              options: authors.map((person) => ({ value: person.slug, label: person.name }))
            }
          ]}
        />

        <div className="mt-3 space-y-1.5">
          <HelpText>
            The author filter lists people who have a profile here and are linked to at least one
            publication. Co-authors from other institutions cannot be filtered on — they are part of the
            printed author line rather than records of their own.
          </HelpText>
          {yearsTruncated ? (
            <HelpText>
              The year filter lists the {YEAR_OPTION_LIMIT} most recent years that have a publication in
              them. Earlier years exist and are still in the list itself.
            </HelpText>
          ) : null}
          {areasTruncated ? (
            <HelpText>
              The research area filter lists the first {AREA_OPTION_LIMIT} areas by position. There are
              more.
            </HelpText>
          ) : null}
          {authorsTruncated ? (
            <HelpText>
              The author filter lists the first {AUTHOR_OPTION_LIMIT} people alphabetically. There are
              more; use the search box for a title instead.
            </HelpText>
          ) : null}
        </div>
      </StudioPageHeader>

      <PublicationTable
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
        label="Publications"
        itemNoun={{ singular: "publication", plural: "publications" }}
      />
    </div>
  );
}
