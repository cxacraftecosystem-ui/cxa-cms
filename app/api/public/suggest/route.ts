import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseQuery, route } from "@/lib/api";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/ratelimit";
import { suggest } from "@/lib/search/query";

/**
 * Title suggestions for the header's search box.
 *
 * Deliberately NOT `/api/public/search`. This fires while somebody is typing, so it needs a handful of
 * titles and nothing else — no ranking, no facet counts, no total. `suggest()` in lib/search/query.ts
 * is a single indexed title match for that reason.
 *
 * TWO DECISIONS WORTH STATING:
 *
 *  • **Nothing is logged.** `logSearch` records searches a person performed; a prefix captured
 *     mid-word is not one. Logging every keystroke would fill the analytics screen with "b", "ba",
 *     "bag" and bury the queries somebody actually ran — and it would record fragments of a search
 *     that was abandoned, which nobody asked us to keep.
 *  • **The cap is REPORTED.** One extra row is requested internally and `hasMore` says whether it came
 *     back, so the menu can end with "keep typing to narrow this" instead of silently stopping at
 *     eight (contract §1.6).
 */

export const dynamic = "force-dynamic";

/** The most suggestions a dropdown can show before it stops being a shortcut and becomes a list. */
const MAX_SUGGESTIONS = 10;
const DEFAULT_SUGGESTIONS = 8;

const SuggestQuery = z.object({
  q: z
    .string()
    .trim()
    .min(1, "Type at least one character to see suggestions.")
    .max(200, "That is too long to suggest against. Use the search page instead."),
  /**
   * Validated as a STRING and converted below. `parseQuery` takes a `ZodSchema<T>`, whose input and
   * output are both `T`, so a `.transform()` to a number would not type-check; `.refine()` keeps both
   * sides `string` and still refuses an out-of-range value with a sentence.
   */
  limit: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "limit must be a whole number.")
    .refine((value) => {
      const parsed = Number.parseInt(value, 10);
      return parsed >= 1 && parsed <= MAX_SUGGESTIONS;
    }, `limit must be between 1 and ${MAX_SUGGESTIONS}.`)
    .optional()
});

export const GET = route(async (request: NextRequest) => {
  // A higher allowance than full search, because this endpoint is expected to fire several times per
  // query. It still assumes the box DEBOUNCES — an un-debounced input at typing speed will exhaust
  // this in a sentence and a half, which is the correct outcome for a client that streams keystrokes.
  const limited = enforceRateLimit(
    request,
    "suggest",
    RATE_LIMITS.suggest,
    (phrase) =>
      `Suggestions are paused for ${phrase} because this connection asked for too many of them. ` +
      "Searching still works."
  );
  if (limited) return limited;

  const query = parseQuery(request, SuggestQuery);
  const limit = query.limit === undefined ? DEFAULT_SUGGESTIONS : Number.parseInt(query.limit, 10);

  // One more than we intend to show. If the extra row exists there are further matches, which is the
  // only honest way to claim truncation from a query that returns no total.
  const rows = await suggest(query.q, limit + 1);
  const hasMore = rows.length > limit;

  return ok({
    query: query.q,
    limit,
    suggestions: rows.slice(0, limit),
    hasMore
  });
});
