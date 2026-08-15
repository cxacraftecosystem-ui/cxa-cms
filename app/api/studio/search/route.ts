import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { badRequest, ok, route } from "@/lib/api";
import { requireUser } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canAccessStudio } from "@/lib/permissions";
import {
  SEARCH_ENTITY_TYPES,
  isSearchEntityType,
  searchTypeLabel,
  type SearchEntityType
} from "@/lib/search/index";
import { parseStudioQuery } from "@/lib/studio/crud";

/**
 * The studio's own search — across everything, INCLUDING work that is not published.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS NOT THE PUBLIC SEARCH, AND THE DIFFERENCE IS THE WHOLE POINT.
 *
 * `lib/search/query.ts` hardcodes `"isPublished" = true` in every predicate, because a public search that
 * could be made to return a draft would be an embargo broken by a query string. That is correct there and
 * useless here: the single most common thing an editor needs to find is the piece they have not published
 * yet — "where is that news article I started on Tuesday" is the reason this endpoint exists.
 *
 * ⚠ SO EVERY RESULT SAYS WHETHER IT IS PUBLIC, and it says it in three ways because one is not enough:
 *
 *   • `isPublished` on the row — the fact, per result.
 *   • `visibility` as a WORD ("Public" / "Not on the site yet") — so a client renders language rather than
 *     inventing its own from a boolean, and colour never has to carry the meaning alone (contract §11).
 *   • `notPublicCount` on the answer — so a screen can say "3 of these are not on the site" above the list.
 *
 * A studio search that looked exactly like the public one would send an editor to check a URL that is
 * quietly 404 for everybody else.
 *
 * ⚠ IT IS A SUBSTRING SEARCH, NOT THE RANKED FULL-TEXT ONE, AND IT SAYS SO IN `mode`.
 *
 * The public search matches lexemes through `websearch_to_tsquery`, which means "bagr" finds nothing and
 * "printing" does not find "printed". An editor hunting their own draft types a fragment of a title, so
 * `ILIKE` over the indexed document is the behaviour that actually answers them — and it needs no GIN index
 * to be correct, only to be fast, which at studio volumes it does not have to be.
 *
 * It deliberately does NOT reuse `SEARCH_VECTOR` from lib/search/query.ts. Postgres compares a query's
 * expression tree with the index's, so that expression must stay byte-identical to the one in the migration;
 * a second copy of it in a second file is a copy that will drift, and the failure mode is a silent sequential
 * scan rather than an error.
 *
 * NOTHING IS LOGGED. `logSearch()` feeds the analytics screen's "what visitors looked for", and an editor
 * looking for their own draft is not a visitor — counting it would put the studio's own navigation into a
 * report about the public.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Nothing shorter can be matched usefully as a substring; two letters match most of the corpus. */
const MIN_QUERY_CHARS = 2;
/** A paste, not a search. Cut rather than refused, and the cut is echoed back as `query`. */
const MAX_QUERY_CHARS = 200;

/**
 * How many rows are read before ranking.
 *
 * Ranking happens in Node here (unlike the public search, which lets `ts_rank` do it), so the candidate set
 * has to be bounded or one careless query reads the whole index into memory. Anything past this is dropped,
 * and `truncated` says so.
 */
const CANDIDATE_LIMIT = 300;

const SearchQuery = z.object({
  q: z
    .string()
    .trim()
    .min(1, "Type a word or two to search for.")
    .max(400, "That search is too long. Try a few words instead."),
  /** Comma-separated entity types: `types=publication,post`. Absent means every type. */
  types: z.string().trim().max(300).optional(),
  /** `all` (the default), `published`, or `draft` — work that is not on the site. */
  state: z.enum(["all", "published", "draft"]).optional(),
  limit: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "The number of results must be a whole number.")
    .optional()
});

/**
 * Escape the LIKE metacharacters in a reader's words.
 *
 * Without this, `%` matches every row and `_` matches any character — not an injection (Prisma binds the
 * value) but a search box where one punctuation mark returns the whole corpus. Prisma's `contains` does NOT
 * escape them, which is why this is here rather than assumed.
 *
 * ⚠ Backslash is Postgres's default LIKE escape character, so escaping it in the same pass keeps a literal
 * one from swallowing the character after it.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * How well a row answers the query. Higher is better.
 *
 * Deliberately coarse and deliberately explainable — an editor wants the thing they were thinking of at the
 * top, not a relevance score. Publication state is NOT part of the ranking: a draft the reader is hunting
 * for must not be pushed below twenty published pages, which is the mistake that would make this endpoint
 * useless for the job it exists to do.
 */
function scoreOf(row: { title: string; summary: string | null; keywords: string[] }, needle: string): number {
  const title = row.title.toLowerCase();
  if (title === needle) return 100;
  if (title.startsWith(needle)) return 80;
  if (title.includes(needle)) return 60;
  if (row.keywords.some((keyword) => keyword.toLowerCase().includes(needle))) return 40;
  if ((row.summary ?? "").toLowerCase().includes(needle)) return 20;
  return 10;
}

export const GET = route(async (request: NextRequest) => {
  /**
   * `requireUser()` plus `canAccessStudio`, which is VIEWER and above.
   *
   * A viewer can read the CMS and change nothing, so they may search it — and this endpoint reveals nothing a
   * viewer cannot already reach by opening a list. The predicate is still named rather than assumed, so the
   * day a lower tier exists this line is where it is decided.
   */
  const user = await requireUser();
  if (!canAccessStudio(user)) {
    // Unreachable today — `requireUser()` cannot return anybody below VIEWER — and written out so it stays
    // unreachable rather than becoming an accident.
    throw badRequest("This account cannot read the studio.");
  }

  const query = parseStudioQuery(request, SearchQuery);

  const q = query.q.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  if (q.length < MIN_QUERY_CHARS) {
    // Answered as an empty outcome rather than refused: a reader who has typed one letter has not made a
    // mistake, and a red error under a search box they are still filling in is noise.
    return ok({
      results: [],
      total: 0,
      byType: {},
      notPublicCount: 0,
      truncated: false,
      mode: "substring",
      query: q,
      message: `Keep typing — at least ${MIN_QUERY_CHARS} characters are needed to search.`
    });
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, query.limit ? Number.parseInt(query.limit, 10) : DEFAULT_LIMIT)
  );

  const requested = (query.types ?? "")
    .split(",")
    .map((type) => type.trim())
    .filter((type) => type.length > 0);

  /**
   * An unknown type is REFUSED rather than dropped.
   *
   * A filter of only-unknown types would answer with nothing, which on screen is indistinguishable from
   * "there is nothing of this kind" — so a misspelled facet would read as an empty archive.
   */
  const unknown = requested.filter((type) => !isSearchEntityType(type));
  if (unknown.length > 0) {
    throw badRequest(
      `There is nothing in this studio of type ${unknown.join(", ")}. The kinds that can be searched are: ` +
        `${SEARCH_ENTITY_TYPES.join(", ")}.`
    );
  }
  const types = requested as SearchEntityType[];

  const state = query.state ?? "all";
  const escaped = escapeLike(q);

  const where: Prisma.SearchDocumentWhereInput = {
    ...(types.length > 0 ? { entityType: { in: types } } : {}),
    ...(state === "published" ? { isPublished: true } : {}),
    ...(state === "draft" ? { isPublished: false } : {}),
    OR: [
      { title: { contains: escaped, mode: "insensitive" } },
      { summary: { contains: escaped, mode: "insensitive" } },
      { body: { contains: escaped, mode: "insensitive" } },
      // `hasSome` is an exact array match, so it only fires for a keyword typed in full. That is the right
      // trade: the `body` column already carries every keyword folded into it at write time (see decision 2
      // in lib/search/index.ts), so a partial keyword is still matched above.
      { keywords: { hasSome: [q] } }
    ]
  };

  const [candidates, total] = await prisma.$transaction([
    prisma.searchDocument.findMany({
      where,
      select: {
        id: true,
        entityType: true,
        entityId: true,
        title: true,
        summary: true,
        url: true,
        keywords: true,
        isPublished: true,
        updatedAt: true
      },
      // Most recently touched first, so the candidate set that survives the cap is the work most likely to
      // be what somebody is looking for. `id` is the tiebreak, so the ordering is TOTAL.
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: CANDIDATE_LIMIT
    }),
    prisma.searchDocument.count({ where })
  ]);

  /**
   * The facet counts deliberately IGNORE the type filter: a facet list has to show what choosing a different
   * kind would give, and one that only ever counts the current selection can never offer anything else.
   *
   * ⚠ Read on its own rather than inside the transaction above. `$transaction([…])` unifies the element types
   * of its array, and a `groupBy`'s `_count` payload does not survive the unification — it comes back as a
   * union nothing can read. Read alone it is typed exactly.
   */
  const facets = await prisma.searchDocument.groupBy({
    by: ["entityType"],
    orderBy: { entityType: "asc" },
    where: {
      ...(state === "published" ? { isPublished: true } : {}),
      ...(state === "draft" ? { isPublished: false } : {}),
      OR: [
        { title: { contains: escaped, mode: "insensitive" } },
        { summary: { contains: escaped, mode: "insensitive" } },
        { body: { contains: escaped, mode: "insensitive" } },
        { keywords: { hasSome: [q] } }
      ]
    },
    _count: { _all: true }
  });

  const needle = q.toLowerCase();
  const ranked = [...candidates]
    .map((row) => ({ row, score: scoreOf(row, needle) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const byDate = b.row.updatedAt.getTime() - a.row.updatedAt.getTime();
      if (byDate !== 0) return byDate;
      // The final tiebreak keeps the ordering total, so a result cannot swap between two identical requests.
      return a.row.id.localeCompare(b.row.id);
    })
    .slice(0, limit);

  const byType: Record<string, number> = {};
  for (const facet of facets) byType[facet.entityType] = facet._count._all;

  const results = ranked.map(({ row, score }) => ({
    id: row.id,
    entityType: row.entityType,
    typeLabel: searchTypeLabel(row.entityType),
    entityId: row.entityId,
    title: row.title,
    summary: row.summary,
    /** The PUBLIC address. It answers 404 for a reader while `isPublished` is false — hence the word below. */
    url: row.url,
    keywords: row.keywords,
    isPublished: row.isPublished,
    /**
     * The word, not just the boolean. See the header: a client must not have to invent language for this,
     * and every state needs a word rather than a colour.
     */
    visibility: row.isPublished ? "Public" : "Not on the site yet",
    updatedAt: row.updatedAt,
    score
  }));

  const notPublicCount = results.filter((entry) => !entry.isPublished).length;

  return ok({
    results,
    total,
    byType,
    /** How many of the results ON THIS PAGE are not public. The sentence a client prints above the list. */
    notPublicCount,
    /**
     * True when more matched than were returned. REQUIRED, and the client must print it: a list that quietly
     * stops at twenty is indistinguishable from a studio with exactly twenty matches (contract §1.6).
     */
    truncated: total > results.length,
    /** True when the CANDIDATE cap bit, which also means the ranking saw only part of the corpus. */
    rankingIncomplete: total > candidates.length,
    candidateLimit: CANDIDATE_LIMIT,
    mode: "substring",
    /** The query as actually run, after trimming and capping — echo it, so a cut paste is visible. */
    query: q,
    state,
    note:
      "This searches drafts as well as published work, so a result marked “Not on the site yet” has an " +
      "address that will answer “page not found” for anybody outside the studio. It matches any part of a " +
      "word, which the search box on the public site does not."
  });
});
