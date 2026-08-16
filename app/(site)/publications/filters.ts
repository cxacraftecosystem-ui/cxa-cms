/**
 * The publications filter set — ONE parser, ONE `where`, ONE serialiser.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A MODULE AND NOT TWO COPIES. `/publications` renders a filtered list and offers a
 * "Download all as BibTeX" that must contain EXACTLY the rows the reader is looking at. If the page
 * and the export route each parsed the query string their own way they would disagree the first time
 * one of them gained a filter, and the failure is silent: the reader narrows to one year, presses
 * download, and gets a bibliography of the whole corpus. A citation error is not a cosmetic bug.
 *
 * So both import from here, and the export route builds its query from `publicationWhere()` — the
 * same function, given the same parsed object.
 *
 * It is colocated inside `app/(site)/publications/` rather than in `lib/` because nothing outside
 * these three files (the listing, the publication page, the export route) has any business knowing
 * what the listing's query parameters are called. Next only treats reserved filenames in the app
 * directory as routes, so a plain module here is just a module.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO `server-only`, and no Prisma VALUE import — only types, which are erased. That is deliberate:
 * this module is imported by Server Components and by a route handler, and keeping it free of a
 * runtime dependency on the Prisma client means a mistake in an import graph produces a type error
 * rather than a bundling one.
 */

import type { Prisma, PublicationKind } from "@prisma/client";

import { formatCitation, type CitablePublication, type CitationStyle } from "@/lib/citation";
import { liveStatusWhere } from "@/lib/content";
import { slugify } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The words a reader uses for each kind.
 *
 * Defined once and imported by the listing, the publication page and `/people/[slug]` — three screens
 * that must not say three different things about one enum value. `components/sections/
 * PublicationListSection.tsx` carries its own copy because a section renderer must not depend on a
 * route's internals; if these two ever disagree, this file is the one the reader sees on
 * `/publications`.
 */
export const PUBLICATION_KIND_LABELS: Record<PublicationKind, string> = {
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
 * Every kind, in the order a reader expects to meet them: peer-reviewed work first, then the material
 * the Centre issues itself. BOOKLET and FLYER are filed after REPORT rather than at the end because
 * "something the Centre produced for a cluster" is the group a reader is scanning for, and the enum
 * appended them last for a migration's convenience, not a reader's.
 *
 * ⚠ NOTHING CONSUMES THIS TODAY, so keeping it complete is a discipline rather than a behaviour. The
 * listing's kind chips are built from a `groupBy(["kind"])` with `orderBy: { kind: "asc" }`
 * (app/(site)/publications/page.tsx), which sorts by the Postgres enum's DECLARATION order and omits
 * kinds nothing is filed under — so a new kind reaches the chips on its own, at the end of the row,
 * the moment one publication uses it. This array is the answer to "what order SHOULD they be in", kept
 * total so that a page which starts ordering chips deliberately has something correct to order them
 * by. Being a `readonly PublicationKind[]` does not make an omission a compile error the way the label
 * `Record` does, so it has to be updated by hand alongside the enum.
 */
export const PUBLICATION_KIND_ORDER: readonly PublicationKind[] = [
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

function isPublicationKind(value: string): value is PublicationKind {
  return Object.prototype.hasOwnProperty.call(PUBLICATION_KIND_LABELS, value);
}

export type PublicationSort = "year-desc" | "year-asc" | "title";

/** The sort control's options, in the order they are offered. */
export const PUBLICATION_SORTS: readonly { value: PublicationSort; label: string }[] = [
  { value: "year-desc", label: "Newest first" },
  { value: "year-asc", label: "Oldest first" },
  { value: "title", label: "Title A–Z" }
];

export const DEFAULT_PUBLICATION_SORT: PublicationSort = "year-desc";

function isPublicationSort(value: string): value is PublicationSort {
  return PUBLICATION_SORTS.some((option) => option.value === value);
}

/** The query parameters this filter set owns. Written out so a typo is a type error. */
export const PUBLICATION_PARAMS = {
  q: "q",
  kind: "kind",
  year: "year",
  area: "area",
  author: "author",
  sort: "sort",
  page: "page"
} as const;

export const PUBLICATIONS_PAGE_SIZE = 20;

/**
 * How deep the listing will page.
 *
 * A hard limit rather than an unbounded `skip`: offset pagination re-scans every skipped row, so page
 * 400 of a filtered list is a table scan a visitor can ask for by editing a URL. The reader is told
 * the list stops and what to do about it (`ResultSummary`'s truncation sentence), which is the whole
 * of contract §1.6 — the alternative is a list that quietly ends and looks like the end of the data.
 */
export const PUBLICATIONS_RESULT_CAP = 1000;

/**
 * How many entries a BibTeX export may contain.
 *
 * A capped export ALWAYS says so, in a comment at the top of the file (see the export route). A
 * bibliography that is quietly short is a citation error waiting to happen, and unlike a truncated
 * web page nobody re-reads a .bib file to check.
 */
export const BIBTEX_EXPORT_CAP = 500;

/** A pasted paragraph is not a search. Trimmed here so the page, the export and the URL agree. */
const MAX_QUERY_CHARS = 120;

/**
 * How many values one filter group may carry.
 *
 * Without a cap, `?year=1&year=2&…` five thousand times is an `IN` list of five thousand parameters
 * that a visitor can compose by hand. Excess values are DROPPED rather than the request refused,
 * because a hand-edited URL is far more often a stale bookmark than an attack.
 */
const MAX_FILTER_VALUES = 40;

/** Slugs come from `slugify`, so 96 characters is the longest legitimate one (lib/utils.ts). */
const MAX_SLUG_CHARS = 96;

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicationFilters {
  /** Free text, matched against title and abstract. Empty string means "no search". */
  q: string;
  /** The recognised kinds asked for. */
  kinds: PublicationKind[];
  /**
   * True when the URL asked for ANY kind, recognised or not.
   *
   * ⚠ LOAD-BEARING. `?kind=BANANA` parses to zero recognised kinds, and a `where` that simply omitted
   * the filter would answer with the whole corpus while the filter chip on screen still said
   * "Type: BANANA" — the list and its own summary disagreeing. With this flag the `where` becomes
   * `kind: { in: [] }`, which Prisma compiles to a false predicate, so an unrecognised filter matches
   * nothing. That is the honest reading: no publication is a BANANA.
   */
  kindRequested: boolean;
  /** At most one, because the control is a single-value `<select>` — see `GROUP_LIMITS`. */
  years: number[];
  /** The same rule as `kindRequested`, for a year that is not a number. */
  yearRequested: boolean;
  /** Research area slugs, at most one. Not shape-validated — see `parsePublicationFilters`. */
  areas: string[];
  /** Person slugs, at most one. */
  authors: string[];
  sort: PublicationSort;
  /** 1-based. Never below 1. */
  page: number;
}

/** What Next hands a page (`searchParams`) or what a route handler reads off the URL. */
export type RawSearchParams =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function toSearchParams(input: RawSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) return input;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      params.append(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry);
    }
  }
  return params;
}

/** Non-empty, trimmed, de-duplicated, capped — the shape every repeated parameter is read in. */
function readValues(params: URLSearchParams, key: string, limit = MAX_FILTER_VALUES): string[] {
  const seen = new Set<string>();
  for (const raw of params.getAll(key)) {
    const value = raw.trim().slice(0, MAX_SLUG_CHARS);
    if (value.length > 0) seen.add(value);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/**
 * How many values each group reads.
 *
 * ⚠ THIS MIRRORS THE CONTROLS ON THE PAGE AND MUST KEEP MIRRORING THEM. `kind` is a row of toggle chips
 * and takes several at once; `year`, `area` and `author` are native single-value `<select>`s, and
 * `FilterBar` reads a non-multiple group as "the first value wins — the control and the summary cannot
 * disagree about what is selected" (components/site/FilterBar.tsx). If this parser accepted two years
 * from a hand-edited URL, the active-filter chip would say one thing and the list would contain
 * another. Turning one of these into a chip group means changing the number here in the same commit.
 */
const GROUP_LIMITS = {
  kind: MAX_FILTER_VALUES,
  year: 1,
  area: 1,
  author: 1
} as const;

/**
 * Read the whole filter set out of a query string.
 *
 * SLUG VALUES ARE NOT SHAPE-VALIDATED, on purpose. A slug that matches no research area simply
 * returns no publications, which is the truthful answer to "show me things filed under a category
 * that does not exist". Dropping it instead would widen the query behind the reader's back while the
 * active-filter chip still claimed it was narrowing — the same disagreement `kindRequested` exists to
 * prevent.
 */
export function parsePublicationFilters(input: RawSearchParams): PublicationFilters {
  const params = toSearchParams(input);

  const q = (params.get(PUBLICATION_PARAMS.q) ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_CHARS);

  const rawKinds = readValues(params, PUBLICATION_PARAMS.kind, GROUP_LIMITS.kind);
  const kinds = rawKinds.filter(isPublicationKind);

  const rawYears = readValues(params, PUBLICATION_PARAMS.year, GROUP_LIMITS.year);
  const years: number[] = [];
  for (const value of rawYears) {
    const year = Number.parseInt(value, 10);
    // Bounded so a nonsense year cannot become a huge integer in an `IN` list. The lower bound is 1
    // rather than a modern date: the Centre catalogues historical scholarship on craft traditions.
    if (Number.isInteger(year) && year >= 1 && year <= 9999 && !years.includes(year)) {
      years.push(year);
    }
  }

  const sortParam = params.get(PUBLICATION_PARAMS.sort)?.trim() ?? "";
  const pageParam = Number.parseInt(params.get(PUBLICATION_PARAMS.page) ?? "", 10);

  return {
    q,
    kinds,
    kindRequested: rawKinds.length > 0,
    years,
    yearRequested: rawYears.length > 0,
    areas: readValues(params, PUBLICATION_PARAMS.area, GROUP_LIMITS.area),
    authors: readValues(params, PUBLICATION_PARAMS.author, GROUP_LIMITS.author),
    sort: isPublicationSort(sortParam) ? sortParam : DEFAULT_PUBLICATION_SORT,
    page: Number.isInteger(pageParam) && pageParam > 1 ? pageParam : 1
  };
}

/** Is anything narrowing the corpus? Drives the "Clear all"/empty-state wording. */
export function hasPublicationFilters(filters: PublicationFilters): boolean {
  return (
    filters.q.length > 0 ||
    filters.kindRequested ||
    filters.yearRequested ||
    filters.areas.length > 0 ||
    filters.authors.length > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Prisma `where` for a filter set.
 *
 * ⚠ THE SEARCH GOES UNDER `AND`, NEVER AT THE TOP LEVEL AS `OR`. `liveStatusWhere()` happens to
 * return only `{ deletedAt, status }` today, so assigning `where.OR` would work — but its sibling
 * `livePublishableWhere()` DOES return an `OR`, and the day this model gains scheduling columns a
 * top-level `where.OR = […]` would silently overwrite the publication-state filter and publish every
 * draft to the search box. Nesting costs nothing and cannot do that.
 */
export function publicationWhere(filters: PublicationFilters): Prisma.PublicationWhereInput {
  const where: Prisma.PublicationWhereInput = { ...liveStatusWhere() };

  // `in: []` compiles to a false predicate, which is what an unrecognised value must mean. See
  // `kindRequested`.
  if (filters.kindRequested) where.kind = { in: filters.kinds };
  if (filters.yearRequested) where.year = { in: filters.years };
  if (filters.areas.length > 0) where.researchArea = { slug: { in: filters.areas } };

  if (filters.authors.length > 0) {
    // `PublicationAuthor` links only the Centre's own people, which is exactly the right join for an
    // author facet: the facet is built from published people, so a name in the list is a person with
    // a profile. External co-authors are not filterable and cannot be — they exist only inside the
    // `authorLine` string (prisma/schema.prisma).
    where.authors = { some: { person: { slug: { in: filters.authors } } } };
  }

  if (filters.q.length > 0) {
    /**
     * A case-insensitive substring match over the title and the abstract.
     *
     * ⚠ NOT Prisma's `search`. That operator needs the `fullTextSearch` preview feature switched on in
     * the generator block plus a tsvector index per column, neither of which this schema has — and a
     * query written against a feature that is not enabled is a runtime error, not a type error. The
     * global search box (`lib/search/query.ts`) is where ranked full-text lives, over the denormalised
     * `SearchDocument` table built for it; this box is a narrowing filter on a list, where substring
     * behaviour is what a reader hunting for a remembered word in a title actually expects.
     */
    where.AND = [
      {
        OR: [
          { title: { contains: filters.q, mode: "insensitive" } },
          { abstract: { contains: filters.q, mode: "insensitive" } }
        ]
      }
    ];
  }

  return where;
}

/**
 * A TOTAL order for every sort.
 *
 * The final `id` key is not decoration: two publications in the same year with the same title are
 * ordinary in a proceedings volume, and without a unique tiebreaker Postgres may return them in
 * either order on either request — which pages a row into two adjacent pages and drops another
 * entirely. The reader sees a list that shuffles itself and a duplicate that only appears sometimes.
 */
export function publicationOrderBy(
  sort: PublicationSort
): Prisma.PublicationOrderByWithRelationInput[] {
  switch (sort) {
    case "year-asc":
      return [{ year: "asc" }, { title: "asc" }, { id: "asc" }];
    case "title":
      return [{ title: "asc" }, { year: "desc" }, { id: "asc" }];
    case "year-desc":
    default:
      return [{ year: "desc" }, { title: "asc" }, { id: "asc" }];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialisation
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryOverrides {
  sort?: PublicationSort;
  /** `null` drops the page parameter — which is what "page 1" means (see `Pagination`). */
  page?: number | null;
}

/**
 * The filter set as a query string, in a FIXED key order.
 *
 * Deterministic because these strings become links: a sort link and a pagination link built from the
 * same state must be byte-identical or the browser treats them as two addresses for one view, which
 * costs a cache entry and a duplicate row in every analytics report. The default sort and page 1 are
 * omitted for the same reason — one view, one URL.
 */
export function publicationQueryString(
  filters: PublicationFilters,
  overrides: QueryOverrides = {}
): string {
  const params = new URLSearchParams();

  if (filters.q.length > 0) params.set(PUBLICATION_PARAMS.q, filters.q);
  for (const kind of filters.kinds) params.append(PUBLICATION_PARAMS.kind, kind);
  for (const year of filters.years) params.append(PUBLICATION_PARAMS.year, String(year));
  for (const area of filters.areas) params.append(PUBLICATION_PARAMS.area, area);
  for (const author of filters.authors) params.append(PUBLICATION_PARAMS.author, author);

  const sort = overrides.sort ?? filters.sort;
  if (sort !== DEFAULT_PUBLICATION_SORT) params.set(PUBLICATION_PARAMS.sort, sort);

  const page = overrides.page === undefined ? filters.page : overrides.page;
  if (typeof page === "number" && page > 1) params.set(PUBLICATION_PARAMS.page, String(page));

  return params.toString();
}

/** `/publications` with the filters attached. */
export function publicationsHref(
  filters: PublicationFilters,
  overrides: QueryOverrides = {}
): string {
  const query = publicationQueryString(filters, overrides);
  return query.length > 0 ? `/publications?${query}` : "/publications";
}

/**
 * The BibTeX export URL for the CURRENT filters.
 *
 * `page: null` because an export is not paged: the reader asked for "these results", not "the twenty
 * of them I can see". The count is stated on the button so the two cannot be confused.
 */
export function bibtexExportHref(filters: PublicationFilters): string {
  const query = publicationQueryString(filters, { page: null });
  const base = "/api/public/publications/export";
  return query.length > 0 ? `${base}?${query}` : base;
}

/**
 * The filter set as human-readable lines, for the header comment of an exported .bib file.
 *
 * Slugs are printed raw rather than resolved to titles: the export route has the slugs and nothing
 * else, and one extra query per download to pretty-print a comment would be a query that can fail and
 * take the download with it.
 */
export function describePublicationFilters(filters: PublicationFilters): string[] {
  const lines: string[] = [];
  if (filters.q.length > 0) lines.push(`search: "${filters.q}"`);
  if (filters.kindRequested) {
    const named = filters.kinds.map((kind) => PUBLICATION_KIND_LABELS[kind]);
    lines.push(`type: ${named.length > 0 ? named.join(", ") : "none recognised"}`);
  }
  if (filters.yearRequested) {
    lines.push(`year: ${filters.years.length > 0 ? filters.years.join(", ") : "none recognised"}`);
  }
  if (filters.areas.length > 0) lines.push(`research area: ${filters.areas.join(", ")}`);
  if (filters.authors.length > 0) lines.push(`author: ${filters.authors.join(", ")}`);
  lines.push(`sorted by: ${filters.sort}`);
  return lines;
}

/**
 * A filename for the export.
 *
 * Every component goes through `slugify`, so the result is ASCII, lower case and free of quotation
 * marks and semicolons — the three characters that break a `Content-Disposition` header. A single
 * value of a filter is named in the file; several are not, because "publications-2019-2020-2021-…"
 * is a filename nobody can read and every operating system truncates differently.
 */
export function bibtexFileName(filters: PublicationFilters, now: Date): string {
  const parts = ["publications"];

  const kind = filters.kinds.length === 1 ? filters.kinds[0] : undefined;
  if (kind) parts.push(slugify(PUBLICATION_KIND_LABELS[kind]));

  const year = filters.years.length === 1 ? filters.years[0] : undefined;
  if (typeof year === "number") parts.push(String(year));

  const area = filters.areas.length === 1 ? filters.areas[0] : undefined;
  if (area) parts.push(slugify(area));

  const author = filters.authors.length === 1 ? filters.authors[0] : undefined;
  if (author) parts.push(slugify(author));

  if (filters.q.length > 0) parts.push(slugify(filters.q));

  parts.push(now.toISOString().slice(0, 10));

  // The stem is trimmed BEFORE the extension is added; slicing the whole name would eventually eat
  // the ".bib" and hand the reader a file their operating system cannot open.
  const stem = parts.filter((part) => part.length > 0).join("-").slice(0, 90);
  return `${stem}.bib`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Citations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every style, formatted on the SERVER.
 *
 * `CitationBlock` is a Client Component and takes these four strings ready-made rather than the
 * publication row. Two reasons, both of which matter:
 *
 *   1. lib/citation.ts is a thousand lines of punctuation rules. Shipping it to the browser to render
 *      a line that never changes after the page is built is bandwidth spent on nothing.
 *   2. The string a reader COPIES is then byte-identical to the string they are looking at, because
 *      there is only one of it. A client-side formatter is a second implementation waiting to drift.
 */
export function buildCitations(
  publication: CitablePublication
): Record<CitationStyle, string> {
  return {
    apa: formatCitation(publication, "apa"),
    mla: formatCitation(publication, "mla"),
    chicago: formatCitation(publication, "chicago"),
    ieee: formatCitation(publication, "ieee")
  };
}

/**
 * A DOI as a resolvable URL, whatever shape it was stored in.
 *
 * Editors paste DOIs three ways — bare, as a doi.org URL, and with a "doi:" prefix — and trusting the
 * column produces `https://doi.org/https://doi.org/10.1234/x`. lib/citation.ts normalises the same
 * three shapes for its own output and does not export the helper, so this is the copy an `href` uses.
 */
export function doiUrl(raw: string | null | undefined): string | null {
  const bare = bareDoi(raw);
  return bare ? `https://doi.org/${bare}` : null;
}

/** The identifier alone — what `scholarlyArticleJsonLd` expects, since it adds the resolver itself. */
export function bareDoi(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const bare = value
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
  return bare.length > 0 ? bare : null;
}
