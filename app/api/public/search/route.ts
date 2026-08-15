import type { NextRequest } from "next/server";
import { z } from "zod";
import { badRequest, ok, parseQuery, route } from "@/lib/api";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/ratelimit";
import { logSearch, search } from "@/lib/search/query";
import { SEARCH_ENTITY_TYPES, isSearchEntityType } from "@/lib/search/index";

/**
 * Global search over the index.
 *
 * A THIN WRAPPER, on purpose. Ranking, the two strategies, the caps and the truncation flag all live in
 * lib/search/query.ts, and the search PAGE reads that module directly as a Server Component. This route
 * exists for the interactive box in the header and for anything that searches without navigating. If
 * you find yourself adding ranking logic here, it belongs in the module instead — two implementations
 * of "what matches" is two sets of results for one query.
 *
 * ⚠ **AN EMPTY `q` IS REFUSED, NOT ANSWERED.** `search()` returns an empty outcome for an empty query
 * rather than the corpus, so this is belt and braces — but the belt matters: a future edit that
 * defaulted `q` to `""` and passed it through would turn this endpoint into "download every published
 * record", 20 rows at a time, with facet counts attached.
 */

export const dynamic = "force-dynamic";

/**
 * A bounded whole number from a query string, VALIDATED AS A STRING.
 *
 * Two constraints shape this. Written as a string check rather than `z.coerce.number()` because
 * coercion answers "?limit=abc" with "Expected number, received nan" — a sentence about JavaScript,
 * shown to a reader who typed a URL. And it stays a string rather than transforming to a number because
 * `parseQuery` takes a `ZodSchema<T>`, whose input and output are the same `T`; a `.transform()` makes
 * them differ and the call no longer type-checks. `.refine()` does not, so the range check lives here
 * and the conversion happens at the call site.
 */
const boundedInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,6}$/, `${label} must be a whole number.`)
    .refine(
      (value) => {
        const parsed = Number.parseInt(value, 10);
        return parsed >= min && parsed <= max;
      },
      `${label} must be between ${min} and ${max}.`
    )
    .optional();

/** The paired conversion. Safe because `boundedInt` has already proved the shape and the range. */
function toInt(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number.parseInt(value, 10);
}

const SearchQuery = z.object({
  q: z
    .string()
    .trim()
    .min(1, "Enter a word or two to search for.")
    // Deliberately above lib/search/query.ts's own 200-character cap, which trims rather than refuses
    // and reports what it actually ran back as `query`. This ceiling exists only to turn away a pasted
    // document outright instead of handing a kilobyte of prose to a tsquery.
    .max(400, "That search is too long. Try a few words instead."),
  /** Comma-separated entity types: `types=publication,project`. Absent means every type. */
  types: z.string().trim().max(300).optional(),
  limit: boundedInt("limit", 1, 50),
  offset: boundedInt("offset", 0, 500)
});

export const GET = route(async (request: NextRequest) => {
  const limited = enforceRateLimit(
    request,
    "search",
    RATE_LIMITS.search,
    (phrase) => `That is a lot of searches in a short time. Try again in ${phrase}.`
  );
  if (limited) return limited;

  const query = parseQuery(request, SearchQuery);

  const requested = (query.types ?? "")
    .split(",")
    .map((type) => type.trim())
    .filter((type) => type.length > 0);

  // An unknown type is REFUSED rather than dropped. `search()` answers a filter of only-unknown types
  // with no results, which on screen is indistinguishable from "there is nothing published of this
  // kind" — so a misspelled facet would read as an empty archive.
  const unknown = requested.filter((type) => !isSearchEntityType(type));
  if (unknown.length > 0) {
    throw badRequest(
      `There is nothing on this site of type ${unknown.join(", ")}. The types that can be searched are: ` +
        `${SEARCH_ENTITY_TYPES.join(", ")}.`
    );
  }

  const offset = toInt(query.offset);

  const outcome = await search({
    q: query.q,
    // `undefined`, not `[]`: an empty array means "only these types, of which there are none" to
    // `search()`, and would return nothing at all.
    types: requested.length > 0 ? requested : undefined,
    limit: toInt(query.limit),
    offset
  });

  // Logged only for the FIRST page. Paging through one search's results is still one search, and
  // counting each page would make the studio's "most searched" list a ranking of which results people
  // scrolled through. `logSearch` never throws, and it is awaited rather than fired and forgotten —
  // a floating promise in a serverless function is often killed with the response. The request goes
  // along so the write can be capped per (IP, query) — logSearch's header has the whole argument.
  if ((offset ?? 0) === 0) {
    await logSearch(outcome.query, outcome.total, request);
  }

  // The outcome carries `truncated`, `mode` and the `query` as actually run. All three are meant to be
  // rendered: `truncated` because a list that quietly stops is a bug the reader cannot see, and `mode`
  // because a prefix-matched answer to a two-letter query needs explaining.
  return ok(outcome);
});
