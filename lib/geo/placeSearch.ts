import { ApiClientError } from "@/lib/client/fetcher";

/**
 * Forward geocoding — typing "Barpali" and being taken there.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ PORTED FROM `D:/Portal_Development_Designer/frontend/lib/placeSearch.ts`, NOT COPIED. The behaviour,
 * the parameters and the reasoning below are that file's, verbatim where they still hold. What could not
 * come across is the plumbing: it throws `ApiError` from its own `@/lib/api`, and the module of that name
 * HERE opens with `import "server-only"` — importing it into a client component would fail the build. It
 * also leans on a `lib/offline.ts` that this project does not have. So the failure vocabulary is rebuilt on
 * `ApiClientError`, whose `status === 0` already means "no response ever arrived", which is the same
 * distinction `isUnreachable` was drawing.
 *
 * WHAT IT IS FOR. The coordinate pickers open on the centre of India at a low zoom. An editor recording a
 * cluster in rural Odisha then has to pan and pinch roughly two thousand kilometres to find a village they
 * could have named in eight keystrokes. Every tile that scrolling drags down is a tile MapTiler bills for.
 *
 * ⚠ WHAT IT IS EMPHATICALLY NOT FOR, and the rule the rest of the feature is built around: NOTHING HERE
 * EVER SETS A VALUE. A result of this search moves the CAMERA. The coordinate that reaches a record is the
 * one the editor then places by hand. That is why this module returns no address fields at all — it
 * CANNOT be wired into a record by accident, because it has nothing a record wants. A search that dropped
 * a pin would put a geocoder's guess into a research record with nobody in the loop.
 *
 * THE PARAMETERS ARE MAPTILER'S — `country`, `proximity`, `limit` (1–10), `autocomplete`, `language`.
 * Mapbox's geocoding API takes a set that looks very nearly the same and is a different service.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

const maptilerKey = process.env.NEXT_PUBLIC_MAPTILER_API_KEY;

/**
 * Whether places can be looked up at all in this build.
 *
 * The same key that draws the tiles, so this is true exactly when there is a map to move — which is why
 * callers never have to reason about the two separately.
 *
 * ⚠ WRITTEN OUT IN FULL ABOVE, NOT READ THROUGH A VARIABLE. Next's build-time substitution is a literal
 * text replacement on `process.env.NEXT_PUBLIC_*`; a dynamic lookup is NOT substituted and reads
 * `undefined` in the browser — the same trap lib/media/url.ts documents for the CDN base.
 */
export function placeSearchAvailable(): boolean {
  return Boolean(maptilerKey);
}

/** One place the geocoder offers. Deliberately camera-shaped: a point and an extent, no address. */
export interface PlaceHit {
  id: string;
  /** "Barpali" — the name on its own, which is what the editor typed and wants to recognise. */
  name: string;
  /** "Paikmal, Odisha, India" — everything after the name, and the ONLY thing telling two Barpalis apart. */
  context: string;
  lon: number;
  lat: number;
  /**
   * `[w, s, e, n]` when the feature has an extent.
   *
   * A district or a city is an area, and flying to its centre at village zoom shows one arbitrary street
   * inside it. Framing the extent shows the thing that was asked for.
   */
  bbox?: [number, number, number, number];
}

/**
 * India only.
 *
 * Every craft, region and album this CMS records is Indian, and without this a search for "Bagru" ranks a
 * same-named place elsewhere in the world above the block-printing town in Rajasthan. There is no setting
 * for it because there is no second answer.
 */
const COUNTRY = "in";

/** MapTiler caps `limit` at 10. Eight fills the panel without asking anyone to scroll a menu. */
const LIMIT = 8;

/**
 * Below this a query is noise: one or two letters match thousands of places, so the request spends a
 * quota unit to return a list nobody can choose from. The caller says so rather than searching.
 */
export const MIN_QUERY_LENGTH = 3;

interface GeocodeFeature {
  id?: string;
  text?: string;
  place_name?: string;
  center?: [number, number];
  bbox?: [number, number, number, number];
}

/**
 * Split "Barpali, Paikmal, Odisha, India" into the name and the part that disambiguates it.
 *
 * `place_name` repeats `text` as its first element, so printing both would read "Barpali — Barpali,
 * Paikmal, Odisha, India" on every row. The remainder is the half that matters: the live API returns four
 * Barpalis for one query, in two states, and the only thing separating them is this string.
 */
function describe(feature: GeocodeFeature): { name: string; context: string } {
  const name = (feature.text ?? "").trim();
  const full = (feature.place_name ?? "").trim();
  if (!name) return { name: full, context: "" };
  if (!full || full === name) return { name, context: "" };
  return { name, context: full.startsWith(`${name},`) ? full.slice(name.length + 1).trim() : full };
}

/**
 * Ask MapTiler which places answer to this name.
 *
 * Throws rather than returning an empty list on failure, because "the search is down" and "there is no
 * such village" are different sentences to somebody standing in the village — see `describeSearchFailure`.
 * An empty ARRAY is the honest answer to the second one only.
 */
export async function searchPlaces(
  query: string,
  { signal, proximity }: { signal: AbortSignal; proximity?: { lon: number; lat: number } | null }
): Promise<PlaceHit[]> {
  if (!maptilerKey) {
    // Not reachable from the UI, which hides the box without a key — but a throw here means a future
    // caller that forgets the check fails loudly instead of searching against `?key=undefined`.
    throw new ApiClientError(503, "This build has no map key, so places cannot be looked up.", {
      code: "no_map_key"
    });
  }

  const parameters = new URLSearchParams({
    key: maptilerKey,
    country: COUNTRY,
    language: "en",
    limit: String(LIMIT),
    // The editor is typing a prefix, not a finished name; this is what makes the list useful before they
    // have spelt the whole village.
    autocomplete: "true"
  });
  // Bias to where the map is already looking. Without it a cluster in Odisha is outranked by a same-named
  // town on the other side of the country.
  if (proximity) parameters.set("proximity", `${proximity.lon},${proximity.lat}`);

  let response: Response;
  try {
    response = await fetch(
      `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?${parameters.toString()}`,
      { signal }
    );
  } catch (cause) {
    // ⚠ AN ABORT IS NOT A FAILURE. Every keystroke cancels the previous request, so treating this as an
    // error would flash a message on ordinary typing. Re-thrown so the caller's own abort check sees it.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    // No response ever arrived. `status: 0` is this project's existing signal for that — see the note on
    // `ApiClientError.status` — and it is what `describeSearchFailure` reads.
    throw new ApiClientError(0, "The place search could not be reached.", { code: "network", cause });
  }

  if (!response.ok) {
    throw new ApiClientError(response.status, `The place search answered ${response.status}.`, {
      code: "search_failed"
    });
  }

  let body: { features?: GeocodeFeature[] };
  try {
    body = (await response.json()) as { features?: GeocodeFeature[] };
  } catch {
    // A 200 carrying something that is not JSON is a captive portal: the wi-fi answered, the geocoder did
    // not. 502 puts it in the try-again bucket below, which is the truthful next move.
    throw new ApiClientError(502, "The place search answered with something that could not be read.", {
      code: "search_unreadable"
    });
  }

  return (body.features ?? [])
    .filter(
      (feature): feature is GeocodeFeature & { center: [number, number] } =>
        Array.isArray(feature.center) &&
        Number.isFinite(feature.center[0]) &&
        Number.isFinite(feature.center[1])
    )
    .map((feature, index) => {
      const { name, context } = describe(feature);
      return {
        id: feature.id ?? `hit-${index}`,
        name,
        context,
        lon: feature.center[0],
        lat: feature.center[1],
        ...(feature.bbox && feature.bbox.length === 4 ? { bbox: feature.bbox } : {})
      };
    });
}

/**
 * Why the search did not answer, in the words the editor needs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE BUCKETS, AND KEEPING THEM APART IS THE POINT. Telling somebody their connection is at fault when
 * the server answered sends them hunting for a better signal and leaves a real problem wearing an offline
 * message; telling somebody the service is down when their tenant has run out of quota hides the one thing
 * an administrator could act on.
 *
 * The original drew this from its `lib/offline.ts` predicates. Here it reads `ApiClientError.status`
 * directly: `0` is "nothing reached a server", `5xx` and `429` are worth trying again, and everything else
 * — notably `401`, `403` and a quota `4xx` — is about the key rather than about the typing.
 *
 * None of these is "no such place". That is an empty ARRAY from a SUCCESSFUL request, and it is the
 * caller's to word, because it is not a failure.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function describeSearchFailure(error: unknown): string {
  const status = error instanceof ApiClientError ? error.status : -1;

  if (status === 0) {
    return "No connection, so places cannot be looked up right now. The map still works, and the coordinate boxes need no network at all.";
  }
  if (status === 429 || status >= 500) {
    return "The place search is not answering just now — this is the service, not your connection. Try again in a moment.";
  }
  return "The place search refused this request: this site's map key may be missing, expired or out of quota. Nothing is wrong with what you typed, and an administrator can check the key.";
}
