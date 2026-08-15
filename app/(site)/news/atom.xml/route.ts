import {
  ATOM_CONTENT_TYPE,
  FEED_CACHE_CONTROL,
  readNewsFeedItems,
  renderAtomFeed
} from "@/lib/feed";

/**
 * /news/atom.xml — the newsroom as Atom 1.0.
 *
 * The twin of `../feed.xml/route.ts`, and deliberately identical to it apart from the renderer and the
 * media type: the same query, the same cap, the same caching contract. Everything that could differ
 * between the two formats — dates, identity, the required elements — is settled inside `lib/feed.ts`,
 * so neither route can drift from the other by editing an envelope.
 *
 * ⚠ `application/atom+xml`, NEVER `application/rss+xml`. They are different documents under different
 * specifications; a reader that trusts the header and gets the other grammar reports a broken feed
 * rather than falling back to sniffing. See the RSS route's header for why the charset is spelled out
 * and why this handler is `force-dynamic`; both reasons apply here unchanged.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  // One instant for the query and the document, for the reason spelled out in the RSS route.
  const now = new Date();
  const items = await readNewsFeedItems(now);

  return new Response(renderAtomFeed(items, now), {
    headers: {
      "Content-Type": ATOM_CONTENT_TYPE,
      "Cache-Control": FEED_CACHE_CONTROL
    }
  });
}
