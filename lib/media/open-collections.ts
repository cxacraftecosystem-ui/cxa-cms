/**
 * Searching the two open collections the Centre may lawfully copy from, and normalising what they
 * return into one shape the studio can render and the import route can act on.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS MODULE EXISTS. The Centre needs photographs of Indian textiles, miniatures and artefacts
 * and cannot afford a picture library. Two institutions publish real, high-resolution images with a
 * clear licence and a public API that needs no key:
 *
 *   • THE METROPOLITAN MUSEUM OF ART — a flat JSON API. A record carries `isPublicDomain`, and when
 *     it is true the image is released under CC0. That flag is the ONLY thing that makes a Met record
 *     usable here; every other record on that API is under copyright.
 *   • WIKIMEDIA COMMONS — the MediaWiki API. ⚠ COMMONS IS NOT ALL FREE-USE. Non-free logos, fair-use
 *     screenshots and licences that forbid derivatives all live there beside the free material, and
 *     the API returns them in the same search results as everything else. Every file is therefore
 *     classified from its own licence metadata and REFUSED unless it is public domain, CC0, CC BY or
 *     CC BY-SA. Importing one of the others would put the Centre in breach.
 *
 * FOUR RULES, each of which is the difference between a working importer and a liability:
 *
 *  1. **THE LICENCE IS DECIDED HERE, TWICE, AND NEVER BY A CLIENT.** `searchOpenCollections` filters
 *     the picker's list, and `fetchOpenCollectionRecord` re-fetches and re-classifies the same record
 *     server-side at import time. A licence a browser sent is a value the caller chose.
 *  2. **`attribution` IS BUILT HERE, ONCE, IN THE FORM THE LICENCE REQUIRES**, and stored on the
 *     asset. An attribution reconstructed later from a URL is one that will eventually be wrong or
 *     absent, and CC BY without attribution is simply infringement. The string it produces is meant
 *     to be published verbatim — it is what lands in `MediaAsset.credit`.
 *  3. **EVERY OUTBOUND FETCH CARRIES A DEADLINE, A DESCRIPTIVE USER-AGENT AND A HOST CHECK ON EVERY
 *     HOP.** Wikimedia asks for a user-agent and rate-limits anonymous clients that omit it, and a
 *     museum that stops answering must not hold a studio request open until the platform kills it.
 *     Redirects are walked by hand in `fetchAllowed` rather than left to `fetch`, so the allowlist
 *     governs where the bytes come from and not merely where the request started.
 *  4. **ONE SOURCE BEING DOWN IS NOT A FAILED SEARCH.** A source that cannot be reached contributes
 *     an empty list and a STATED REASON in its own report; the other source's results are returned as
 *     normal. Nothing here throws for a network condition.
 *
 * ⚠ EVERY LIST IS CAPPED AND EVERY CAP IS REPORTED. `truncated` per source and once overall, plus the
 * counts of what was withheld and why. A list that quietly stops is indistinguishable from a
 * collection with only that many matches (contract §1.6), and here it would also hide the fact that
 * the licence filter did its job.
 *
 * ⚠ THIS MODULE RUNS ON THE SERVER. It is deliberately NOT marked `server-only`, because the picker
 * imports the source vocabulary and labels from it as VALUES rather than as types — but the fetching
 * functions must never be called from a browser. The licence classification is the whole control, and
 * a browser talking to the museums directly would bypass it and hand a reader's address to a third
 * party at the same time. Nothing here reads a secret, so it also imports nothing `server-only`; the
 * one environment value it needs is a `NEXT_PUBLIC_` one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { formatBytes } from "@/lib/utils";

// ─── The sources ────────────────────────────────────────────────────────────────────────────────

export const OPEN_COLLECTION_SOURCES = ["met", "commons"] as const;
export type OpenCollectionSource = (typeof OPEN_COLLECTION_SOURCES)[number];

/** What a source is called on screen. Full institutional names — an editor is agreeing to a licence. */
export const OPEN_COLLECTION_SOURCE_LABELS: Record<OpenCollectionSource, string> = {
  met: "The Metropolitan Museum of Art",
  commons: "Wikimedia Commons"
};

/** The one sentence each source's tab needs, saying what has been left out and why. */
export const OPEN_COLLECTION_SOURCE_NOTES: Record<OpenCollectionSource, string> = {
  met:
    "Only works the Museum has released into the public domain are offered. Everything else in its " +
    "collection is still under copyright and is not shown here.",
  commons:
    "Not everything on Commons may be reused. Only files under a public-domain, CC0, CC BY or " +
    "CC BY-SA licence are offered; anything else is left out of the results."
};

const MET_API = "https://collectionapi.metmuseum.org/public/collection/v1";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

/**
 * The only hosts this module will talk to — for a JSON read and for a file download alike.
 *
 * The URL always comes from the museum's own JSON, re-fetched server-side, so this should never fire.
 * It exists because "should never" and "cannot" are different claims: an odd or compromised response
 * that named an address on the deployment's private network would otherwise be fetched by the server
 * with the server's credentials, which is the request-forgery hole in every naïve importer.
 *
 * ⚠ AN ALLOWLIST CHECKED ONCE IS NOT A CONTROL, WHICH IS WHY EVERY HOP GOES THROUGH `fetchAllowed`.
 * These requests used to be issued with `redirect: "follow"`, and Node's fetch offers no per-hop
 * callback: a `302 Location: http://169.254.169.254/…` from an allowlisted host was followed to an
 * address nothing had ever checked, which is precisely the response the paragraph above says this list
 * exists to refuse. The list now constrains where the bytes COME FROM, not merely where the request
 * started.
 */
const DOWNLOAD_HOSTS = new Set([
  "images.metmuseum.org",
  "collectionapi.metmuseum.org",
  "upload.wikimedia.org",
  "commons.wikimedia.org"
]);

/**
 * How many redirects one request may follow. Both museums serve these URLs directly, so this is
 * headroom for a host that reorganises its paths, not a feature anything depends on.
 */
const MAX_REDIRECTS = 3;

/** Statuses that carry a `Location` to follow. 304 and 305 are 3xx and are neither. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ─── Caps, deadlines and allowances ─────────────────────────────────────────────────────────────

/** How many results a search may return. Stated in the answer so the screen can quote the real number. */
export const OPEN_COLLECTION_LIMITS = { default: 24, max: 48 } as const;

/**
 * How many Met object records one search will read.
 *
 * The Met's search returns identifiers only, so every candidate costs its own request — and most
 * candidates are still under copyright, so a good many are read and discarded. This is the ceiling on
 * that fan-out. Past it the search is slower than the person using it will tolerate, and the shortfall
 * is reported as `truncated` rather than hidden.
 */
const MET_RECORD_FETCH_CAP = 40;

/** Met record reads in flight at once. Enough to be quick, few enough to be a polite client. */
const MET_RECORD_CONCURRENCY = 6;

const SEARCH_TIMEOUT_MS = 12_000;
const RECORD_TIMEOUT_MS = 10_000;

/**
 * The size cap on a downloaded original, and the deadline for the transfer.
 *
 * 40 MB is generous for a museum master and small enough that the function holding it in memory can
 * still hand it to sharp. A file above the cap is REFUSED with the two numbers named, which is a
 * better outcome than an out-of-memory kill that loses the whole import with no explanation.
 */
export const OPEN_COLLECTION_MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 90_000;

/**
 * The two rate-limit allowances, DEFINED HERE rather than in `RATE_LIMITS`.
 *
 * `lib/ratelimit.ts` holds the policies for the public API, where the numbers a route enforces and the
 * numbers its message quotes must not drift apart. These two are different in kind: they exist to
 * protect somebody else's museum from this deployment, not to protect this deployment from the
 * internet, and both routes that read them are in this feature. Keeping them beside the code that
 * makes the outbound calls is what stops the allowance and the fan-out above from being changed
 * independently — one search is up to forty requests to the Met.
 */
export const OPEN_COLLECTION_SEARCH_RATE_LIMIT = { limit: 24, windowSeconds: 5 * 60 };
export const OPEN_COLLECTION_IMPORT_RATE_LIMIT = { limit: 40, windowSeconds: 15 * 60 };

/**
 * The file types this importer will accept.
 *
 * A DELIBERATE SUBSET of `DERIVABLE_MIME_TYPES` (lib/storage/derivatives.ts) — the derivative pipeline
 * can read all of these, and this list must never grow beyond it. SVG is absent on purpose: Commons is
 * full of them, and an SVG is a script-bearing document rather than a bitmap (see `isSvg`).
 */
const ACCEPTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/gif"
]);

// ─── The normalised shapes ──────────────────────────────────────────────────────────────────────

export interface OpenCollectionResult {
  source: OpenCollectionSource;
  /** The source's own identifier: a Met object number, or a Commons page title including `File:`. */
  sourceId: string;
  title: string;
  artist: string | null;
  /** As the source words it — "19th century", "ca. 1870". Never parsed into a number. */
  date: string | null;
  culture: string | null;
  /** The licence in words, ready to show an editor: "CC BY-SA 4.0", "Public domain". */
  licence: string;
  licenceUrl: string | null;
  /** Built once, in the form this licence requires. Stored as `MediaAsset.credit`. */
  attribution: string;
  /** Small preview for the picker. Null when the source offers no thumbnail. */
  thumbnailUrl: string | null;
  /** The full-resolution file. This is what the import downloads. */
  fullUrl: string;
  /** The record's own page at the source, for a human who wants to check it. */
  sourceUrl: string;
  /** What the source says the file is. Re-checked against the actual bytes at import. */
  mimeType: string | null;
}

export interface OpenCollectionSourceReport {
  source: OpenCollectionSource;
  label: string;
  /** Usable records this source contributed to `items`. */
  offered: number;
  /** Records left out because the licence is not one the Centre may use. */
  withheldForLicence: number;
  /** Records left out because the file is not a photograph this library can process. */
  withheldForFormat: number;
  /** True when the source had more matches than were returned. */
  truncated: boolean;
  /** Null when the source answered. A plain sentence, ready to render, when it did not. */
  problem: string | null;
}

export interface OpenCollectionSearchOutcome {
  items: OpenCollectionResult[];
  sources: OpenCollectionSourceReport[];
  /** True when any source had more matches than were returned. */
  truncated: boolean;
  /** The cap actually applied, so the screen quotes the enforced number rather than its own guess. */
  limit: number;
}

/**
 * One record, re-fetched and re-classified at import time.
 *
 * `refused` separates the two failures that must not be reported the same way: `true` means the record
 * exists and its licence is not one the Centre may use (a deliberate answer, and the whole point of
 * the control), `false` means the source could not be reached or does not know the identifier.
 */
export type OpenCollectionRecordOutcome =
  | { ok: true; record: OpenCollectionResult }
  | { ok: false; refused: boolean; reason: string };

// ─── Identity: tags, source URLs, file names ────────────────────────────────────────────────────

/** The tag every imported asset carries, so "everything from a museum" is one filter click. */
export const OPEN_COLLECTION_TAG = "open-collection";

/** Per-source tag, for "everything from Commons". */
export function openCollectionSourceTag(source: OpenCollectionSource): string {
  return source === "met" ? "met-museum" : "wikimedia-commons";
}

/**
 * The tag that IDENTIFIES the imported record — `met:436535`, `commons:File:Sari.jpg`.
 *
 * This is the de-duplication key, and it is a tag because `MediaAsset` has no column for a foreign
 * identifier and this feature may not change the schema. `tags` is a Postgres array and
 * `tags: { has: … }` is an exact match, so it does the job precisely. The media library's tag filter
 * orders by usage and caps at sixty, so these one-per-asset tags sink below the fold rather than
 * flooding the vocabulary — and that list already says out loud when it is capped.
 */
export function openCollectionIdentityTag(
  source: OpenCollectionSource,
  sourceId: string
): string {
  return `${source}:${sourceId}`;
}

/** Every tag an imported asset is created with. */
export function openCollectionTags(
  source: OpenCollectionSource,
  sourceId: string
): string[] {
  return [
    OPEN_COLLECTION_TAG,
    openCollectionSourceTag(source),
    openCollectionIdentityTag(source, sourceId)
  ];
}

/**
 * A source identifier, validated into its canonical form, or null.
 *
 * The import route calls this on whatever the browser sent BEFORE it is put into a URL. A Met
 * identifier is digits; a Commons identifier is a page title in the file namespace, which may contain
 * spaces and punctuation but never a control character and never a newline (a newline in a query
 * string is a request-splitting primitive).
 */
export function normaliseSourceId(
  source: OpenCollectionSource,
  raw: string
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }

  if (source === "met") return /^\d{1,9}$/.test(trimmed) ? trimmed : null;

  // Commons titles arrive with either spelling of the separator and, occasionally, a localised
  // namespace prefix. Only the canonical English one is accepted: it is what the API returns and what
  // a re-fetch has to send back.
  const normalised = trimmed.replace(/_/g, " ");
  return /^File:.+/.test(normalised) ? normalised : null;
}

/** The record's page at the source. Derived, never stored on its own — see `attribution`. */
export function openCollectionSourceUrl(
  source: OpenCollectionSource,
  sourceId: string
): string {
  if (source === "met") {
    return `https://www.metmuseum.org/art/collection/search/${encodeURIComponent(sourceId)}`;
  }
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(sourceId.replace(/ /g, "_"))}`;
}

/**
 * The file name the asset is stored under.
 *
 * Built from the work's title rather than from the source's own file name, because a Met original is
 * called `DP123456.jpg` and a librarian searching the media library for "sari" has to be able to find
 * it. `buildObjectKey` slugifies whatever it is given, so the only job here is to produce something
 * readable with the right extension.
 */
export function openCollectionFileName(record: OpenCollectionResult): string {
  const extension = extensionFromUrl(record.fullUrl) ?? "jpg";
  const stem = record.title.trim().length > 0 ? record.title.trim() : `${record.source}-${record.sourceId}`;
  return `${stem.slice(0, 80)}.${extension}`;
}

// ─── The outbound plumbing ──────────────────────────────────────────────────────────────────────

/**
 * The User-Agent every request here carries.
 *
 * Wikimedia's policy asks for a tool name, a version and a way to make contact, and it rate-limits
 * anonymous clients that send nothing useful. The contact is the site's own public address.
 *
 * ⚠ `process.env.NEXT_PUBLIC_SITE_URL` is written out IN FULL rather than read through a variable, for
 * the reason lib/media/url.ts sets out: Next's substitution is a literal text replacement and a
 * dynamic lookup silently reads `undefined`. `siteUrl()` from lib/env.ts is deliberately NOT used —
 * that module is `server-only`, and this one is imported by the picker for its source vocabulary.
 */
const USER_AGENT = (() => {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/$/, "");
  const contact = configured.length > 0 ? `+${configured}` : "no contact address configured";
  return `CxACentreOfExcellencePortal/1.0 (${contact}) open-collections-importer`;
})();

/**
 * One outbound request, with EVERY HOP CHECKED against `DOWNLOAD_HOSTS`.
 *
 * `redirect: "manual"` rather than `"follow"`, and the chain is walked here so each `Location` is
 * parsed and re-checked before it is fetched. That is the whole point: `fetch` decides a redirect
 * before any of this module's code sees it, so an allowlist applied only to the URL passed in
 * constrains nothing about where the response actually comes from.
 *
 * ONE deadline covers the whole chain rather than one per hop — three hops with a fresh 90-second
 * timeout each is a four-and-a-half-minute request the caller never agreed to.
 *
 * A relative `Location` is resolved against the URL that produced it, exactly as a browser would, and
 * then goes through the same check: `/../../` cannot leave the host, but a protocol-relative
 * `//example.org/x` very much can.
 */
async function fetchAllowed(
  start: URL,
  accept: string,
  timeoutMs: number
): Promise<{ ok: true; response: Response } | { ok: false; reason: string }> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let current = start;

  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== "https:" || !DOWNLOAD_HOSTS.has(current.hostname)) {
      // Worded from the hop it failed on, because "the collection redirected us somewhere odd" and
      // "that address was never one we would call" send an editor to two different places.
      return {
        ok: false,
        reason:
          hop === 0
            ? `${current.hostname} is not one of the addresses this importer will talk to. Nothing was fetched.`
            : `The collection redirected the request to ${current.hostname}, which is not one of the ` +
              "addresses this importer will talk to. Nothing was fetched from it."
      };
    }

    let response: Response;
    try {
      response = await fetch(current.toString(), {
        headers: { accept, "user-agent": USER_AGENT },
        redirect: "manual",
        cache: "no-store",
        signal: deadline
      });
    } catch {
      return { ok: false, reason: "The collection could not be reached, or it took too long to answer." };
    }

    if (!REDIRECT_STATUSES.has(response.status)) return { ok: true, response };

    // The redirect's own body is never read, and an unread body holds the connection open.
    await response.body?.cancel().catch(() => undefined);

    const location = response.headers.get("location");
    if (!location) {
      return {
        ok: false,
        reason: `The collection answered with a redirect (HTTP ${response.status}) that named no address.`
      };
    }
    if (hop >= MAX_REDIRECTS) {
      return {
        ok: false,
        reason: `The collection redirected the request more than ${MAX_REDIRECTS} times, so it was abandoned.`
      };
    }
    try {
      current = new URL(location, current);
    } catch {
      return { ok: false, reason: "The collection redirected to an address that could not be read." };
    }
  }
}

/** Every request, one place. `no-store` because a studio search must never read a stale cache. */
async function fetchJson(
  url: string,
  timeoutMs: number
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; reason: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, status: 0, reason: "The address for that collection could not be read." };
  }

  // The same per-hop allowlist as the download path. These URLs are built from the two API constants
  // above, so the FIRST hop is a formality — the hops after it are not, and a JSON read that followed
  // a redirect inside the deployment's network is the same request-forgery hole with a smaller prize.
  const attempt = await fetchAllowed(target, "application/json", timeoutMs);
  if (!attempt.ok) return { ok: false, status: 0, reason: attempt.reason };
  const response = attempt.response;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: `The collection answered with an error (HTTP ${response.status}).`
    };
  }

  try {
    return { ok: true, value: (await response.json()) as unknown };
  } catch {
    return {
      ok: false,
      status: response.status,
      reason: "The collection answered with something that was not readable."
    };
  }
}

/**
 * Download a full-size original, with a hard size cap and a deadline.
 *
 * The bytes are read through the stream rather than with `arrayBuffer()` so the cap can stop a
 * transfer PART WAY THROUGH. Waiting for the whole body and then measuring it means a mislabelled
 * 400 MB file is already in memory by the time it is refused, which is the failure the cap exists to
 * prevent.
 *
 * Returns raw bytes, not a `Buffer`: the caller wraps them, which keeps this module free of anything
 * that only exists in Node.
 */
export async function downloadOpenCollectionImage(input: {
  url: string;
  maxBytes?: number;
}): Promise<{ ok: true; bytes: Uint8Array; contentType: string | null } | { ok: false; reason: string }> {
  const maxBytes = input.maxBytes ?? OPEN_COLLECTION_MAX_IMAGE_BYTES;

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { ok: false, reason: "The collection gave an address for the picture that could not be read." };
  }
  if (parsed.protocol !== "https:" || !DOWNLOAD_HOSTS.has(parsed.hostname)) {
    return {
      ok: false,
      reason:
        `The picture is hosted at ${parsed.hostname}, which is not one of the addresses this ` +
        "importer will download from. Nothing was fetched."
    };
  }

  // The check above is kept for its sentence, which names the host the RECORD gave; `fetchAllowed`
  // repeats it and then applies it to every redirect the transfer takes.
  const attempt = await fetchAllowed(parsed, "image/*", IMAGE_TIMEOUT_MS);
  if (!attempt.ok) return { ok: false, reason: attempt.reason };
  const response = attempt.response;

  if (!response.ok) {
    return {
      ok: false,
      reason: `The collection refused to send the picture (HTTP ${response.status}).`
    };
  }

  // Checked before a single byte is read, where the server is honest enough to declare it.
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      reason:
        `The full-size picture is ${formatBytes(declared)}, which is above the ` +
        `${formatBytes(maxBytes)} limit for an import. Nothing was downloaded.`
    };
  }

  const body = response.body;
  if (!body) {
    return { ok: false, reason: "The collection sent an empty answer instead of the picture." };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          reason:
            `The picture turned out to be larger than the ${formatBytes(maxBytes)} limit for an ` +
            "import, so the download was stopped and nothing was stored."
        };
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      reason: "The download stopped part way through, so nothing was stored."
    };
  }

  if (total === 0) {
    return { ok: false, reason: "The collection sent a file of no length." };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, bytes, contentType: response.headers.get("content-type") };
}

// ─── Reading somebody else's JSON ───────────────────────────────────────────────────────────────
// Every value from a museum API is `unknown` until one of these has looked at it. Casting the whole
// response to an interface would typecheck perfectly and crash the moment a field is absent, which on
// a collection of two million heterogeneous records is not an edge case.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Strip the HTML out of a Commons metadata value.
 *
 * `extmetadata` fields are HTML fragments — an `Artist` is very often `<a href="…">Name</a>`, and
 * sometimes a whole table. Putting that into `credit` would render markup inside a figcaption on the
 * public site, so the tags come out and the handful of entities that matter are decoded. Anything
 * still suspiciously long is truncated, because an attribution is a line, not a document.
 */
function stripHtml(value: string | null, maxLength = 300): string | null {
  if (!value) return null;
  const text = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function extensionFromUrl(url: string): string | null {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const match = /\.([a-zA-Z0-9]{2,5})$/.exec(withoutQuery);
  const extension = match?.[1]?.toLowerCase();
  if (!extension) return null;
  return extension === "jpeg" ? "jpg" : extension;
}

/** The MIME type an extension implies, for the picker's benefit only. The bytes decide at import. */
function mimeFromUrl(url: string): string | null {
  switch (extensionFromUrl(url)) {
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "gif":
      return "image/gif";
    default:
      return null;
  }
}

// ─── Attribution ────────────────────────────────────────────────────────────────────────────────

/**
 * The attribution line, assembled from parts.
 *
 * ONE FUNCTION FOR BOTH SOURCES, so the two can never drift into two different house styles. The
 * order is the one every reuse guide asks for — work, creator, holder, licence, source — and the
 * source URL is LAST and carries no trailing full stop, because a period welded to a URL breaks it
 * for anybody who copies the line.
 */
function buildAttribution(input: {
  work: string | null;
  creator: string | null;
  holder: string;
  /** A credit line the source itself supplies, or the attribution an uploader has asked for. */
  extra: string | null;
  licence: string;
  licenceUrl: string | null;
  sourceUrl: string;
}): string {
  const sentences: string[] = [];

  const work = input.work?.trim();
  const creator = input.creator?.trim();
  if (work && creator) sentences.push(`${work}, by ${creator}`);
  else if (work) sentences.push(work);
  else if (creator) sentences.push(`A work by ${creator}`);

  sentences.push(input.holder);

  const extra = input.extra?.trim();
  if (extra) sentences.push(extra);

  sentences.push(
    input.licenceUrl ? `Licence: ${input.licence} (${input.licenceUrl})` : `Licence: ${input.licence}`
  );

  const body = sentences
    .map((sentence) => sentence.replace(/[.\s]+$/, ""))
    .filter((sentence) => sentence.length > 0)
    .join(". ");

  return `${body}. Source: ${input.sourceUrl}`;
}

// ─── Licences ───────────────────────────────────────────────────────────────────────────────────

interface LicenceVerdict {
  licence: string;
  licenceUrl: string | null;
}

const CC0: LicenceVerdict = {
  licence: "CC0 1.0 (public domain dedication)",
  licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/"
};

const PUBLIC_DOMAIN: LicenceVerdict = { licence: "Public domain", licenceUrl: null };

/**
 * Wording that disqualifies a file OUTRIGHT, whatever its machine-readable licence code says.
 *
 * Belt and braces over the allow-list below. A Commons file can carry a plausible licence template
 * and a usage-terms line that contradicts it, and the direction to fail in is obvious: refusing a
 * usable photograph costs an editor one search, and importing an unusable one costs the Centre a
 * letter from a lawyer.
 */
const DISQUALIFYING = /fair use|non-?free|all rights reserved|copyrighted|with permission|\bnc\b|noncommercial|non-commercial|\bnd\b|no derivative|\bgfdl\b/i;

/** The licence codes Commons uses, mapped to a human name. Anything unmatched is refused. */
function licenceFromCode(code: string): LicenceVerdict | null {
  if (code === "cc0" || code.startsWith("cc0-")) return CC0;
  if (code === "pd" || code.startsWith("pd-")) return PUBLIC_DOMAIN;

  // by-sa first: `cc-by-sa-4.0` must not be read as a `cc-by-` licence with a strange version.
  const bySa = /^cc-by-sa-(\d+(?:\.\d+)?)/.exec(code);
  if (bySa?.[1]) {
    return {
      licence: `CC BY-SA ${bySa[1]}`,
      licenceUrl: `https://creativecommons.org/licenses/by-sa/${bySa[1]}/`
    };
  }
  const by = /^cc-by-(\d+(?:\.\d+)?)/.exec(code);
  if (by?.[1]) {
    return {
      licence: `CC BY ${by[1]}`,
      licenceUrl: `https://creativecommons.org/licenses/by/${by[1]}/`
    };
  }
  return null;
}

/**
 * The same question asked of the human-readable name.
 *
 * A fallback, not a shortcut: a good many older Commons files carry a `LicenseShortName` and no
 * machine-readable `License`, and refusing every one of them would throw away most of the
 * nineteenth-century material this Centre actually wants. The pattern is anchored, so "CC BY-SA 3.0"
 * matches and "Not CC BY" does not.
 */
function licenceFromName(name: string): LicenceVerdict | null {
  const lower = name.toLowerCase();
  if (/^cc0\b/.test(lower)) return CC0;
  if (lower.startsWith("public domain")) return PUBLIC_DOMAIN;

  const bySa = /^cc[ -]by[ -]sa[ -](\d+(?:\.\d+)?)/.exec(lower);
  if (bySa?.[1]) {
    return {
      licence: `CC BY-SA ${bySa[1]}`,
      licenceUrl: `https://creativecommons.org/licenses/by-sa/${bySa[1]}/`
    };
  }
  const by = /^cc[ -]by[ -](\d+(?:\.\d+)?)/.exec(lower);
  if (by?.[1]) {
    return {
      licence: `CC BY ${by[1]}`,
      licenceUrl: `https://creativecommons.org/licenses/by/${by[1]}/`
    };
  }
  return null;
}

/**
 * Is this Commons file one the Centre may use?
 *
 * The order matters. The disqualifying wording is checked FIRST, across every licence field at once,
 * so a file whose template says CC BY and whose usage terms say "non-commercial only" is refused
 * rather than accepted on the strength of the template.
 */
function classifyCommonsLicence(input: {
  code: string | null;
  shortName: string | null;
  usageTerms: string | null;
  restrictions: string | null;
}): LicenceVerdict | null {
  const combined = [input.code, input.shortName, input.usageTerms, input.restrictions]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  if (DISQUALIFYING.test(combined)) return null;

  const code = (input.code ?? "").trim().toLowerCase();
  const fromCode = code.length > 0 ? licenceFromCode(code) : null;
  if (fromCode) return fromCode;

  const name = (input.shortName ?? "").trim();
  return name.length > 0 ? licenceFromName(name) : null;
}

// ─── The Metropolitan Museum of Art ─────────────────────────────────────────────────────────────

/** One Met record, normalised — or which bucket it was withheld into. */
type MetOutcome =
  | { kind: "ok"; record: OpenCollectionResult }
  | { kind: "licence" }
  | { kind: "format" }
  | { kind: "unreachable"; reason: string };

function normaliseMetRecord(value: unknown): MetOutcome {
  const record = asRecord(value);
  if (!record) return { kind: "unreachable", reason: "The Museum's answer could not be read." };

  const objectId = asString(record.objectID);
  if (!objectId) return { kind: "unreachable", reason: "The Museum's answer named no object." };

  // ⚠ THE ONE CHECK THAT MATTERS. Anything but a literal `true` is treated as "still in copyright" —
  // a missing field, a null, the string "true" from some future version of the API. A truthy test
  // here would accept every one of those.
  if (record.isPublicDomain !== true) return { kind: "licence" };

  const fullUrl = asString(record.primaryImage);
  if (!fullUrl) return { kind: "format" };
  const mimeType = mimeFromUrl(fullUrl);
  if (mimeType !== null && !ACCEPTED_IMAGE_TYPES.has(mimeType)) return { kind: "format" };

  const title = asString(record.title) ?? `Metropolitan Museum object ${objectId}`;
  const artist = asString(record.artistDisplayName);
  const date = asString(record.objectDate);
  const culture = asString(record.culture) ?? asString(record.department);
  const sourceUrl = asString(record.objectURL) ?? openCollectionSourceUrl("met", objectId);
  const creditLine = asString(record.creditLine);

  return {
    kind: "ok",
    record: {
      source: "met",
      sourceId: objectId,
      title,
      artist,
      date,
      culture,
      licence: CC0.licence,
      licenceUrl: CC0.licenceUrl,
      attribution: buildAttribution({
        work: date ? `${title} (${date})` : title,
        creator: artist,
        holder: "The Metropolitan Museum of Art, New York",
        extra: creditLine,
        licence: CC0.licence,
        licenceUrl: CC0.licenceUrl,
        sourceUrl
      }),
      thumbnailUrl: asString(record.primaryImageSmall) ?? fullUrl,
      fullUrl,
      sourceUrl,
      mimeType
    }
  };
}

async function fetchMetRecord(objectId: string): Promise<MetOutcome> {
  const answer = await fetchJson(`${MET_API}/objects/${encodeURIComponent(objectId)}`, RECORD_TIMEOUT_MS);
  if (!answer.ok) {
    if (answer.status === 404) {
      return {
        kind: "unreachable",
        reason: "The Museum does not have an object with that number."
      };
    }
    return { kind: "unreachable", reason: answer.reason };
  }
  return normaliseMetRecord(answer.value);
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, preserving input order.
 *
 * Written out rather than reached for from a dependency: a `Promise.all` over forty museum requests
 * opens forty sockets at once, which is impolite to a free API and is the behaviour that gets a client
 * throttled. Order is preserved because the picker's list must be stable between identical searches.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  });

  await Promise.all(runners);
  return results.filter((value): value is R => value !== undefined);
}

async function searchMet(query: string, limit: number): Promise<OpenCollectionSourceReport & { items: OpenCollectionResult[] }> {
  const base: OpenCollectionSourceReport = {
    source: "met",
    label: OPEN_COLLECTION_SOURCE_LABELS.met,
    offered: 0,
    withheldForLicence: 0,
    withheldForFormat: 0,
    truncated: false,
    problem: null
  };

  const url = `${MET_API}/search?hasImages=true&q=${encodeURIComponent(query)}`;
  const answer = await fetchJson(url, SEARCH_TIMEOUT_MS);
  if (!answer.ok) {
    return {
      ...base,
      items: [],
      problem: `${OPEN_COLLECTION_SOURCE_LABELS.met} could not be searched. ${answer.reason} The other collection was searched as normal.`
    };
  }

  const payload = asRecord(answer.value);
  const identifiers = asArray(payload?.objectIDs)
    .map((value) => asString(value))
    .filter((value): value is string => value !== null && /^\d{1,9}$/.test(value));

  if (identifiers.length === 0) return { ...base, items: [] };

  // Only the first slice is read. Every one of these is its own request, and most Met records are
  // still in copyright, so the slice is deliberately larger than `limit` — but bounded.
  const candidates = identifiers.slice(0, Math.min(MET_RECORD_FETCH_CAP, Math.max(limit * 2, limit)));
  const outcomes = await mapWithConcurrency(candidates, MET_RECORD_CONCURRENCY, fetchMetRecord);

  const usable: OpenCollectionResult[] = [];
  let withheldForLicence = 0;
  let withheldForFormat = 0;
  let unreachable = 0;

  for (const outcome of outcomes) {
    if (outcome.kind === "ok") {
      usable.push(outcome.record);
      continue;
    }
    if (outcome.kind === "licence") withheldForLicence += 1;
    else if (outcome.kind === "format") withheldForFormat += 1;
    else unreachable += 1;
  }

  const items = usable.slice(0, limit);

  // Truncated when the search had more matches than were READ, or when more were usable than the cap
  // allowed through. Both are the same fact for the reader: there is more to be found. Compared
  // against `usable`, not against `items` — `items.length === limit` on its own would report a
  // truncation whenever the answer happened to fill the page exactly.
  const truncated = identifiers.length > candidates.length || usable.length > limit;

  return {
    ...base,
    items,
    offered: items.length,
    withheldForLicence,
    withheldForFormat,
    truncated,
    problem:
      unreachable > 0
        ? `${unreachable} ${unreachable === 1 ? "record" : "records"} from ${OPEN_COLLECTION_SOURCE_LABELS.met} could not be read and are not listed.`
        : null
  };
}

// ─── Wikimedia Commons ──────────────────────────────────────────────────────────────────────────

/** Read one `extmetadata` entry's value. The wrapper is `{ value, source, hidden? }`. */
function extValue(extmetadata: Record<string, unknown> | null, key: string): string | null {
  if (!extmetadata) return null;
  const entry = asRecord(extmetadata[key]);
  return entry ? asString(entry.value) : null;
}

type CommonsOutcome =
  | { kind: "ok"; record: OpenCollectionResult }
  | { kind: "licence" }
  | { kind: "format" };

function normaliseCommonsPage(page: unknown): CommonsOutcome {
  const record = asRecord(page);
  if (!record) return { kind: "format" };

  const title = asString(record.title);
  if (!title || !/^File:/.test(title)) return { kind: "format" };

  const info = asRecord(asArray(record.imageinfo)[0]);
  if (!info) return { kind: "format" };

  const fullUrl = asString(info.url);
  const sourceUrl = asString(info.descriptionurl) ?? openCollectionSourceUrl("commons", title);
  if (!fullUrl) return { kind: "format" };

  // The declared type is authoritative enough to EXCLUDE — an SVG, a PDF, an OGG. It is not
  // authoritative enough to include, which is why the import route probes the bytes as well.
  const declaredMime = asString(info.mime);
  const mimeType = declaredMime ?? mimeFromUrl(fullUrl);
  if (mimeType === null || !ACCEPTED_IMAGE_TYPES.has(mimeType)) return { kind: "format" };

  const extmetadata = asRecord(info.extmetadata);
  const verdict = classifyCommonsLicence({
    code: extValue(extmetadata, "License"),
    shortName: extValue(extmetadata, "LicenseShortName"),
    usageTerms: extValue(extmetadata, "UsageTerms"),
    restrictions: extValue(extmetadata, "Restrictions")
  });
  if (!verdict) return { kind: "licence" };

  // `Artist` and `Attribution` are HTML fragments. `Attribution` is what the uploader has asked to be
  // credited, and it wins over a derived name for exactly that reason.
  const artist = stripHtml(extValue(extmetadata, "Artist"), 160);
  const requested = stripHtml(extValue(extmetadata, "Attribution"), 200);
  const objectName = stripHtml(extValue(extmetadata, "ObjectName"), 160);
  const date = stripHtml(extValue(extmetadata, "DateTimeOriginal"), 60);

  // The page title minus the namespace and the extension — a readable name when nothing better exists.
  const fallbackName = title.replace(/^File:/, "").replace(/\.[^.]+$/, "").replace(/_/g, " ");
  const work = objectName ?? fallbackName;

  return {
    kind: "ok",
    record: {
      source: "commons",
      sourceId: title,
      title: work,
      artist,
      date,
      culture: null,
      licence: verdict.licence,
      licenceUrl: verdict.licenceUrl,
      attribution: buildAttribution({
        work: date ? `${work} (${date})` : work,
        creator: requested ? null : artist,
        holder: "Via Wikimedia Commons",
        extra: requested,
        licence: verdict.licence,
        licenceUrl: verdict.licenceUrl,
        sourceUrl
      }),
      thumbnailUrl: asString(info.thumburl) ?? fullUrl,
      fullUrl,
      sourceUrl,
      mimeType
    }
  };
}

function commonsSearchUrl(query: string, limit: number): string {
  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("generator", "search");
  // `filetype:bitmap` is part of the SEARCH rather than a filter applied afterwards, so the licence
  // budget is not spent reading SVGs, PDFs and sound files that would be discarded anyway.
  url.searchParams.set("gsrsearch", `${query} filetype:bitmap`);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(limit));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata|mime|size");
  // A real thumbnail rather than the full file, which on Commons is regularly a 60 MB TIFF.
  url.searchParams.set("iiurlwidth", "400");
  return url.toString();
}

async function searchCommons(
  query: string,
  limit: number
): Promise<OpenCollectionSourceReport & { items: OpenCollectionResult[] }> {
  const base: OpenCollectionSourceReport = {
    source: "commons",
    label: OPEN_COLLECTION_SOURCE_LABELS.commons,
    offered: 0,
    withheldForLicence: 0,
    withheldForFormat: 0,
    truncated: false,
    problem: null
  };

  // Asked for more than the cap, because the licence filter will refuse some of them and a page of
  // results that comes back half empty reads as "there is nothing there".
  const requested = Math.min(limit * 2, 100);
  const answer = await fetchJson(commonsSearchUrl(query, requested), SEARCH_TIMEOUT_MS);
  if (!answer.ok) {
    return {
      ...base,
      items: [],
      problem: `${OPEN_COLLECTION_SOURCE_LABELS.commons} could not be searched. ${answer.reason} The other collection was searched as normal.`
    };
  }

  const payload = asRecord(answer.value);
  const pages = asArray(asRecord(payload?.query)?.pages);

  const usable: OpenCollectionResult[] = [];
  let withheldForLicence = 0;
  let withheldForFormat = 0;

  for (const page of pages) {
    const outcome = normaliseCommonsPage(page);
    if (outcome.kind === "ok") {
      usable.push(outcome.record);
      continue;
    }
    if (outcome.kind === "licence") withheldForLicence += 1;
    else withheldForFormat += 1;
  }

  const items = usable.slice(0, limit);

  // `continue` is Commons saying there are more matches. Combined with the local cap, either means
  // the reader is looking at part of the answer.
  const moreAtSource = asRecord(payload?.continue) !== null || pages.length >= requested;

  return {
    ...base,
    items,
    offered: items.length,
    withheldForLicence,
    withheldForFormat,
    truncated: moreAtSource || usable.length > limit,
    problem: null
  };
}

// ─── The two entry points ───────────────────────────────────────────────────────────────────────

/**
 * Search one collection or both.
 *
 * Results from two sources are INTERLEAVED rather than concatenated. A page that is forty-eight Met
 * records followed by nothing is a page on which the Commons material may as well not exist, and the
 * editor has no way to tell that the second source answered at all.
 *
 * Never throws for anything a museum did. A source that failed says so in its own report and the
 * other source's results come back as normal.
 */
export async function searchOpenCollections(input: {
  query: string;
  source?: OpenCollectionSource | "all";
  limit?: number;
}): Promise<OpenCollectionSearchOutcome> {
  const query = input.query.trim();
  const limit = Math.max(
    1,
    Math.min(Math.floor(input.limit ?? OPEN_COLLECTION_LIMITS.default), OPEN_COLLECTION_LIMITS.max)
  );
  const wanted = input.source ?? "all";

  if (query.length === 0) {
    return {
      items: [],
      sources: [],
      truncated: false,
      limit
    };
  }

  const perSource = wanted === "all" ? Math.max(1, Math.ceil(limit / 2)) : limit;

  const jobs: Promise<OpenCollectionSourceReport & { items: OpenCollectionResult[] }>[] = [];
  if (wanted === "all" || wanted === "met") jobs.push(searchMet(query, perSource));
  if (wanted === "all" || wanted === "commons") jobs.push(searchCommons(query, perSource));

  // `allSettled`, not `all`: a rejection here would be a bug in this module rather than a museum being
  // down, and even then the other source's answer is worth returning. Rule 4 in the header.
  const settled = await Promise.allSettled(jobs);

  const reports: OpenCollectionSourceReport[] = [];
  const lists: OpenCollectionResult[][] = [];

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      const { items, ...report } = outcome.value;
      reports.push(report);
      lists.push(items);
      continue;
    }
    console.error("[open-collections] a source failed unexpectedly", outcome.reason);
  }

  // Round-robin across the sources, so both are visible in the first row of the grid.
  const items: OpenCollectionResult[] = [];
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let index = 0; index < longest && items.length < limit; index += 1) {
    for (const list of lists) {
      if (items.length >= limit) break;
      const entry = list[index];
      if (entry) items.push(entry);
    }
  }

  const dropped = lists.reduce((sum, list) => sum + list.length, 0) > items.length;

  return {
    items,
    sources: reports,
    truncated: dropped || reports.some((report) => report.truncated),
    limit
  };
}

/**
 * Re-fetch ONE record server-side and re-decide its licence.
 *
 * ⚠ THIS IS THE CONTROL, and the import route must call it rather than trusting anything the browser
 * sent. A client that had edited the search results on the way back could otherwise present a
 * copyrighted photograph with the word "CC0" attached to it, and the importer would believe it —
 * a licence in a request body is a value the caller chose, not a fact about the work.
 */
export async function fetchOpenCollectionRecord(input: {
  source: OpenCollectionSource;
  sourceId: string;
}): Promise<OpenCollectionRecordOutcome> {
  const sourceId = normaliseSourceId(input.source, input.sourceId);
  if (!sourceId) {
    return {
      ok: false,
      refused: false,
      reason: "That is not a reference this importer recognises, so nothing was fetched."
    };
  }

  if (input.source === "met") {
    const outcome = await fetchMetRecord(sourceId);
    if (outcome.kind === "ok") return { ok: true, record: outcome.record };
    if (outcome.kind === "licence") {
      return {
        ok: false,
        refused: true,
        reason:
          "The Museum has not released this work into the public domain, so it cannot be added to the " +
          "library. Nothing was downloaded."
      };
    }
    if (outcome.kind === "format") {
      return {
        ok: false,
        refused: true,
        reason:
          "This record has no full-size photograph in a format the library can store, so nothing was added."
      };
    }
    return { ok: false, refused: false, reason: outcome.reason };
  }

  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("titles", sourceId);
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|extmetadata|mime|size");
  url.searchParams.set("iiurlwidth", "400");

  const answer = await fetchJson(url.toString(), RECORD_TIMEOUT_MS);
  if (!answer.ok) return { ok: false, refused: false, reason: answer.reason };

  const pages = asArray(asRecord(asRecord(answer.value)?.query)?.pages);
  const page = asRecord(pages[0]);
  if (!page || page.missing === true) {
    return {
      ok: false,
      refused: false,
      reason: "Wikimedia Commons no longer has a file with that name. It may have been renamed or deleted."
    };
  }

  const outcome = normaliseCommonsPage(page);
  if (outcome.kind === "ok") return { ok: true, record: outcome.record };
  if (outcome.kind === "licence") {
    return {
      ok: false,
      refused: true,
      reason:
        "This file's licence is not one the Centre may reuse — only public-domain, CC0, CC BY and " +
        "CC BY-SA files are accepted. Nothing was downloaded."
    };
  }
  return {
    ok: false,
    refused: true,
    reason:
      "This file is not a photograph the library can store — drawings saved as SVG, documents and " +
      "sound files are all left out. Nothing was added."
  };
}
