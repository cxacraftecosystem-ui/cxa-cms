import { FEED_CACHE_CONTROL, RSS_CONTENT_TYPE, readNewsFeedItems, renderRssFeed } from "@/lib/feed";

/**
 * /news/feed.xml — the newsroom as RSS 2.0.
 *
 * A thin route handler on purpose: the document, the escaping, the date formats and the publication
 * filter all live in `lib/feed.ts`, beside the Atom renderer, because the two feeds must answer
 * identically and a difference between them would appear here first. All this file owns is the HTTP
 * envelope — the media type and the caching contract.
 *
 * ⚠ `Content-Type` CARRIES `charset=utf-8` AND THAT IS NOT REDUNDANT. The document's own XML
 * declaration says UTF-8, but a `Content-Type` header without a charset lets a reader fall back to its
 * own default, and the header wins over the declaration where they disagree. The symptom is a feed in
 * which every em dash and every Devanagari place name is mojibake, on some readers only.
 *
 * ⚠ `dynamic = "force-dynamic"` IS DELIBERATE, AND THE REASON IS A BUILD FAILURE, NOT A STALE PAGE.
 * A route handler that Next decides to evaluate at build time reads the database during `next build`,
 * and an unreachable database at that moment does not produce an empty feed — it fails the whole
 * deploy, which is exactly what happened to `app/sitemap.ts` the first time this application was built
 * inside a container. Rendering per request also keeps the honest failure honest: a database that
 * cannot be read AT REQUEST TIME is a 500 and a loud log, never a silently empty feed telling every
 * subscriber the Centre has published nothing (lib/prerender.ts makes this distinction in full).
 *
 * The cost is nothing: `FEED_CACHE_CONTROL` puts the shared cache in front of it, so the database is
 * read at most once every five minutes however many readers are polling.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // ONE instant for the request. `readNewsFeedItems` compares it against every embargo and
  // `renderRssFeed` falls back to it for `lastBuildDate` when the newsroom is empty; two separate
  // `new Date()` calls would let the document report a build time the query never saw.
  const now = new Date();
  const items = await readNewsFeedItems(now);

  return new Response(renderRssFeed(items, now), {
    headers: {
      "Content-Type": RSS_CONTENT_TYPE,
      "Cache-Control": FEED_CACHE_CONTROL
    }
  });
}
