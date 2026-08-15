import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/env";
import {
  NEWSLETTER_CONFIRM_PATH,
  NEWSLETTER_UNSUBSCRIBE_PATH
} from "@/lib/newsletter/paths";
import { getSetting } from "@/lib/settings/service";

/**
 * robots.txt.
 *
 * TWO INDEPENDENT SWITCHES, and they answer different questions:
 *
 *   1. `seo.robotsAllowIndexing` — an EDITOR's decision, flipped from the studio. A staging
 *      deployment, or a site being prepared before launch, turns it off and every crawler is told to
 *      stay away. Without a real switch here, the usual workaround is an environment variable nobody
 *      remembers to unset, and the site launches invisible.
 *   2. The hard-coded disallow list — a DEVELOPER's decision, and not negotiable from the CMS. The
 *      studio, the API and the search endpoint must never be crawled regardless of what anyone toggles.
 *      THREE DIFFERENT ARGUMENTS put a path on this list, and they are worth keeping apart, because
 *      which one applies is what decides where a tenth entry belongs:
 *
 *        (a) NOT PUBLIC CONTENT AT ALL — `/studio`, its second door `/console`, and `/api/`. There is
 *            no page behind any of them for a reader: the two studio doors answer with a sign-in
 *            screen, and the API exists for programs rather than readers.
 *        (b) AN UNBOUNDED URL SPACE — `/search?q=` generates an unbounded space of URLs that a crawler
 *            will happily explore forever, and none of it is original content.
 *        (c) THIS URL IS A CREDENTIAL — `/preview` and the two newsletter pages carry a TOKEN IN THE
 *            QUERY STRING. Here the objection is not that there is nothing to read behind them; there
 *            is. It is that the ADDRESS ITSELF is the secret.
 *
 *      Every entry below names which of the three it is there for.
 *
 *      ⚠ "IT IS AN ATTACK SURFACE" IS NOT A FOURTH ARGUMENT, although this clause once gave exactly that
 *      as the reason `/studio` is here — and then claimed every entry was annotated while five of the
 *      nine carried no comment at all. It cannot be an argument for this list: see the paragraph below.
 *      A crawler that means harm reads this file as a map of where to look, so nothing is ever kept out
 *      by being named in it. `/studio` is here under (a); it is the middleware that guards it.
 *
 * robots.txt is a REQUEST, not an access control. Nothing here is a substitute for the middleware
 * that actually guards `/studio`.
 */

/**
 * Refreshed hourly, for the same reason as the sitemap: the indexing switch is an editor's decision made
 * in the studio, and a robots.txt pinned at build time would ignore it until the next deploy.
 */
export const revalidate = 3600;

export default async function robots(): Promise<MetadataRoute.Robots> {
  /**
   * ⚠ GUARDED, BECAUSE THIS RUNS DURING `next build` TOO.
   *
   * `getSetting` already falls back to the schema defaults for a MISSING or INVALID settings row, but a
   * database that cannot be REACHED throws — and a throw here fails the whole build, exactly as it did
   * for sitemap.ts when this application was first built inside a container.
   *
   * Defaulting to "indexing allowed" is the considered direction rather than the convenient one. The two
   * ways to be wrong are not symmetrical: emitting `Disallow: /` on a transient blip would de-index a
   * live institutional site, which is slow and painful to recover, while briefly allowing a staging site
   * to be crawled is recoverable and staging normally has other protections in front of it. It also
   * matches what `getSetting` returns for a fresh installation with no settings row, so the unreachable
   * case behaves like the empty case rather than inventing a third answer.
   */
  const allowIndexing = await getSetting("seo")
    .then((seo) => seo.robotsAllowIndexing)
    .catch((error: unknown) => {
      console.error(
        "[robots] the settings could not be read, so indexing is being allowed — the safer of the two " +
          "wrong answers. This corrects itself at the next revalidation. " +
          `Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      return true;
    });

  if (!allowIndexing) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
      // No sitemap reference while indexing is off: pointing a crawler at a list of pages it has
      // just been told not to fetch is a mixed message some crawlers resolve the wrong way.
      host: siteUrl()
    };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          /*
           * (a) NOT PUBLIC CONTENT. The CMS and its second door: `/console` is not a duplicate route
           * tree but a redirect onto `/studio` (next.config.ts, contract §0), so a crawler told only
           * about `/studio` would walk in under the other name.
           *
           * `/studio` is additionally sent `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` by
           * next.config.ts and by middleware, so for that door this line is the EARLIER ask — a header
           * is only read once the page has already been fetched.
           *
           * ⚠ `/console` GETS NO SUCH HEADER, so for that door this line is not defence in depth — it is
           * the only ask there is. Verified on a running server: `/console` and `/console/pages` answer
           * a bare `307` carrying nothing but `location`. Both routes that could have added one miss it,
           * for different reasons: `next.config.ts`'s header rule for `/console/:path*` never fires
           * because the redirect short-circuits it, and `middleware.ts` never sees the path at all
           * because its `config.matcher` lists only studio and studio-API prefixes. That is not a hole
           * — nothing is SERVED at `/console`, only a redirect — but it is why this entry must not be
           * deleted as redundant with `/studio`.
           *
           * ⚠ THE TRAILING-SLASH TWINS ARE BELT AND BRACES, NOT A CONVENTION A NEW ENTRY MUST COPY. A
           * disallow is matched as a PREFIX (RFC 9309 §2.2.2), so bare `/studio` already covers
           * `/studio/`, `/studio/pages` and everything beneath it, and the second line adds nothing a
           * conforming crawler acts on. It costs one line and it survives a crawler that reads the bare
           * form as an exact path, so it stays — but `/api/` below has no bare twin and needs none.
           */
          "/studio",
          "/studio/",
          "/console",
          "/console/",
          /*
           * (a) NOT PUBLIC CONTENT — and the one entry whose trailing slash is load-bearing rather than
           * belt and braces. `/api` is not itself a route (it answers 404); every handler lives at least
           * one segment below it — `/api/auth`, `/api/cron`, `/api/public`, `/api/studio` — so the slash
           * here is the real shape of the tree, not a second spelling of the lines above.
           */
          "/api/",
          // (b) A search results page is an infinite URL space and none of it is original content.
          "/search",
          // (c) Preview links carry a token and render unpublished drafts.
          "/preview",
          /*
           * (c) THE TWO NEWSLETTER PAGES THAT CARRY A SIGNED TOKEN IN THE QUERY STRING — the same
           * argument as `/preview` immediately above, and sharper: an indexed unsubscribe URL is a
           * WORKING unsubscribe link for somebody else's address, sitting in a public search result.
           *
           * ⚠ DEFENCE IN DEPTH, NOT A LIVE HOLE, and it should not be described as one. Both pages
           * already send `noIndex` from their own metadata (`app/(site)/newsletter/confirm/page.tsx`,
           * `.../unsubscribe/page.tsx`, which each argue it at length), and neither mutates anything on
           * GET — the confirm and unsubscribe actions are POST handlers under `/api/public/newsletter`,
           * deliberately, because mail gateways fetch every link in every message. What this adds is the
           * one thing `noIndex` cannot: `noIndex` is only read AFTER the page has been fetched, so a
           * crawler still requests the URL and the token still travels. This asks it not to fetch at all.
           *
           * ⚠ `/newsletter` ITSELF IS DELIBERATELY ABSENT. It is an ordinary public page that carries no
           * token, it is the address a printed leaflet quotes, and it must stay findable — a prefix
           * disallow of `/newsletter` would take all three pages down with it. These two are written as
           * the full paths, and the imported constants are what keeps them the same two paths the pages
           * are actually served from.
           */
          NEWSLETTER_CONFIRM_PATH,
          NEWSLETTER_UNSUBSCRIBE_PATH
        ]
      }
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl()
  };
}
