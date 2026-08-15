import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertSameOrigin, noContent, parseJson, route } from "@/lib/api";
import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/ratelimit";
import { getSetting } from "@/lib/settings/service";

/**
 * The page-view beacon.
 *
 * It answers 204 and it must never block or slow the page: every failure past validation is logged to
 * the server and swallowed, because a lost count is a missing number and a thrown error is a console
 * full of red on an article that rendered perfectly.
 *
 * ⚠ **WHY THE PATH IS VALIDATED AND THEN RESOLVED.** `PageViewDaily` is unique on (day, path, country),
 * so the number of rows it can ever hold is the number of distinct paths anybody posts. An unbounded
 * `path` string therefore is not a cosmetic problem — it is an attacker-controlled INSERT loop, a
 * denial of service with a database bill attached, and the table it fills is the one the analytics
 * screen has to aggregate. Two defences, in order:
 *
 *   1. **Shape.** Lowercase, at most three segments, each a slug, no reserved prefix, no query string.
 *      That bounds the length and the character set of anything that reaches the database.
 *   2. **Resolution.** A shape-valid path is still an unbounded space, so the path must also RESOLVE to
 *      something the site can render — a known route, a live page, or a live record under a known
 *      section. One indexed lookup, and the row count is then bounded by the amount of published
 *      content rather than by anybody's imagination.
 *
 * A path that does not resolve is answered 204 with no write. Not an error: a reader who followed a
 * stale link is not at fault, and the count for a page that does not exist has nothing to be added to.
 *
 * `uniques` is never written. There is no cookie and no visitor identifier anywhere in this product
 * (see the schema's note on `PageViewDaily`), so a unique count could only be invented. It stays 0, and
 * the analytics screen must not label it as anything other than what it is.
 */

export const dynamic = "force-dynamic";

/** One path segment: the same shape `slugify()` produces. */
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,95}$/;
/** `/about/history/gallery` is as deep as this site goes. Anything deeper is not one of ours. */
const MAX_SEGMENTS = 3;
const MAX_PATH_CHARS = 200;

/** Route prefixes that are not public content and must never appear in the analytics table. */
const RESERVED_SEGMENTS = new Set(["api", "studio", "console", "_next", "static"]);

/**
 * Routes that exist in CODE rather than as a `Page` row.
 *
 * They are counted without a lookup, because there is nothing to look them up in — and leaving them
 * out would mean the index pages, which are among the most visited on the site, showed no traffic at
 * all.
 */
const KNOWN_ROUTES = new Set([
  "/",
  "/about",
  "/research",
  "/projects",
  "/publications",
  "/people",
  "/news",
  "/events",
  "/gallery",
  "/craft-explorer",
  "/contact",
  "/search"
]);

/**
 * Sections whose second segment is a record slug.
 *
 * The value names which table to confirm it against. `/search?q=…` is deliberately absent: the query is
 * stripped before it gets here, so every search collapses into one `/search` row — keeping it would put
 * one row per phrase somebody typed into an analytics table, which is both the unbounded-row problem
 * and a log of readers' searches nobody agreed to keep.
 */
type DetailSection =
  | "news"
  | "events"
  | "projects"
  | "publications"
  | "people"
  | "gallery"
  | "craft-explorer"
  | "research";

const DETAIL_SECTIONS = new Set<string>([
  "news",
  "events",
  "projects",
  "publications",
  "people",
  "gallery",
  "craft-explorer",
  "research"
]);

/** Strip the query and the fragment, lower-case, and normalise the slashes. */
function normalisePath(raw: string): string {
  const withoutQuery = raw.split("?")[0]?.split("#")[0] ?? "";
  const lowered = withoutQuery.trim().toLowerCase();
  const withLeadingSlash = lowered.startsWith("/") ? lowered : `/${lowered}`;
  if (withLeadingSlash === "/") return "/";
  // One trailing slash removed; a doubled slash is NOT repaired, so `//evil.example` fails the shape
  // check below instead of being quietly turned into a path we would then count.
  return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function pathSegments(path: string): string[] {
  return path === "/" ? [] : path.slice(1).split("/");
}

function isPlausibleSitePath(path: string): boolean {
  if (!path.startsWith("/") || path.length > MAX_PATH_CHARS) return false;
  if (path === "/") return true;
  const segments = pathSegments(path);
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return false;
  if (RESERVED_SEGMENTS.has(segments[0] ?? "")) return false;
  return segments.every((segment) => SEGMENT.test(segment));
}

const ViewBody = z.object({
  /**
   * The path of the page that was read — `/news/loom-survey-2026`, never a full URL and never a query
   * string.
   *
   * ⚠ A beacon sent with `navigator.sendBeacon` arrives as `text/plain`; `parseJson` reads the body
   * regardless of its content type, so that works. `assertSameOrigin` also permits a request with no
   * `Origin` header at all (see its own note), which some beacon implementations omit.
   */
  path: z
    .string()
    .max(512)
    .transform(normalisePath)
    .refine(isPlausibleSitePath, {
      message: "That is not a path on this site, so there is nothing to count against it."
    })
});

/** UTC midnight for the day bucket. Local midnight gives two rows for one day whenever the server moves. */
function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * A two-letter country, from whichever header the platform in front of us sets.
 *
 * Validated to exactly two letters and nothing else: `country` is part of the unique key, so an
 * arbitrary header value is the unbounded-row problem again, arriving through a different door.
 * Cloudflare's "XX" (unknown) and "T1" (Tor) are folded to null rather than stored as if they were
 * places.
 */
function readCountry(request: Request): string | null {
  const raw =
    request.headers.get("x-vercel-ip-country") ??
    request.headers.get("cf-ipcountry") ??
    request.headers.get("x-country-code");
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (code === "XX" || code === "T1") return null;
  return code;
}

interface Resolution {
  countable: boolean;
  /** Set only when the path is an article, so `Post.viewCount` can be incremented too. */
  postId?: string;
}

const NOT_COUNTABLE: Resolution = { countable: false };

/**
 * Does this path address something the site can render?
 *
 * At most ONE query. Each lookup is a unique-slug read with the publication filter applied, so an
 * unpublished or soft-deleted record contributes no rows — a beacon for a draft somebody previewed is
 * not traffic on a public page.
 */
async function resolvePath(path: string): Promise<Resolution> {
  if (KNOWN_ROUTES.has(path)) return { countable: true };

  const segments = pathSegments(path);
  const [first, second] = segments;

  if (segments.length === 2 && first && second && DETAIL_SECTIONS.has(first)) {
    const section = first as DetailSection;
    switch (section) {
      case "news": {
        // `Post` has publishAt/unpublishAt, so it takes the publishable filter — and it is the one
        // section whose row also carries a view counter.
        const post = await prisma.post.findFirst({
          where: { slug: second, ...livePublishableWhere() },
          select: { id: true }
        });
        return post ? { countable: true, postId: post.id } : NOT_COUNTABLE;
      }
      case "events": {
        const found = await prisma.coeEvent.findFirst({
          where: { slug: second, ...liveStatusWhere() },
          select: { id: true }
        });
        return found ? { countable: true } : NOT_COUNTABLE;
      }
      case "projects": {
        const found = await prisma.project.findFirst({
          where: { slug: second, ...liveStatusWhere() },
          select: { id: true }
        });
        return found ? { countable: true } : NOT_COUNTABLE;
      }
      case "publications": {
        const found = await prisma.publication.findFirst({
          where: { slug: second, ...liveStatusWhere() },
          select: { id: true }
        });
        return found ? { countable: true } : NOT_COUNTABLE;
      }
      case "people": {
        const found = await prisma.person.findFirst({
          // `isVisible` hides a person from every public surface, so their page is not a public page.
          where: { slug: second, isVisible: true, ...liveStatusWhere() },
          select: { id: true }
        });
        return found ? { countable: true } : NOT_COUNTABLE;
      }
      case "gallery": {
        const found = await prisma.galleryAlbum.findFirst({
          where: { slug: second, ...liveStatusWhere() },
          select: { id: true }
        });
        return found ? { countable: true } : NOT_COUNTABLE;
      }
      case "craft-explorer": {
        const found = await prisma.craft.findFirst({
          where: { slug: second, ...liveStatusWhere() },
          select: { id: true }
        });
        return found ? { countable: true } : NOT_COUNTABLE;
      }
      case "research": {
        const found = await prisma.researchArea.findFirst({
          where: { slug: second, ...liveStatusWhere() },
          select: { id: true }
        });
        return found ? { countable: true } : NOT_COUNTABLE;
      }
      default:
        return NOT_COUNTABLE;
    }
  }

  // Anything else must be a CMS page. `Page.slug` is the full path WITHOUT its leading slash, so
  // "/about/history" is the row "about/history".
  const page = await prisma.page.findFirst({
    where: { slug: path.slice(1), ...livePublishableWhere() },
    select: { id: true }
  });
  return page ? { countable: true } : NOT_COUNTABLE;
}

/**
 * Add one to today's bucket.
 *
 * `updateMany` first, then `create`, rather than `upsert`. The reason is a real trap: Postgres treats
 * NULLs as DISTINCT in a unique index, so the (day, path, NULL) rows that an unknown country produces
 * are not actually protected by `@@unique([day, path, country])` — an upsert's ON CONFLICT can never
 * match them. `updateMany` generates `country IS NULL` and therefore does find them.
 *
 * The residual race: two first-views of the same path in the same instant can both create a row. The
 * counts SUM correctly, so nothing is lost, and the analytics screen has to group by (day, path) and
 * sum over countries regardless — a path is visited from more than one country. The alternative, a
 * sentinel country string, would put a fabricated place into the data to satisfy an index.
 */
async function countView(path: string, country: string | null): Promise<void> {
  const day = utcDay(new Date());

  const updated = await prisma.pageViewDaily.updateMany({
    where: { day, path, country },
    data: { views: { increment: 1 } }
  });
  if (updated.count > 0) return;

  try {
    // `uniques` is left at its default of 0 — see the header. It is not written here and must not be
    // read as a visitor count.
    await prisma.pageViewDaily.create({ data: { day, path, country, views: 1 } });
  } catch {
    // Somebody else created the row between the update and the create. Add to theirs.
    await prisma.pageViewDaily.updateMany({
      where: { day, path, country },
      data: { views: { increment: 1 } }
    });
  }
}

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  // Heavier than it looks: one reader generates one beacon per article. The refusal is a real 429 with
  // a `Retry-After` rather than a silent 204 — the beacon ignores the response either way, so a 429
  // costs the reader nothing and it tells an operator watching the network tab the truth.
  const limited = enforceRateLimit(
    request,
    "views",
    RATE_LIMITS.views,
    (phrase) => `Too many view counts from this connection. The next one will be recorded in ${phrase}.`
  );
  if (limited) return limited;

  const body = await parseJson(request, ViewBody);

  // With analytics switched off, nothing is written at all — not the daily bucket and not the article's
  // own counter. 204 rather than an error: the switch is an administrator's decision, and the beacon
  // has nobody to report it to.
  const features = await getSetting("features");
  if (!features.analytics) return noContent();

  try {
    const resolution = await resolvePath(body.path);
    if (!resolution.countable) return noContent();

    await countView(body.path, readCountry(request));

    if (resolution.postId) {
      // Denormalised onto the article so "most read" needs no aggregation over the daily table. It can
      // drift from the sum of the buckets — a purge of old rows, a day the beacon was blocked — so it
      // is a popularity signal and not a total anybody should publish as one.
      await prisma.post.update({
        where: { id: resolution.postId },
        data: { viewCount: { increment: 1 } }
      });
    }
  } catch (error) {
    // Swallowed on purpose. A counter that fails must not turn a page that rendered into an error in
    // the reader's console, and the operator still finds out here.
    console.error("[views] could not record a page view for", body.path, error);
  }

  return noContent();
});
