import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { BookOpen, ExternalLink, FileDown, SearchX } from "lucide-react";

import { Reveal } from "@/components/motion";
import { CitationBlock } from "@/components/site/CitationBlock";
import { FilterBar, type FilterGroup, type FilterOption } from "@/components/site/FilterBar";
import { PageHero } from "@/components/site/PageHero";
import { ResultSummary } from "@/components/site/ResultSummary";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Badge } from "@/components/ui/Badge";
import { buttonClasses, LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { publicationDisplayVenue, resolveBibtex } from "@/lib/citation";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { pageMetadata } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { cn, truncateWords } from "@/lib/utils";

import {
  BIBTEX_EXPORT_CAP,
  bibtexExportHref,
  buildCitations,
  doiUrl,
  hasPublicationFilters,
  parsePublicationFilters,
  PUBLICATION_KIND_LABELS,
  PUBLICATION_PARAMS,
  PUBLICATION_SORTS,
  PUBLICATIONS_PAGE_SIZE,
  PUBLICATIONS_RESULT_CAP,
  publicationOrderBy,
  publicationsHref,
  publicationWhere,
  type PublicationFilters
} from "./filters";

/**
 * /publications — the reference index.
 *
 * A SERVER COMPONENT. Every filter lives in the query string, so a filtered view is a link somebody can
 * send, cite in an email and come back to, and a reader with no JavaScript still receives the filtered,
 * paged list in the HTML — they simply cannot change it. `FilterBar` is the only client piece, and it
 * writes the URL rather than holding a copy of the state.
 *
 * IT IS A LIST, NOT A GRID OF CARDS. A publication is read as a CITATION — authors, title, where it
 * appeared, year — and cards would give each one a photograph-shaped hole and fit four to a screen. A
 * list fits twenty and is the shape an academic reader is already scanning for.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE EXPORT AND THE PAGE CANNOT DISAGREE. Both parse the query string with
 * `parsePublicationFilters` and build their query with `publicationWhere` from
 * `app/(site)/publications/filters.ts`. The button says how many entries the file will contain,
 * computed from the same count the summary above the list is computed from. Exporting the whole corpus
 * to a reader who has narrowed to one year is the failure this arrangement exists to prevent.
 *
 * `features.publications` GATES THE WHOLE SURFACE — with it off, this page, every citation page and the
 * BibTeX export are 404, matching what the setting promises in lib/settings/schema.ts and what the three
 * other surface flags already do. A flag that removed only the navigation entry would leave an
 * administrator believing the bibliography was down while it went on answering and being indexed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * TWO SENTENCES ABOUT THE SIZE OF THE LIST, ONE LIVE REGION. `ResultSummary` sits above the list and
 * owns the truncation sentence — the one thing `Pagination` cannot say, because a page count cannot
 * tell you the list stopped short. `Pagination` sits below and renders its own range line beside the
 * page numbers, where it belongs. Only Pagination's is a `role="status"` (ResultSummary's `announce` is
 * off by default), so a screen reader is told the range exactly once.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE `Reveal` FOR THE WHOLE LIST, AND NEVER ONE PER ROW.
 *
 * The list enters on the house reveal because every sibling index does — a bibliography that simply
 * exists on a site where the newsroom, the gallery and the projects all rise into place reads as a
 * page that failed to load rather than as restraint.
 *
 * But a `Reveal` per entry would be twenty IntersectionObservers, twenty inline `opacity: 0`s in the
 * server HTML, and twenty separate fades on the one page a reader scrolls fastest. `CardGrid` staggers
 * a grid of twelve cards because a card is a tile that arrives; a citation is a line in a reference
 * list, and reference lists do not arrive one line at a time. So the SECTION rises as a unit and the
 * rows inside it are simply the section.
 *
 * ⚠ `amount="some"` IS NOT DECORATION HERE. framer hands `amount` to an IntersectionObserver as a
 * threshold, and twenty citations with abstracts and citation blocks run well past three viewports —
 * past which 0.3 of the element can never be on screen at once, so the DEFAULT WOULD NEVER FIRE and
 * the whole bibliography would sit at `opacity: 0` for ever. components/sections/RichTextSection.tsx
 * carries the same warning for the same reason; this is the second place on the site tall enough to
 * hit it.
 *
 * ⚠ THE WRAPPER TAKES NO KEY, ON PURPOSE. `q` is written on a debounce by `FilterBar`, so these rows
 * re-render while the reader is still typing. A wrapper at a fixed position in the tree with no key is
 * reconciled rather than remounted, so `once` holds and the entrance plays on arrival and never again
 * as the list narrows. Anything that made its identity depend on the matched rows — a key of the year,
 * of the query, of the count — would turn the entrance into a flicker book.
 *
 * The sticky year headings sit INSIDE that wrapper. framer writes `transform` while the entrance runs
 * and `transform: none` once it settles, so a heading pins normally at rest and rides up with its own
 * rows for the half second it is arriving, which is what it should do.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Stated rather than inferred. Reading `searchParams` already opts this page out of static rendering;
 * saying so here means nobody has to know that rule to know what this route does, and a later
 * refactor that stops reading the filters cannot silently start serving a cached, unfiltered list.
 */
export const dynamic = "force-dynamic";

/**
 * How many author names the filter offers.
 *
 * A closed list of every author who has ever published is unbounded in principle. The cap is stated
 * under the filter bar when it bites, and the author facet is not the only route to a person's work —
 * their profile links to `/publications?author=…` directly.
 */
const AUTHOR_FACET_CAP = 200;

/** Abstracts are cut on the server: a CSS line clamp hides text from sighted readers while leaving it
 *  in the accessibility tree, so the two disagree about what the row says. */
const ABSTRACT_CHARS = 260;

/**
 * Everything a citation, a card line and an export need.
 *
 * Wider than the row looks, because `formatCitation` and `publicationDisplayVenue` read volume, issue,
 * pages, publisher and every identifier column to punctuate one line correctly (lib/citation.ts).
 * `bibtex` is here so `resolveBibtex` can prefer the record's own canonical entry.
 */
const listSelect = {
  id: true,
  slug: true,
  kind: true,
  title: true,
  abstract: true,
  authorLine: true,
  venue: true,
  publisher: true,
  volume: true,
  issue: true,
  pages: true,
  year: true,
  month: true,
  doi: true,
  isbn: true,
  issn: true,
  patentNumber: true,
  arxivId: true,
  url: true,
  bibtex: true,
  keywords: true,
  pdfFileId: true,
  researchArea: { select: { slug: true, title: true } }
} satisfies Prisma.PublicationSelect;

type ListRow = Prisma.PublicationGetPayload<{ select: typeof listSelect }>;

export async function generateMetadata(): Promise<Metadata> {
  /**
   * ⚠ THE CANONICAL IS ALWAYS THE BARE PATH, and it does not read `searchParams`. A filtered listing
   * that canonicalises to itself competes with its own parent in an index for the same content
   * (lib/seo.ts). `noIndex` is deliberately NOT set for a filtered view: `pageMetadata` pairs it with
   * `follow: false`, which would also stop a crawler walking through to the publications themselves —
   * and those pages are the point.
   */
  return pageMetadata({
    title: "Publications",
    description:
      "Journal articles, conference papers, books, patents, datasets and preprints from the Centre of Excellence, with citations in APA, MLA, Chicago and IEEE and a BibTeX export.",
    path: "/publications"
  });
}

/** Bucket rows by year, keeping the years in the order the rows arrived in — which is the sort order. */
function groupByYear(rows: readonly ListRow[]): { year: number; rows: ListRow[] }[] {
  const groups: { year: number; rows: ListRow[] }[] = [];
  const index = new Map<number, { year: number; rows: ListRow[] }>();

  for (const row of rows) {
    const existing = index.get(row.year);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const group = { year: row.year, rows: [row] };
    index.set(row.year, group);
    groups.push(group);
  }
  return groups;
}

export default async function PublicationsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const features = await getSettingCached("features");
  /**
   * The feature flag gates the ROUTE, not merely the navigation entry.
   *
   * `FEATURE_FLAGS` in lib/settings/schema.ts says a flag that gates a surface gates its pages too, and
   * contract §13a repeats it. Checked BEFORE any data read and before any streaming boundary, so a
   * switched-off bibliography never reaches the database and never half-renders.
   */
  if (!features.publications) notFound();

  const filters = parsePublicationFilters(await searchParams);
  const where = publicationWhere(filters);
  const filtering = hasPublicationFilters(filters);

  /**
   * The reachable window.
   *
   * `skip` is bounded by the result cap, so a hand-edited `?page=100000` costs one bounded query rather
   * than a table scan a visitor can ask for. A page beyond the window is not silently clamped either —
   * clamping changes what the URL says without telling anyone — so it renders a stated dead end below.
   */
  const maxPage = Math.max(1, Math.ceil(PUBLICATIONS_RESULT_CAP / PUBLICATIONS_PAGE_SIZE));
  const inRange = filters.page <= maxPage;
  const skip = inRange ? (filters.page - 1) * PUBLICATIONS_PAGE_SIZE : 0;

  const rowsPromise: Promise<ListRow[]> = inRange
    ? prisma.publication.findMany({
        where,
        orderBy: publicationOrderBy(filters.sort),
        skip,
        take: PUBLICATIONS_PAGE_SIZE,
        select: listSelect
      })
    : Promise.resolve([]);

  /**
   * THE FACETS ARE BUILT FROM THE WHOLE LIVE CORPUS, NOT FROM THE CURRENT FILTER SET.
   *
   * A year list computed under the active filters would remove the very option the reader is standing
   * on the moment they select it, and a second filter would empty the first one's list — a filter row
   * that dismantles itself as it is used. The counts beside each option are corpus-wide for the same
   * reason: they answer "how much is there of this", which does not change when a different filter
   * moves.
   */
  const corpus = liveStatusWhere();
  const authorFacetWhere: Prisma.PersonWhereInput = {
    ...liveStatusWhere(),
    isVisible: true,
    publications: { some: { publication: liveStatusWhere() } }
  };

  const [matched, years, kinds, areas, authors, authorTotal, rows] = await Promise.all([
    prisma.publication.count({ where }),
    prisma.publication.groupBy({
      by: ["year"],
      where: corpus,
      _count: { _all: true },
      orderBy: { year: "desc" }
    }),
    prisma.publication.groupBy({
      by: ["kind"],
      where: corpus,
      _count: { _all: true },
      orderBy: { kind: "asc" }
    }),
    prisma.researchArea.findMany({
      where: { ...liveStatusWhere(), publications: { some: liveStatusWhere() } },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }, { id: "asc" }],
      select: { slug: true, title: true }
    }),
    prisma.person.findMany({
      where: authorFacetWhere,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: AUTHOR_FACET_CAP,
      select: { slug: true, name: true }
    }),
    prisma.person.count({ where: authorFacetWhere }),
    rowsPromise
  ]);

  /**
   * `Publication.pdfFileId` is a bare `String?` with no `@relation` in the schema, so it cannot be
   * joined — it is filled in by one follow-up query, and only when a row on this page actually carries
   * one. A file that is not public, is soft-deleted or whose embargo has expired resolves to nothing and
   * no PDF link is drawn. Hiding the link is NOT the access control: the download route enforces the
   * identical predicate, because a hidden button is not a guard (contract §1.7).
   */
  const wantedFiles = [...new Set(rows.map((row) => row.pdfFileId).filter((id): id is string => Boolean(id)))];
  const pdfSlugs = new Map<string, string>();
  if (wantedFiles.length > 0) {
    const now = new Date();
    const files = await prisma.fileAsset.findMany({
      where: {
        id: { in: wantedFiles },
        deletedAt: null,
        isPublic: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      },
      select: { id: true, slug: true }
    });
    for (const file of files) pdfSlugs.set(file.id, file.slug);
  }

  // `reachable` is what the pagination can actually walk to. When it is short of `matched`, the
  // difference is the sentence `ResultSummary` exists to print.
  const reachable = Math.min(matched, PUBLICATIONS_RESULT_CAP);
  const truncated = matched > reachable;
  const totalPages = Math.max(1, Math.ceil(reachable / PUBLICATIONS_PAGE_SIZE));
  const beyondEnd = matched > 0 && (!inRange || filters.page > totalPages);

  const kindOptions: FilterOption[] = kinds.map((row) => ({
    value: row.kind,
    label: `${PUBLICATION_KIND_LABELS[row.kind]} (${row._count._all})`
  }));
  const yearOptions: FilterOption[] = years.map((row) => ({
    value: String(row.year),
    label: `${row.year} (${row._count._all})`
  }));
  const areaOptions: FilterOption[] = areas.map((area) => ({ value: area.slug, label: area.title }));
  const authorOptions: FilterOption[] = authors.map((author) => ({
    value: author.slug,
    label: author.name
  }));

  const groups: FilterGroup[] = [
    {
      key: PUBLICATION_PARAMS.kind,
      label: "Type",
      multiple: true,
      control: "chips",
      allLabel: "All types",
      options: kindOptions
    },
    { key: PUBLICATION_PARAMS.year, label: "Year", options: yearOptions, placeholder: "Any year" },
    {
      key: PUBLICATION_PARAMS.area,
      label: "Research area",
      options: areaOptions,
      placeholder: "All research areas"
    },
    {
      key: PUBLICATION_PARAMS.author,
      label: "Author",
      options: authorOptions,
      placeholder: "Any author"
    }
  ];

  // Group under sticky year headings only when the sort is BY year. Under "Title A–Z" the years are
  // interleaved, and a year heading over a single row would be chrome that says nothing.
  const grouped = filters.sort !== "title" && rows.length > 0;
  const yearGroups = grouped ? groupByYear(rows) : [];

  const exportCount = Math.min(matched, BIBTEX_EXPORT_CAP);

  return (
    <>
      <PageHero
        eyebrow="Research output"
        title="Publications"
        description="Everything the Centre has published — journal articles, conference papers, books and chapters, patents, datasets, software and preprints. Every entry carries a formatted citation and a BibTeX entry."
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Publications", href: "/publications" }
        ]}
      />

      <div className="shell flex flex-col gap-10 pb-24 sm:pb-32">
        <FilterBar
          label="Filter publications"
          search={{
            key: PUBLICATION_PARAMS.q,
            label: "Search publications by title or abstract",
            placeholder: "Search titles and abstracts"
          }}
          groups={groups}
          // Page 4 of an unfiltered list is not page 4 of a filtered one, and landing on an empty page 4
          // looks exactly like a list with no records. `sort` is deliberately NOT reset: it is the
          // reader's reading preference, not a filter.
          resetParams={[PUBLICATION_PARAMS.page]}
        />

        {authorTotal > authors.length ? (
          // The author list stops, and says so (contract §1.6).
          <p className="text-sm text-ink-500">
            The author filter lists the first {authors.length} of {authorTotal} names, alphabetically.
            A name that is missing can still be reached from that person&rsquo;s profile in the{" "}
            <Link href="/people" className="font-medium text-purple-700 hover:text-purple-800">
              people directory
            </Link>
            .
          </p>
        ) : null}

        <div className="flex flex-col gap-6 border-t border-line-200 pt-6 lg:flex-row lg:items-start lg:justify-between">
          <ResultSummary
            shown={rows.length}
            total={reachable}
            from={rows.length > 0 ? skip + 1 : 1}
            noun={{ singular: "publication", plural: "publications" }}
            truncated={truncated}
            cap={PUBLICATIONS_RESULT_CAP}
            omitted={matched - reachable}
            remedy="Narrow the filters, or search for a title."
            className="min-w-0 flex-1"
          />

          <div className="flex flex-col gap-3 lg:items-end">
            <SortLinks filters={filters} />

            {matched > 0 ? (
              <div className="flex flex-col gap-1.5 lg:items-end">
                {/*
                  A PLAIN <a>, NEVER `next/link`. The destination answers with a file and a
                  `Content-Disposition`; routing it through the client router would ask for an RSC
                  payload from something that returns BibTeX. `buttonClasses` gives it the secondary
                  button's clothes without pretending it is a `LinkButton`.
                */}
                <a
                  href={bibtexExportHref(filters)}
                  className={cn(buttonClasses({ variant: "secondary" }))}
                >
                  <FileDown aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span>
                    {matched > BIBTEX_EXPORT_CAP
                      ? `Download the first ${exportCount} of ${matched} as BibTeX`
                      : `Download all ${matched} as BibTeX`}
                  </span>
                  <span className="sr-only"> — reflects the filters currently applied</span>
                </a>

                <p className="text-xs leading-relaxed text-ink-500 lg:text-right">
                  {matched > BIBTEX_EXPORT_CAP
                    ? `An export stops at ${BIBTEX_EXPORT_CAP} entries and says so in the file. Narrow the filters to take the rest.`
                    : "One BibTeX entry for every publication matching the filters above."}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {beyondEnd ? (
          <EmptyState
            icon={SearchX}
            headingLevel={2}
            title={`There is nothing on page ${filters.page}`}
            description={`This list ends at page ${totalPages}. The link that brought you here is probably from a different set of filters.`}
            action={
              <LinkButton href={publicationsHref(filters, { page: null })} variant="secondary">
                Back to page 1
              </LinkButton>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={filtering ? SearchX : BookOpen}
            headingLevel={2}
            title={filtering ? "No publications match these filters" : "No publications yet"}
            description={
              filtering
                ? "Try a broader search, a different year, or clear the filters to see everything."
                : "Publications appear here as soon as they are published in the studio."
            }
            action={
              filtering ? (
                <LinkButton href="/publications" variant="secondary">
                  Clear all filters
                </LinkButton>
              ) : undefined
            }
          />
        ) : grouped ? (
          // The year groups rise together, not one after another: they are stacked vertically, so a
          // per-group reveal would fire separately anyway and a delay between them would only be a
          // pause between a heading and its own rows. See the header for `amount`.
          <Reveal as="div" className="flex flex-col gap-10" amount="some">
            {yearGroups.map((group) => (
              <section key={group.year} aria-labelledby={`year-${group.year}`}>
                <h2
                  id={`year-${group.year}`}
                  // `data-anchor` earns the header clearance from globals.css for a `#year-…` jump;
                  // never restate it as a `scroll-mt-*` (contract §7). z-10 is the ladder's rung for
                  // sticky in-page chrome and must never exceed the header's 50 (contract §6).
                  data-anchor=""
                  className="display-title sticky top-[var(--nav-clearance)] z-10 border-b border-line-200 bg-bg-0 pb-2 text-sm font-semibold uppercase tracking-[0.14em] text-ink-500"
                >
                  {group.year}
                  <span className="ml-2 font-sans font-normal normal-case tracking-normal text-ink-300">
                    {group.rows.length} on this page
                  </span>
                </h2>

                <ul className="divide-y divide-line-200">
                  {group.rows.map((row) => (
                    <PublicationRow
                      key={row.id}
                      row={row}
                      pdfSlug={row.pdfFileId ? (pdfSlugs.get(row.pdfFileId) ?? null) : null}
                      showYear={false}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </Reveal>
        ) : (
          <Reveal as="section" amount="some">
            {/*
              Under "Title A–Z" there are no year headings, and every row's own title is an `<h3>` — so
              without this the outline would run h1 → h3 and a reader navigating by heading would hear a
              level that has nothing above it (contract §11). The `<h1>` already says Publications, so
              the words are for the outline rather than the page: the same device gallery/page.tsx and
              news/category/[slug]/page.tsx use for exactly this.
            */}
            <SectionHeading level={2} title="All publications" titleClassName="sr-only" />

            <ul className="divide-y divide-line-200 border-t border-line-200">
              {rows.map((row) => (
                <PublicationRow
                  key={row.id}
                  row={row}
                  pdfSlug={row.pdfFileId ? (pdfSlugs.get(row.pdfFileId) ?? null) : null}
                  showYear
                />
              ))}
            </ul>
          </Reveal>
        )}

        {rows.length > 0 ? (
          // The pager gets the default `amount`: it is a short block, so 0.3 of it is on screen the
          // moment it appears. The same wrapper /news, /gallery and /events give theirs — a reader
          // walking the four listings should not be able to tell which one somebody paid attention to.
          <Reveal as="div">
            <Pagination
              page={filters.page}
              pageSize={PUBLICATIONS_PAGE_SIZE}
              totalItems={reachable}
              // `page: null` drops the parameter, so `hrefForPage` owns it and page 1 has exactly one URL.
              baseHref={publicationsHref(filters, { page: null })}
              pageParam={PUBLICATION_PARAMS.page}
              label="Publications"
              itemNoun={{ singular: "publication", plural: "publications" }}
              // `reachable` is a cap rather than the real total when the list was cut short, so the range
              // line reads "of at least 1000" — which is the truth.
              countIsLowerBound={truncated}
              className="border-t border-line-200 pt-6"
            />
          </Reveal>
        ) : null}
      </div>
    </>
  );
}

/**
 * The sort control, as LINKS.
 *
 * Server-rendered, so the page ships no JavaScript for it and a sorted view is a shareable URL. The
 * selected option is a `<span>` rather than a link: a link to the view you are already looking at is a
 * control that does nothing, and a screen reader announces it as a destination (the same reasoning as
 * the last breadcrumb in components/site/Breadcrumbs.tsx).
 *
 * Every link drops the page. A different sort makes "page 4" meaningless — the rows that were on it are
 * somewhere else entirely.
 */
function SortLinks({ filters }: { filters: PublicationFilters }) {
  // The bare `border` here is always composed with `off` or `on` below, each of which names its colour.
  // `border` alone is preflight's literal gray-200 and does not invert (contract §3).
  const base =
    "inline-flex min-h-9 items-center rounded-full border px-3 py-1 text-xs font-medium transition";
  const off =
    "border-line-200 bg-card text-ink-700 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700";
  const on = "border-purple-700 bg-purple-700 text-white";

  return (
    <nav aria-label="Sort order" className="flex flex-wrap items-center gap-2">
      <span className="field-label">Sort</span>
      {PUBLICATION_SORTS.map((option) => {
        const selected = option.value === filters.sort;
        return selected ? (
          <span key={option.value} aria-current="true" className={cn(base, on)}>
            {option.label}
            <span className="sr-only"> (current sort order)</span>
          </span>
        ) : (
          <Link
            key={option.value}
            href={publicationsHref(filters, { sort: option.value, page: null })}
            className={cn(base, off)}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}

function PublicationRow({
  row,
  pdfSlug,
  showYear
}: {
  row: ListRow;
  pdfSlug: string | null;
  /** Off inside a year group, where the sticky heading above already says it. */
  showYear: boolean;
}) {
  const venue = publicationDisplayVenue(row);
  const doi = doiUrl(row.doi);
  const external = doi ?? row.url?.trim() ?? null;
  const abstract = row.abstract?.trim() ?? "";

  return (
    <li className="py-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge size="sm">{PUBLICATION_KIND_LABELS[row.kind]}</Badge>
        {showYear ? <span className="text-xs tabular-nums text-ink-500">{row.year}</span> : null}
        {row.researchArea ? (
          <Link
            href={`/research/${row.researchArea.slug}`}
            className="text-xs font-medium text-purple-700 transition-colors hover:text-purple-800"
          >
            {row.researchArea.title}
          </Link>
        ) : null}
      </div>

      <h3 className="mt-2">
        <Link
          href={`/publications/${row.slug}`}
          className="display-title text-balance text-lg leading-snug transition-colors hover:text-purple-700"
        >
          {row.title}
        </Link>
      </h3>

      {/* The authoritative author line, exactly as printed. It is never rebuilt from the linked people:
          `PublicationAuthor` holds only the Centre's own authors, so deriving the line from it would
          drop every external co-author and misattribute the work (prisma/schema.prisma). */}
      <p className="mt-1.5 text-sm leading-relaxed text-ink-700">{row.authorLine}</p>

      {venue ? <p className="mt-1 text-sm text-ink-500">{venue}</p> : null}

      {abstract ? (
        <p className="prose-measure mt-3 text-sm leading-relaxed text-ink-500">
          {truncateWords(abstract, ABSTRACT_CHARS)}
        </p>
      ) : null}

      {external || pdfSlug ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          {external ? (
            <a
              href={external}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-purple-700 transition-colors hover:text-purple-800"
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
              {doi ? "DOI" : "Publisher"}
              <span className="sr-only"> for {row.title} (opens in a new tab)</span>
            </a>
          ) : null}

          {pdfSlug ? (
            // A plain <a>, never `next/link`: the destination is an API route that answers with a file
            // and records the download server-side. The count is kept there rather than by a client
            // beacon, which an ad blocker eats.
            <a
              href={`/api/public/files/${pdfSlug}`}
              className="inline-flex items-center gap-1.5 font-medium text-purple-700 transition-colors hover:text-purple-800"
            >
              <FileDown aria-hidden="true" className="h-4 w-4" />
              PDF
              <span className="sr-only"> of {row.title}</span>
            </a>
          ) : null}
        </div>
      ) : null}

      {/* Every style is formatted HERE, on the server, and handed over as four strings — so the reader
          copies the very text they are looking at and lib/citation.ts never reaches the browser. */}
      <CitationBlock
        citations={buildCitations(row)}
        bibtex={resolveBibtex(row)}
        label={`Cite ${row.title}`}
        className="mt-4"
      />
    </li>
  );
}
