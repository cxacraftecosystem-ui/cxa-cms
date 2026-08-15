import "server-only";
// `Prisma` is imported as a VALUE: `Prisma.sql`, `Prisma.join` and `Prisma.empty` are the tagged
// template helpers, and they are the ONLY way a user's words reach this file's SQL. Nothing here
// ever concatenates a query string — see the note above SEARCH_VECTOR.
import { Prisma } from "@prisma/client";
import { clientIp } from "@/lib/api";
import { prisma } from "@/lib/db";
import { consumeRateLimit, RATE_LIMITS } from "@/lib/ratelimit";
import { clamp } from "@/lib/utils";
import { isSearchEntityType, searchTypeLabel, type SearchEntityType } from "@/lib/search/index";

/**
 * Reading the global search index.
 *
 * Ranking happens in Postgres, not in Node. Pulling every candidate row into the process to sort it
 * would mean reading the whole corpus to render twenty results, and `ts_rank` already knows about
 * term frequency and proximity in a way a hand-rolled scorer does not.
 *
 * TWO STRATEGIES, because one is not enough:
 *
 *   • **fulltext** — `websearch_to_tsquery` over the stored document. This is the real search: it
 *     handles quoted phrases, `or`, and a leading `-` for exclusion, exactly as a reader expects
 *     from a search box, and it never raises a syntax error on strange input (which `to_tsquery`
 *     very much does).
 *   • **prefix** — a title `ILIKE`. A one- or two-character query is hopeless as a tsquery: single
 *     letters are stopwords, so the tsquery is empty and `@@` matches NOTHING. The same applies to a
 *     partial word — "bagr" is not the lexeme "bagru" and full text will not find it. So a short
 *     query goes straight to the prefix branch, and a single-word query that full text answers with
 *     nothing falls back to it.
 *
 * The strategy that answered is returned as `mode`, so the UI can say which one it is showing rather
 * than leaving a reader to wonder why "the" found nothing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The indexed expression
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The document a query is matched against.
 *
 * ⚠ **A GIN index on exactly this expression must exist**, or every search is a sequential scan over
 * the whole index table. The migration that creates `search_documents` must also run:
 *
 * ```sql
 * CREATE INDEX IF NOT EXISTS "search_documents_fts_idx"
 *   ON "search_documents"
 *   USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, '')));
 * ```
 *
 * and, for the short-query fallback below (optional, but it is the difference between a keystroke
 * and a table scan once the corpus is large):
 *
 * ```sql
 * CREATE EXTENSION IF NOT EXISTS pg_trgm;
 * CREATE INDEX IF NOT EXISTS "search_documents_title_trgm_idx"
 *   ON "search_documents" USING GIN (title gin_trgm_ops);
 * ```
 *
 * Three things about that expression are load-bearing:
 *
 *  1. **`coalesce` on every column.** `summary` is nullable, and `text || NULL` is NULL in SQL — a
 *     single missing summary would null the whole concatenation and the row would match nothing,
 *     ever, silently.
 *  2. **The two-argument `to_tsvector` with a literal config.** The one-argument form depends on
 *     `default_text_search_config`, which makes it STABLE rather than IMMUTABLE, and Postgres
 *     refuses to build an index on it.
 *  3. **`keywords` is deliberately absent.** `array_to_string` is STABLE too, so including it would
 *     make the index impossible to create. lib/search/index.ts folds the keywords into `body` at
 *     write time instead, which is why they are still searchable.
 *
 * Postgres compares the query's expression tree with the index's, so this must stay identical to the
 * statement above — a difference in the coalesce arguments or their order silently loses the index
 * rather than raising anything. If ranking ever needs to weight titles above bodies, the change is a
 * `setweight(...) || setweight(...)` vector here AND in the index, in the same commit.
 */
const SEARCH_VECTOR = Prisma.sql`to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, ''))`;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export type SearchMode = "fulltext" | "prefix";

export interface SearchResult {
  id: string;
  /** Typed as `string`, not the union: an index row from an older deployment may carry a retired type. */
  entityType: string;
  /** Carried on the row so a client command palette can render a badge without importing this server-only module. */
  typeLabel: string;
  entityId: string;
  title: string;
  summary: string | null;
  url: string;
  keywords: string[];
  rank: number;
}

export interface SearchInput {
  q: string;
  types?: readonly string[];
  limit?: number;
  offset?: number;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** Matches for the requested types, not the number of rows returned. */
  total: number;
  /** Matches per entity type across ALL types, so a facet list can offer the ones not currently selected. */
  byType: Record<string, number>;
  /**
   * True when more matches exist than this page shows.
   *
   * REQUIRED, and the UI must print it (contract §1.6): a list that quietly stops at fifty is
   * indistinguishable from a corpus with exactly fifty matches.
   */
  truncated: boolean;
  mode: SearchMode;
  /** The query as actually run, after trimming and capping. Echo it — see MAX_QUERY_CHARS. */
  query: string;
}

export interface SearchSuggestion {
  entityType: string;
  typeLabel: string;
  entityId: string;
  title: string;
  url: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Deep paging over a ranked scan costs the same as reading everything before it; the UI should refine instead. */
const MAX_OFFSET = 500;
/** Below this, a tsquery is all stopwords or an incomplete lexeme, so the prefix branch answers. */
const MIN_FULLTEXT_CHARS = 3;
/** A paste, not a search. Capped rather than refused, and the cap is reported back as `query`. */
const MAX_QUERY_CHARS = 200;
const MAX_LOGGED_QUERY_CHARS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Input handling
// ─────────────────────────────────────────────────────────────────────────────

/** Trim and collapse. Case is left alone: tsquery lower-cases lexemes and ILIKE ignores case. */
function cleanQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

/**
 * The form a query is LOGGED under: trimmed, whitespace-collapsed, lower-cased, so "Block Printing"
 * and "block  printing" are one row in the analytics rather than two near-identical ones.
 */
export function normaliseSearchQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Escape the LIKE metacharacters in a user's words.
 *
 * Without this, "%" matches every row and "_" matches any character — not an injection (the value is
 * a bound parameter) but a search box where one punctuation mark returns the entire corpus. Backslash
 * is Postgres's default LIKE escape character, so no `ESCAPE` clause is needed; escaping the
 * backslash itself in the same pass keeps a literal one from swallowing the character after it.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Resolve the type filter.
 *
 * `null` means "no filter". An empty array back means the caller asked only for types that do not
 * exist, which is answered with no results rather than by ignoring the filter — quietly widening a
 * filter the caller set is how a "publications only" toggle starts returning news.
 */
function resolveTypes(types: readonly string[] | undefined): SearchEntityType[] | null {
  if (!types || types.length === 0) return null;
  return types.filter(isSearchEntityType);
}

function typeFilterSql(types: SearchEntityType[] | null): Prisma.Sql {
  if (!types || types.length === 0) return Prisma.empty;
  return Prisma.sql`AND "entityType" IN (${Prisma.join(types)})`;
}

function toResult(row: RankedRow): SearchResult {
  return {
    id: row.id,
    entityType: row.entityType,
    typeLabel: searchTypeLabel(row.entityType),
    entityId: row.entityId,
    title: row.title,
    summary: row.summary,
    url: row.url,
    keywords: row.keywords,
    rank: row.rank
  };
}

interface RankedRow {
  id: string;
  entityType: string;
  entityId: string;
  title: string;
  summary: string | null;
  url: string;
  keywords: string[];
  rank: number;
}

/** `count(*)` is `bigint`, which Prisma hands back as a `BigInt` that `JSON.stringify` throws on. Cast it. */
interface FacetRow {
  entityType: string;
  count: number;
}

function emptyOutcome(query: string, mode: SearchMode): SearchOutcome {
  return { results: [], total: 0, byType: {}, truncated: false, mode, query };
}

// ─────────────────────────────────────────────────────────────────────────────
// The two strategies
// ─────────────────────────────────────────────────────────────────────────────

async function runSearch(
  predicate: Prisma.Sql,
  ranking: Prisma.Sql,
  rank: Prisma.Sql,
  types: SearchEntityType[] | null,
  limit: number,
  offset: number,
  mode: SearchMode,
  query: string
): Promise<SearchOutcome> {
  const typeFilter = typeFilterSql(types);

  // The facet counts deliberately IGNORE the type filter: a facet list has to show what selecting a
  // different type would give, and one that only ever counts the current selection can never offer
  // anything else.
  const [rows, facets] = await Promise.all([
    prisma.$queryRaw<RankedRow[]>(Prisma.sql`
      SELECT id,
             "entityType",
             "entityId",
             title,
             summary,
             url,
             keywords,
             ${rank} AS "rank"
        FROM "search_documents"
       WHERE ${predicate} ${typeFilter}
       ORDER BY ${ranking}
       LIMIT ${limit} OFFSET ${offset}
    `),
    prisma.$queryRaw<FacetRow[]>(Prisma.sql`
      SELECT "entityType", count(*)::int AS "count"
        FROM "search_documents"
       WHERE ${predicate}
       GROUP BY "entityType"
    `)
  ]);

  const byType: Record<string, number> = {};
  for (const facet of facets) byType[facet.entityType] = facet.count;

  // `total` counts what the caller ASKED for, so it agrees with the rows above; `byType` counts
  // everything, so the facets can offer the rest.
  const total = types
    ? types.reduce<number>((sum, type) => sum + (byType[type] ?? 0), 0)
    : facets.reduce<number>((sum, facet) => sum + facet.count, 0);

  const results = rows.map(toResult);

  return {
    results,
    total,
    byType,
    truncated: offset + results.length < total,
    mode,
    query
  };
}

function runFulltext(
  q: string,
  types: SearchEntityType[] | null,
  limit: number,
  offset: number
): Promise<SearchOutcome> {
  const tsquery = Prisma.sql`websearch_to_tsquery('english', ${q})`;
  return runSearch(
    Prisma.sql`"isPublished" = true AND ${SEARCH_VECTOR} @@ ${tsquery}`,
    // `id` is the final tiebreak so the ordering is TOTAL. Without it two rows of equal rank and
    // equal `updatedAt` can swap between pages, which shows up as a result appearing twice.
    Prisma.sql`"rank" DESC, "updatedAt" DESC, id ASC`,
    // float4 out of ts_rank, cast to float8 so it arrives as a plain number.
    Prisma.sql`ts_rank(${SEARCH_VECTOR}, ${tsquery})::float8`,
    types,
    limit,
    offset,
    "fulltext",
    q
  );
}

function runPrefix(
  q: string,
  types: SearchEntityType[] | null,
  limit: number,
  offset: number
): Promise<SearchOutcome> {
  const escaped = escapeLike(q);
  const starts = `${escaped}%`;
  const contains = `%${escaped}%`;

  return runSearch(
    Prisma.sql`"isPublished" = true AND title ILIKE ${contains}`,
    // True sorts above false in Postgres, so a genuine prefix match leads, then the shortest title —
    // "Bagru" before "Bagru block printing in the western districts".
    Prisma.sql`(title ILIKE ${starts}) DESC, char_length(title) ASC, title ASC, id ASC`,
    // No relevance score exists in this branch. Zero rather than a fabricated number, so a UI that
    // renders the rank cannot imply a precision that is not there.
    Prisma.sql`0::float8`,
    types,
    limit,
    offset,
    "prefix",
    q
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The public API
// ─────────────────────────────────────────────────────────────────────────────

export async function search(input: SearchInput): Promise<SearchOutcome> {
  const q = cleanQuery(input.q ?? "");
  // `clamp` returns the lower bound for a non-finite value, so NaN from a query string lands on a
  // usable page rather than on `LIMIT NaN`.
  const limit = clamp(Math.floor(input.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
  const offset = clamp(Math.floor(input.offset ?? 0), 0, MAX_OFFSET);

  if (q.length === 0) return emptyOutcome(q, "prefix");

  const types = resolveTypes(input.types);
  if (types !== null && types.length === 0) return emptyOutcome(q, "fulltext");

  if (q.length < MIN_FULLTEXT_CHARS) return runPrefix(q, types, limit, offset);

  const fulltext = await runFulltext(q, types, limit, offset);
  if (fulltext.total > 0) return fulltext;

  // Nothing matched. For a single word this is usually a partial one ("bagr", "hand-blo") that full
  // text cannot complete, so the prefix branch gets a turn. For a multi-word query it is a genuine
  // miss, and answering it with substring noise would be worse than an honest empty state.
  if (q.includes(" ")) return fulltext;
  return runPrefix(q, types, limit, offset);
}

/**
 * Title-prefix suggestions for the command palette.
 *
 * Deliberately not `search()`: a palette fires on every keystroke, and it needs a handful of titles
 * rather than ranking, facets and a total. Written as raw SQL rather than Prisma's `startsWith`
 * because that helper does not escape `%` and `_` in the value.
 */
export async function suggest(prefix: string, limit = 8): Promise<SearchSuggestion[]> {
  const q = cleanQuery(prefix);
  if (q.length === 0) return [];

  const take = clamp(Math.floor(limit), 1, 20);
  const escaped = escapeLike(q);
  const starts = `${escaped}%`;
  const contains = `%${escaped}%`;

  const rows = await prisma.$queryRaw<
    Array<{ entityType: string; entityId: string; title: string; url: string }>
  >(Prisma.sql`
    SELECT "entityType", "entityId", title, url
      FROM "search_documents"
     WHERE "isPublished" = true AND title ILIKE ${contains}
     ORDER BY (title ILIKE ${starts}) DESC, char_length(title) ASC, title ASC, id ASC
     LIMIT ${take}
  `);

  return rows.map((row) => ({
    entityType: row.entityType,
    typeLabel: searchTypeLabel(row.entityType),
    entityId: row.entityId,
    title: row.title,
    url: row.url
  }));
}

/** The UTC midnight for a day bucket. Local midnight would give two rows for one day whenever the server moves. */
function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Record that a query was run, for the analytics screen.
 *
 * NEVER THROWS. A failed insert here must not turn a search that worked into an error page — the
 * same reasoning as `recordEvent` in lib/audit.ts. The failure goes to the server log, where an
 * operator will see it.
 *
 * `hits` is overwritten rather than accumulated: the question the analytics screen answers is "which
 * searches find nothing", and that is a property of the corpus as it stands now, not a running
 * total. `count` accumulates, because that one genuinely is a tally.
 *
 * A query longer than 200 characters is dropped rather than truncated. It is a paste, not something
 * anybody will act on, and a truncated version would sit in the "top searches" list as a phrase no
 * reader ever typed.
 *
 * THE WRITE IS RATE-CAPPED, per (IP, query). This upsert is reachable by any unauthenticated GET,
 * and (day, query) is a unique key over an attacker-controlled string — left unguarded it is an
 * attacker-controlled INSERT loop (the audit's words): a script cycling phrases mints a row per
 * phrase, and a script replaying one phrase inflates `count` until the "top searches" screen is
 * that script's output. So the same in-process token bucket the views beacon stands behind
 * (lib/ratelimit.ts) is consumed here, keyed on the caller's IP AND the normalised query. The
 * FIRST sighting of any query from any address always lands, because a bucket is born full — the
 * cap costs repeats, never queries, which is what keeps the analytics honest rather than merely
 * smaller. Pass the request when there is one; without it every caller shares the conservative
 * `no-ip` bucket, the same direction lib/ratelimit.ts takes for a missing forwarded address.
 * Distinct-phrase floods are bounded separately by the route's `search` policy, which caps how
 * often one connection may ask at all. Per-instance caveats in lib/ratelimit.ts's header apply:
 * this is a speed bump, not a guarantee.
 */
export async function logSearch(query: string, hits: number, request?: Request): Promise<void> {
  try {
    const normalised = normaliseSearchQuery(query);
    if (normalised.length === 0 || normalised.length > MAX_LOGGED_QUERY_CHARS) return;

    // Refused silently, exactly like every other failure in this function: the reader's search
    // already succeeded, and the log is the only thing the cap withholds. The bucket key is safe
    // to build from the query because lib/ratelimit.ts sweeps and hard-caps its map — it is
    // designed for attacker-controlled keys (see MAX_BUCKETS there).
    const verdict = consumeRateLimit(
      `search-log:${(request && clientIp(request)) ?? "no-ip"}:${normalised}`,
      RATE_LIMITS.searchLog
    );
    if (!verdict.ok) return;

    const day = utcDay(new Date());
    const safeHits = Number.isFinite(hits) ? Math.max(0, Math.floor(hits)) : 0;

    await prisma.searchQueryLog.upsert({
      where: { day_query: { day, query: normalised } },
      create: { day, query: normalised, hits: safeHits, count: 1 },
      update: { hits: safeHits, count: { increment: 1 } }
    });
  } catch (error) {
    console.error("[search] could not log query", error);
  }
}
