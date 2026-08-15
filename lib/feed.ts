import "server-only";

import { ARTICLE_LIST_ORDER, articlePublishedOn } from "@/components/site/ArticleMeta";
import { livePublishableWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteName } from "@/lib/env";
import { publicObjectUrl } from "@/lib/media/url";
import { absoluteUrl } from "@/lib/seo";
import { truncateWords } from "@/lib/utils";

/**
 * Syndication for the newsroom — the RSS 2.0 document, the Atom 1.0 document, and the ONE query that
 * feeds both.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY BOTH FORMATS, AND WHY ONE FILE.
 *
 * A research centre publishes and people subscribe; the two formats exist because readers are split
 * between them and neither is going away. They are NOT interchangeable, and the differences are the
 * whole content of this file: RSS dates are RFC 822, Atom dates are RFC 3339; RSS has one `<link>`
 * element, Atom has typed `<link rel>` relations; Atom requires `<id>` and `<updated>` on the feed and
 * on every entry, RSS requires nothing of the sort. Getting one of those wrong does not make the feed
 * ugly — it makes it INVALID, and an invalid feed is silently dropped by the reader rather than
 * reported to us.
 *
 * They live in one module because they must answer identically: the same articles, in the same order,
 * with the same summaries. Two files drift, and the first symptom is a subscriber on one format
 * missing a piece the other format carried.
 *
 * NO DEPENDENCY. Escaping five characters correctly is the ten lines below and one fewer package in
 * the supply chain of a public institutional site.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ EVERY STRING THAT REACHES THE DOCUMENT GOES THROUGH `escapeXml`. An editor will eventually write
 * "Craft & Community", and a bare `&` makes the whole document not-well-formed — not the one headline.
 * That is the failure mode to fear here: XML parsers are not browsers, they do not recover, and the
 * reader shows the subscriber "this feed is broken" for every article, not just the offending one.
 *
 * ⚠ AN OMITTED REQUIRED ELEMENT FAILS EXACTLY AS LOUDLY AS A BARE AMPERSAND. Atom demands a `<title>`
 * on every entry and RSS demands a title or a description on every item, so "there was nothing worth
 * printing" is not an option a renderer has: a row whose title is whitespace, or nothing but characters
 * XML forbids, still has to be published under something. `itemTitle` and `xmlText` below are the whole
 * of that discipline — a value is judged by what will SURVIVE escaping, not by what arrived.
 *
 * ⚠ ABSOLUTE URLS THROUGHOUT, VIA `absoluteUrl()`. A feed is read off-site, inside somebody else's
 * application, where a relative path resolves against a host that is not ours. Same helper as the
 * sitemap and `lib/seo.ts`, so the canonical URL a crawler sees and the URL a subscriber clicks cannot
 * be built from two different ideas of the origin.
 */

/**
 * Where the two documents live. Exported so the newsroom page can advertise them (its `alternates`
 * and its visible link) without a second copy of the paths that would drift the day one is renamed.
 */
export const FEED_PATHS = { rss: "/news/feed.xml", atom: "/news/atom.xml" } as const;

/**
 * The media types, and the `Content-Type` headers built from them.
 *
 * Both are needed and they are not the same string: the header carries `charset=utf-8` (the documents
 * declare UTF-8 and a header that disagrees wins in most readers), while the `type` attribute of an
 * `<atom:link>` or a `<link rel="self">` is the bare media type — a charset there is not part of the
 * grammar and some validators flag it.
 */
export const RSS_MEDIA_TYPE = "application/rss+xml";
export const ATOM_MEDIA_TYPE = "application/atom+xml";
export const RSS_CONTENT_TYPE = `${RSS_MEDIA_TYPE}; charset=utf-8`;
export const ATOM_CONTENT_TYPE = `${ATOM_MEDIA_TYPE}; charset=utf-8`;

/**
 * The caching contract for both routes.
 *
 * `s-maxage=300` matches the newsroom page's own `revalidate = 300`, on purpose: a feed that mirrors a
 * page must not lag it, or a subscriber is told about an article minutes after a visitor could already
 * read it — and the reverse (a feed fresher than the page it links to) hands the reader a 404.
 * `max-age=0` keeps the reader's PRIVATE cache out of it, because a feed reader polling every fifteen
 * minutes should get the shared cache's answer rather than its own stale copy.
 * `stale-while-revalidate=3600` means a poll that lands during a refresh is answered instantly from
 * the last good document rather than waiting on the database.
 */
export const FEED_CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";

/**
 * How many articles a feed carries.
 *
 * FIFTY, and the number is a judgement rather than a round figure: the Centre publishes on the order
 * of one piece a week, so fifty is about a year of the newsroom. A subscriber whose reader was offline
 * for a holiday, or who subscribed today and wants some history, gets everything; nobody is expected
 * to poll a feed for an archive, which is what `/news` is for and what both documents link to.
 *
 * It also bounds the response. Unbounded, this grows silently with the newsroom until a reader that
 * polls every quarter of an hour is downloading a megabyte of XML to learn nothing has changed.
 *
 * ⚠ THE CAP IS STATED WHERE IT CAN BE READ (contract §1.6): in each document's description/subtitle,
 * alongside a link to the full archive, and in the "Follow the newsroom" block on `/news`. A feed that
 * quietly stops at fifty is indistinguishable from a newsroom that has only ever published fifty.
 */
export const FEED_ITEM_LIMIT = 50;

/** The Centre writes in British English and the documents say so, once, at the top. */
const FEED_LANGUAGE = "en-GB";

/**
 * How much of an excerpt travels into the feed.
 *
 * A feed item is a summary that links to the article, not the article: the Centre's pages carry the
 * images, the byline and the reading time. 400 characters is two or three sentences, which is enough
 * for a subscriber to decide, and it stops one editor's 4,000-character "excerpt" from inflating every
 * poll of the document.
 */
const SUMMARY_CHARS = 400;

// ─────────────────────────────────────────────────────────────────────────────
// Escaping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop the characters XML 1.0 does not permit AT ALL — not raw, and not as a numeric character
 * reference, so escaping cannot rescue them.
 *
 * ⚠ THIS IS NOT FUSSINESS, IT IS THE OTHER HALF OF WELL-FORMEDNESS. Control characters arrive in real
 * content: a paste out of a PDF or a Word document brings U+0001 and friends with it, they are
 * invisible in the studio editor, and one of them makes the whole document unparseable exactly as a
 * bare ampersand does.
 *
 * Written as the specification's `Char` production rather than as a regular expression, because the
 * production is stated in code points and iterating a string by code point is the only way to say so:
 * tab, newline and carriage return, then U+0020–U+D7FF, then U+E000–U+FFFD, then everything above the
 * BMP. Reading it that way also excludes a LONE SURROGATE — half of an emoji left behind by somebody
 * else's substring — which is illegal in XML too and which a code-unit regex cannot see.
 */
function stripInvalidXmlChars(value: string): string {
  let out = "";
  // `for…of` iterates by code point, so an astral character arrives whole and a lone surrogate arrives
  // alone — which is what makes the D800–DFFF range below reachable at all.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const permitted =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000;
    if (permitted) out += character;
  }
  return out;
}

/**
 * A value as it will ACTUALLY appear in the document: the forbidden characters gone, then trimmed.
 *
 * ⚠ THE ORDER IS THE POINT, AND IT IS WHY THIS IS NOT A BARE `.trim()`. A value that is nothing but
 * characters XML rejects — the U+0001 padding a paste out of a PDF carries, invisible in the studio
 * editor — is non-empty to `trim()` and empty by the time `escapeXml` has finished with it. Anything
 * deciding "does this element have content?" from the raw input therefore emits
 * `<description></description>`, which is the single thing `element()` exists to prevent.
 *
 * Everything that asks whether a string is worth printing asks this function, so there is one answer.
 */
function xmlText(value: string | null | undefined): string {
  return value ? stripInvalidXmlChars(value).trim() : "";
}

/**
 * Everything that reaches the document, in text or in an attribute.
 *
 * ⚠ THE AMPERSAND IS REPLACED FIRST AND THAT ORDER IS LOAD-BEARING. Escape `<` first and the `&` it
 * introduces is escaped again by the next pass, so "a < b" ships as "a &amp;lt; b" and the reader
 * prints the entity instead of the character.
 *
 * All five characters are escaped in both positions rather than two functions, one for text and one
 * for attributes. `>` is not strictly required in text — until it lands after `]]`, which closes a
 * CDATA section that is not there — and the quotes matter only inside attributes; escaping all five
 * everywhere means there is no way to reach for the wrong one.
 */
export function escapeXml(value: string): string {
  return stripInvalidXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates — two formats, and they are not the same format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RSS 2.0 wants RFC 822: `Sat, 07 Sep 2002 00:00:01 GMT`.
 *
 * `toUTCString()` is not a locale-dependent convenience — ECMAScript DEFINES its output as exactly
 * that grammar, with English day and month abbreviations and a literal `GMT`, on every engine and
 * under every locale. Hand-rolling the same string from two lookup arrays would be twelve more lines
 * and one more place to mistype "Setpember".
 */
function rfc822(date: Date): string {
  return date.toUTCString();
}

/**
 * Atom 1.0 wants RFC 3339: `2002-09-07T00:00:01.000Z`.
 *
 * ⚠ NOT INTERCHANGEABLE WITH THE ABOVE. An RFC 822 date in an `<updated>` element does not degrade
 * gracefully: the entry is rejected, and a reader that rejects entries shows the subscriber an empty
 * feed rather than an error. `toISOString()` is UTC by definition, and the fractional seconds and the
 * `Z` designator are both permitted by RFC 3339.
 */
function rfc3339(date: Date): string {
  return date.toISOString();
}

/** A date only when it is one. A malformed column would otherwise emit "Invalid Date" into the XML. */
function usableDate(value: Date | null | undefined): Date | null {
  if (!value) return null;
  return Number.isNaN(value.getTime()) ? null : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// The items
// ─────────────────────────────────────────────────────────────────────────────

/** A cover image, as an attachment. See `coverEnclosure` for why the byte count travels with it. */
export interface FeedEnclosure {
  url: string;
  /** The media type of the bytes at `url` — the variant's format, not the original's, when they differ. */
  type: string;
  /** Bytes. Required by RSS; the attribute is `length` in both formats. */
  length: number;
}

export interface FeedItem {
  title: string;
  /** Absolute. What the subscriber clicks, and what identifies the item — see `readNewsFeedItems`. */
  url: string;
  summary: string | null;
  /** When it became public. Null when neither date column has been stamped. */
  published: Date | null;
  /** When the row last changed. Always present — it is what the feed's own `updated` is taken from. */
  updated: Date;
  author: string | null;
  category: { slug: string; name: string } | null;
  enclosure: FeedEnclosure | null;
}

/** The formats the derivative pipeline writes, mapped to what a feed reader must be told they are. */
const VARIANT_MIME: Record<string, string> = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg"
};

interface FeedCover {
  objectKey: string;
  mimeType: string;
  byteSize: number;
  variants: { label: string; format: string; objectKey: string; byteSize: number }[];
}

/**
 * The cover as an enclosure, or nothing.
 *
 * ⚠ `mediaSrc()` AND `pickVariant()` ARE DELIBERATELY NOT USED HERE. They answer "which key should be
 * served" without answering "how many bytes is it", and an enclosure's `length` must describe the
 * bytes at that exact URL — a wrong length is worse than no enclosure, because a reader that trusts it
 * truncates the image and one that checks it rejects the item. So the chosen key and its own
 * `byteSize` are read off the SAME row and travel together.
 *
 * The `og` variant is preferred because it is the one fixed size in the pipeline (1200×630) and is
 * exactly the shape a reader renders above an item. WebP before AVIF: both are variants of the same
 * picture, and AVIF is still the one some readers cannot decode.
 *
 * Nothing is emitted when no CDN is configured — `publicObjectUrl` returns null rather than guessing a
 * base, and a feed is the last place to publish a URL that resolves nowhere.
 */
function coverEnclosure(cover: FeedCover | null): FeedEnclosure | null {
  if (!cover) return null;

  const og =
    cover.variants.find((variant) => variant.label === "og" && variant.format === "webp") ??
    cover.variants.find((variant) => variant.label === "og" && VARIANT_MIME[variant.format]);

  const chosen = og
    ? { objectKey: og.objectKey, byteSize: og.byteSize, type: VARIANT_MIME[og.format] }
    : { objectKey: cover.objectKey, byteSize: cover.byteSize, type: cover.mimeType.trim() };

  const url = publicObjectUrl(chosen.objectKey);
  if (!url || !chosen.type || chosen.byteSize <= 0) return null;

  return { url, type: chosen.type, length: chosen.byteSize };
}

/**
 * The articles both feeds carry.
 *
 * ⚠ THE PUBLICATION FILTER IS `livePublishableWhere()`, THE SAME ONE `/news` USES, and it is passed as
 * the whole `where` rather than spread into a larger object. That helper already carries a top-level
 * `OR` (the PUBLISHED/SCHEDULED pair); a second `OR` spread beside it silently REPLACES the
 * publication filter, which is how drafts and embargoed pieces reach the public. If a clause is ever
 * added here it must be `{ AND: [livePublishableWhere(now), …] }` — see the same warning over
 * `newsWhere()` in app/(site)/news/page.tsx.
 *
 * `seoNoIndex` IS DELIBERATELY NOT FILTERED, even though `app/sitemap.ts` filters it. The two surfaces
 * answer different questions: a sitemap advertises URLs to crawlers, so listing one that asks not to be
 * indexed is a contradiction — whereas a feed serves a reader who asked to be told what the newsroom
 * publishes. `/news` lists those articles, so the feed lists them too; a feed that quietly omits what
 * the page shows is the same defect as a list that quietly stops.
 *
 * ONE `now` for the query, passed in by the caller where it has one, so a route that reads anything
 * else cannot answer to two different instants.
 */
export async function readNewsFeedItems(now: Date = new Date()): Promise<FeedItem[]> {
  const rows = await prisma.post.findMany({
    where: livePublishableWhere(now),
    // The newsroom's own order, imported rather than restated. Its `nulls: "last"` is the load-bearing
    // part: without it a piece live on `publishAt` but not yet stamped `publishedAt` sorts to the TOP
    // in Postgres, and the feed's "newest first" would disagree with the page's.
    //
    // ⚠ A lib module importing from components/ inverts the usual direction. It is deliberate and it is
    // narrow: only the ORDER and the date resolver come across, never `articleCardSelect`, which drags
    // every article's Tiptap body along for a reading time no feed renders.
    orderBy: ARTICLE_LIST_ORDER,
    take: FEED_ITEM_LIMIT,
    select: {
      slug: true,
      title: true,
      subtitle: true,
      excerpt: true,
      publishedAt: true,
      publishAt: true,
      updatedAt: true,
      author: { select: { name: true } },
      category: { select: { slug: true, name: true } },
      cover: {
        select: {
          objectKey: true,
          mimeType: true,
          byteSize: true,
          variants: { select: { label: true, format: true, objectKey: true, byteSize: true } }
        }
      }
    }
  });

  return rows.map((row) => {
    const summary = (row.excerpt ?? row.subtitle ?? "").replace(/\s+/g, " ").trim();
    const author = row.author?.name.trim();

    return {
      // Whitespace collapsed as the summary's is — a stray newline out of a pasted headline is legal
      // XML and still renders as a broken item — but NOT defaulted here: the placeholder for a row
      // with no usable title belongs to the renderers, which are the things that must not emit an
      // empty required element. See `itemTitle`.
      title: row.title.replace(/\s+/g, " ").trim(),
      url: absoluteUrl(`/news/${row.slug}`),
      summary: summary.length > 0 ? truncateWords(summary, SUMMARY_CHARS) : null,
      published: usableDate(articlePublishedOn(row)),
      // `updatedAt` is `@updatedAt` and cannot be null; the guard is for a malformed value, and `now`
      // is the honest fallback for "we cannot say when this changed".
      updated: usableDate(row.updatedAt) ?? now,
      author: author && author.length > 0 ? author : null,
      category: row.category,
      enclosure: coverEnclosure(row.cover)
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const XML_DECLARATION = '<?xml version="1.0" encoding="utf-8"?>';

/**
 * An element, or nothing at all.
 *
 * AN EMPTY ELEMENT IS NOT THE SAME AS AN ABSENT ONE. `<description></description>` tells a reader the
 * article has a summary and that it is blank, and several readers render that as an empty grey block
 * where the excerpt should be.
 *
 * ⚠ ONLY FOR ELEMENTS THAT ARE GENUINELY OPTIONAL. This helper's whole behaviour is to disappear, so
 * a REQUIRED element must never be handed a value that might vanish — see `itemTitle` for the title,
 * and the Atom entry author, which resolves its name before it opens the wrapper.
 */
function element(name: string, value: string | null | undefined, indent: string): string[] {
  const text = xmlText(value);
  if (!text) return [];
  return [`${indent}<${name}>${escapeXml(text)}</${name}>`];
}

/**
 * The title an item is published under. NEVER EMPTY, which is the reason it exists.
 *
 * ⚠ BOTH FORMATS REQUIRE THIS ELEMENT AND `element()` WOULD SILENTLY DROP IT. A row whose title
 * survives escaping as nothing — whitespace only, or control characters only — would produce an RSS
 * `<item>` carrying neither a title nor (when the excerpt is also empty) a description, which RSS 2.0
 * forbids, and an Atom `<entry>` with no `<title>` at all, which RFC 4287 forbids outright. That is not
 * one odd-looking item: the document stops being valid Atom, and a reader that rejects a document shows
 * its subscriber an empty feed rather than an error, so ONE untitled row silences the whole newsroom.
 *
 * So the renderers substitute a visible placeholder instead of omitting the element. The subscriber
 * gets one strangely-named item they can still click through, an editor reading their own feed sees the
 * word and fixes the row, and the other forty-nine articles keep arriving.
 */
function itemTitle(title: string): string {
  return xmlText(title) || "Untitled article";
}

/** `Centre of Excellence — News`. Read at CALL time: `siteName()` must not run at module scope. */
function feedTitle(): string {
  return `${siteName()} — News`;
}

/**
 * The channel description and the Atom subtitle — the same sentence, because they are the same claim.
 *
 * It states the cap and links to the archive (contract §1.6). Worded as "up to", so it is true of a
 * newsroom holding six articles as well as one holding six hundred, and it needs no count query to
 * stay honest.
 */
function feedSummary(): string {
  return (
    "Research findings, appointments, fieldwork notes and announcements from the Centre, newest " +
    `first. This feed carries up to the ${FEED_ITEM_LIMIT} most recent articles; everything older is ` +
    `in the archive at ${absoluteUrl("/news")}.`
  );
}

/**
 * When the feed itself last changed: the newest `updated` among its items.
 *
 * ⚠ NOT `new Date()`. A document that reports "now" as its build time on every fetch tells every
 * subscriber it changed on every poll — the same defect the sitemap's `lastModified` avoids, and it
 * teaches a reader to ignore the field and re-download everything. `now` is used only for an EMPTY
 * newsroom, where there is no item date to take and Atom still requires the element.
 */
function feedUpdatedAt(items: readonly FeedItem[], now: Date): Date {
  let newest: Date | null = null;
  for (const item of items) {
    if (!newest || item.updated.getTime() > newest.getTime()) newest = item.updated;
  }
  return newest ?? now;
}

/**
 * RSS 2.0.
 *
 * `<atom:link rel="self">` is the one borrowed element, and it is not decoration: it is how a reader
 * that has been handed the document (through a proxy, a copied file, an aggregator) learns the URL to
 * poll. Every feed validator warns about its absence.
 *
 * `<dc:creator>` carries the byline because RSS's own `<author>` element is specified to hold an EMAIL
 * ADDRESS. Putting a person's name there is the common mistake, and the polite readers render
 * "Anita Rao" as a broken mailto while the strict ones flag the item as invalid. The Centre does not
 * publish its researchers' addresses, so the Dublin Core element — which asks for a name — is the
 * correct one.
 */
export function renderRssFeed(items: readonly FeedItem[], now: Date = new Date()): string {
  const archive = absoluteUrl("/news");
  const self = absoluteUrl(FEED_PATHS.rss);

  const lines: string[] = [
    XML_DECLARATION,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">`,
    "  <channel>",
    ...element("title", feedTitle(), "    "),
    ...element("link", archive, "    "),
    ...element("description", feedSummary(), "    "),
    ...element("language", FEED_LANGUAGE, "    "),
    ...element("lastBuildDate", rfc822(feedUpdatedAt(items, now)), "    "),
    `    <atom:link href="${escapeXml(self)}" rel="self" type="${RSS_MEDIA_TYPE}"/>`
  ];

  for (const item of items) {
    lines.push("    <item>");
    // Through `itemTitle`, never `item.title`: RSS requires a title or a description on every item and
    // an untitled row with an empty excerpt would otherwise have neither.
    lines.push(...element("title", itemTitle(item.title), "      "));
    lines.push(...element("link", item.url, "      "));
    /**
     * The permalink is the identity, and `isPermaLink="true"` says so.
     *
     * ⚠ A SLUG CHANGE THEREFORE READS AS A NEW ARTICLE and reappears unread in every subscriber's
     * list. That is the accepted cost of the convention every reader already de-duplicates on: if the
     * slug changes, the article's URL changes, every existing link to it breaks, and it genuinely IS a
     * new address on the web. An opaque id would hide that from the feed while leaving it true
     * everywhere else.
     */
    lines.push(`      <guid isPermaLink="true">${escapeXml(item.url)}</guid>`);
    if (item.published) lines.push(...element("pubDate", rfc822(item.published), "      "));
    lines.push(...element("dc:creator", item.author, "      "));
    lines.push(...element("category", item.category?.name, "      "));
    lines.push(...element("description", item.summary, "      "));
    if (item.enclosure) {
      lines.push(
        `      <enclosure url="${escapeXml(item.enclosure.url)}" type="${escapeXml(
          item.enclosure.type
        )}" length="${item.enclosure.length}"/>`
      );
    }
    lines.push("    </item>");
  }

  lines.push("  </channel>", "</rss>", "");
  return lines.join("\n");
}

/**
 * Atom 1.0.
 *
 * THE FEED-LEVEL `<author>` IS NOT OPTIONAL HERE. RFC 4287 requires an author on every entry unless
 * the feed carries one, and `Post.author` is nullable — so an article saved without an author would
 * invalidate the document. The Centre is named once at the top and every entry that knows its byline
 * overrides it; the rest inherit, which is exactly what inheritance is in the specification for.
 *
 * The feed's `<id>` is the feed's own URL: an IRI that must be unique and must never change. The
 * document lives at that address for as long as the site does.
 */
export function renderAtomFeed(items: readonly FeedItem[], now: Date = new Date()): string {
  const archive = absoluteUrl("/news");
  const self = absoluteUrl(FEED_PATHS.atom);

  const lines: string[] = [
    XML_DECLARATION,
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${FEED_LANGUAGE}">`,
    ...element("id", self, "  "),
    ...element("title", feedTitle(), "  "),
    ...element("subtitle", feedSummary(), "  "),
    ...element("updated", rfc3339(feedUpdatedAt(items, now)), "  "),
    `  <link rel="self" type="${ATOM_MEDIA_TYPE}" href="${escapeXml(self)}"/>`,
    // The human page this document is a machine copy of. A reader shows it as "visit website", and it
    // is also where a subscriber goes for everything past the cap.
    `  <link rel="alternate" type="text/html" href="${escapeXml(archive)}"/>`,
    "  <author>",
    ...element("name", siteName(), "    "),
    ...element("uri", absoluteUrl("/"), "    "),
    "  </author>"
  ];

  for (const item of items) {
    lines.push("  <entry>");
    // Same identity as the RSS `<guid>`, for the same reasons and with the same accepted cost.
    lines.push(...element("id", item.url, "    "));
    // `<title>` is mandatory on an Atom entry, so it goes through `itemTitle` — an entry missing it
    // invalidates the whole document, not the entry.
    lines.push(...element("title", itemTitle(item.title), "    "));
    lines.push(`    <link rel="alternate" type="text/html" href="${escapeXml(item.url)}"/>`);
    lines.push(...element("updated", rfc3339(item.updated), "    "));
    if (item.published) lines.push(...element("published", rfc3339(item.published), "    "));
    /**
     * ⚠ THE NAME IS RESOLVED BEFORE THE WRAPPER IS OPENED. `atom:author` REQUIRES an `atom:name`, so
     * testing `item.author` and then letting `element()` decide about the child risks the one shape
     * that is worse than no byline: `<author></author>`, which invalidates the entry it was meant to
     * credit. Asking `xmlText` first means the wrapper only ever exists around a name that survived.
     */
    const authorName = xmlText(item.author);
    if (authorName) {
      lines.push("    <author>", `      <name>${escapeXml(authorName)}</name>`, "    </author>");
    }
    if (item.category) {
      // `term` is the required machine token and `label` the human one. The slug is the token because
      // it is what `/news/category/<slug>` is keyed on, so the two agree.
      lines.push(
        `    <category term="${escapeXml(item.category.slug)}" label="${escapeXml(
          item.category.name
        )}"/>`
      );
    }
    /**
     * `type="text"` is a promise that the content is NOT markup: a reader that trusted the default and
     * found a stray angle bracket would either drop the entry or render half a tag.
     *
     * ⚠ THE ATTRIBUTE IS WHY THIS CANNOT USE `element()`, AND WHY THE TEXT IS RESOLVED FIRST. Testing
     * `item.summary` would emit `<summary type="text"></summary>` for an excerpt that was only
     * characters XML forbids — the empty-grey-block-where-the-excerpt-should-be that `element()` is
     * built to avoid, reintroduced by the one element that could not use it.
     */
    const summary = xmlText(item.summary);
    if (summary) {
      lines.push(`    <summary type="text">${escapeXml(summary)}</summary>`);
    }
    if (item.enclosure) {
      lines.push(
        `    <link rel="enclosure" type="${escapeXml(item.enclosure.type)}" length="${
          item.enclosure.length
        }" href="${escapeXml(item.enclosure.url)}"/>`
      );
    }
    lines.push("  </entry>");
  }

  lines.push("</feed>", "");
  return lines.join("\n");
}
