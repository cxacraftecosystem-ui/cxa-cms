import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseQuery, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/ratelimit";
import {
  OPEN_COLLECTION_LIMITS,
  OPEN_COLLECTION_SEARCH_RATE_LIMIT,
  OPEN_COLLECTION_SOURCES,
  searchOpenCollections
} from "@/lib/media/open-collections";

/**
 * Searching the open collections — The Metropolitan Museum of Art and Wikimedia Commons.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE ANSWER SHAPE IS `OpenCollectionSearchOutcome` from lib/media/open-collections.ts and the
 * caller is `components/studio/media/OpenCollectionImport.tsx`. Nothing is reshaped here: the picker
 * needs the per-source reports and the withheld counts verbatim, because the sentence "eleven files
 * were left out because their licence does not allow reuse" is the one that tells an editor the filter
 * is working rather than that Commons is empty.
 *
 * ⚠ NOTHING ABOUT THE LICENCE IS DECIDED IN THIS FILE. It is decided in the library module, and it is
 * decided AGAIN when a record is imported. This route only carries a query through and hands the
 * answer back — which is deliberate: a search result is a suggestion, and the import route is where the
 * question "may the Centre copy this?" is actually answered.
 *
 * ⚠ IT IS GATED AND RATE-LIMITED, AND THE LIMIT IS NOT ABOUT THIS DEPLOYMENT. One search of the Met is
 * up to forty requests to somebody else's free API, so the allowance exists to keep this installation a
 * polite client. `OPEN_COLLECTION_SEARCH_RATE_LIMIT` lives next to the code that makes those calls so
 * the allowance and the fan-out cannot be changed independently — see the note on it.
 *
 * `requireCapability`, NOT `requireStudioCapability`: this is a ROUTE HANDLER, so the refusal has to be
 * an `ApiError` that `route()` turns into a 403 JSON body. The page pair calls Next's `forbidden()` and
 * would produce a 500 here (contract §1.9).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The shortest query worth sending.
 *
 * One letter matches most of two million records at both institutions, so the answer is noise and the
 * fan-out is paid for nothing. The picker enforces the same minimum before it will submit.
 */
const MIN_QUERY_LENGTH = 2;

/**
 * A bounded whole number from a query string, VALIDATED AS A STRING and converted at the call site.
 *
 * The house pattern — see the identical note in app/api/studio/media/route.ts. `parseQuery` takes a
 * `ZodSchema<T>` whose input and output are the same `T`, so a `.transform()` or a `.default()` makes
 * the two differ and the call stops type-checking; `.refine()` does not.
 */
const boundedInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, `${label} has to be a whole number.`)
    .refine((value) => {
      const parsed = Number.parseInt(value, 10);
      return parsed >= min && parsed <= max;
    }, `${label} has to be between ${min} and ${max}.`)
    .optional();

const SearchQuery = z.object({
  q: z
    .string()
    .trim()
    .min(MIN_QUERY_LENGTH, `Type at least ${MIN_QUERY_LENGTH} letters to search the collections.`)
    .max(160, "That search is too long. A few words find more than a sentence does."),
  /** Omitted means both. The picker sends one of these three values. */
  source: z.enum(["all", ...OPEN_COLLECTION_SOURCES]).optional(),
  limit: boundedInt("The number of results", 1, OPEN_COLLECTION_LIMITS.max)
});

export const GET = route(async (request: NextRequest) => {
  // A read, so no same-origin assertion. It is still gated: this endpoint spends the Centre's outbound
  // request allowance, and the media screen's own guard is not the boundary (contract §1.7).
  await requireCapability(
    canManageMedia,
    "Searching the open collections needs media manager access or higher. An administrator can raise yours."
  );

  const limited = enforceRateLimit(
    request,
    "open-collections-search",
    OPEN_COLLECTION_SEARCH_RATE_LIMIT,
    (phrase) =>
      `The collection search is paused for ${phrase} because this connection has made a great many ` +
      "searches in a short time. Each one asks the museums for dozens of records, so the pause keeps " +
      "this installation a well-behaved visitor to their free service."
  );
  if (limited) return limited;

  const query = parseQuery(request, SearchQuery);
  const limit = query.limit ? Number.parseInt(query.limit, 10) : OPEN_COLLECTION_LIMITS.default;

  // Never throws for anything a museum did — a source that is unreachable comes back with an empty
  // list and a stated reason in its own report, so one institution being down does not turn into a
  // failed search for the other.
  const outcome = await searchOpenCollections({
    query: query.q,
    source: query.source ?? "all",
    limit
  });

  return ok(outcome);
});
