import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/env";
import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
import type { FeatureFlag } from "@/lib/settings/schema";
import { getSetting } from "@/lib/settings/service";

/**
 * sitemap.xml.
 *
 * Everything a crawler should know about, with an honest `lastModified` taken from the row rather
 * than from "now" — a sitemap that claims every page changed today teaches a crawler to ignore the
 * field entirely.
 *
 * FIVE DECISIONS WORTH KNOWING:
 *
 *   1. **It reuses the SAME publish filters the pages use** (`livePublishableWhere` /
 *      `liveStatusWhere`). A sitemap built from its own idea of "published" is how an embargoed
 *      dataset gets announced to Google the day before its release.
 *   2. **It respects the editor's indexing switch**, and returns only the homepage when indexing is
 *      off. An empty sitemap is a malformed document; a one-entry sitemap is a valid statement.
 *   3. **Pages marked `seoNoIndex` are excluded — the code routes included.** A page carrying
 *      `noindex` in its metadata but listed in the sitemap is a contradiction, and the resolution is
 *      crawler-specific. `/`, `/about` and `/contact` are code routes whose metadata comes from a
 *      `Page` row, so the row's switch has to reach this file or those three URLs are advertised
 *      while asking not to be indexed.
 *   4. **It respects the feature flags, which are the pages' SECOND publish condition.**
 *      `features.craftExplorer`, `.gallery`, `.events` and `.publications` each make a listing and
 *      every one of its detail pages call `notFound()`. Listing a URL that answers 404 by
 *      configuration teaches Search Console to report a deliberate administrative decision as a
 *      broken deployment.
 *   5. **It is capped and the cap is enforced honestly.** The specification's limit is 50,000 URLs.
 *      If the Centre ever exceeds it this must become a sitemap index; the guard below makes that a
 *      loud server-log line rather than a silently truncated file.
 */

/**
 * Refreshed hourly rather than pinned at build time.
 *
 * A sitemap is a claim about what exists NOW. Generated once at build and never again, it stops
 * mentioning everything published since the last deploy — which on a site whose whole point is that
 * editors publish without a deploy is most of it.
 */
export const revalidate = 3600;

const SITEMAP_URL_LIMIT = 50_000;

type Entry = MetadataRoute.Sitemap[number];

/** One row of a listable collection: the two columns every sitemap entry is built from. */
type SlugRow = { slug: string; updatedAt: Date };

/**
 * Every database read this file makes, in one place so ONE guard can wrap all ten.
 *
 * Split out rather than inlined because of what a failure here costs: `sitemap.ts` is evaluated during
 * `next build`, so an unreachable database at that moment does not produce a smaller sitemap — it FAILS
 * THE WHOLE BUILD, and with it the deploy, for a reason that has nothing to do with the change being
 * deployed. That is not hypothetical; it is what happened the first time this application was built
 * inside a container, where by design no database is reachable:
 *
 *     Export encountered an error on /sitemap.xml/route: /sitemap.xml, exiting the build.
 *
 * `lib/prerender.ts` already makes this argument for `generateStaticParams`, but its guard cannot reach
 * here — this is a metadata route, not a page.
 */
async function readCollections(): Promise<{
  pages: SlugRow[];
  noIndexPages: { slug: string }[];
  people: SlugRow[];
  areas: SlugRow[];
  projects: SlugRow[];
  publications: SlugRow[];
  posts: SlugRow[];
  events: SlugRow[];
  crafts: SlugRow[];
  albums: SlugRow[];
}> {
  const select = { slug: true, updatedAt: true } as const;

  const [pages, noIndexPages, people, areas, projects, publications, posts, events, crafts, albums] =
    await Promise.all([
      prisma.page.findMany({ where: { ...livePublishableWhere(), seoNoIndex: false }, select }),
      /**
       * The other half of the same question, and the reason it has to be asked.
       *
       * `/`, `/about` and `/contact` are CODE routes that are listed unconditionally below, but their
       * metadata is rendered from a `Page` row — so an editor who ticks "hide from search engines"
       * makes those pages emit `noindex` while the loop below goes on advertising them. A row missing
       * from `pages` is not evidence of anything on its own (it may simply be a draft, in which case
       * the route renders its documented defaults and is genuinely indexable), so the suppression has
       * to be read positively: rows that are LIVE and marked `seoNoIndex`.
       */
      prisma.page.findMany({
        where: { ...livePublishableWhere(), seoNoIndex: true },
        select: { slug: true }
      }),
      prisma.person.findMany({ where: { ...liveStatusWhere(), isVisible: true }, select }),
      prisma.researchArea.findMany({ where: liveStatusWhere(), select }),
      prisma.project.findMany({ where: liveStatusWhere(), select }),
      prisma.publication.findMany({ where: liveStatusWhere(), select }),
      prisma.post.findMany({ where: { ...livePublishableWhere(), seoNoIndex: false }, select }),
      prisma.coeEvent.findMany({ where: liveStatusWhere(), select }),
      prisma.craft.findMany({ where: liveStatusWhere(), select }),
      prisma.galleryAlbum.findMany({ where: liveStatusWhere(), select })
    ]);

  return {
    pages,
    noIndexPages,
    people,
    areas,
    projects,
    publications,
    posts,
    events,
    crafts,
    albums
  };
}

/** What the sitemap falls back to when the database cannot be read. See `readCollections`. */
const NO_COLLECTIONS = {
  pages: [],
  noIndexPages: [],
  people: [],
  areas: [],
  projects: [],
  publications: [],
  posts: [],
  events: [],
  crafts: [],
  albums: []
} satisfies Awaited<ReturnType<typeof readCollections>>;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  /**
   * The indexing switch is read with the same tolerance, and for the same reason.
   *
   * `getSetting` already falls back to the schema defaults for a MISSING or INVALID row, but a database
   * that cannot be reached at all throws — and this line runs during the build too. Defaulting to
   * "allowed" matches what `getSetting` returns for a fresh installation with no settings row, so the
   * unreachable case behaves like the empty case rather than inventing a third answer.
   */
  const allowIndexing = await getSetting("seo")
    .then((seo) => seo.robotsAllowIndexing)
    .catch(() => true);

  /**
   * The feature flags, read with the same tolerance and resolved through one helper.
   *
   * A flag that is off makes its listing AND every one of its detail pages call `notFound()`, so it is
   * a publish condition exactly as much as `liveStatusWhere()` is — decision 4 in the header. An
   * unreachable database falls back to "on", which is what a fresh installation with no settings row
   * gets from the schema defaults; the alternative would drop four whole surfaces out of the sitemap
   * because a read failed.
   */
  const features = await getSetting("features").catch(() => null);
  const enabled = (flag: FeatureFlag): boolean => features?.[flag] ?? true;

  if (!allowIndexing) {
    // A one-entry sitemap is a valid statement; an empty document is a malformed one.
    return [{ url: base, lastModified: new Date(), changeFrequency: "monthly", priority: 1 }];
  }

  /**
   * The fallback is honest rather than empty. The listing pages below are CODE routes and are always
   * correct, so a sitemap that lists them and omits the records is a TRUE statement about part of the
   * site — and `revalidate` above replaces it with the complete one within the hour.
   */
  const {
    pages,
    noIndexPages,
    people,
    areas,
    projects,
    publications,
    posts,
    events,
    crafts,
    albums
  } = await readCollections().catch((error: unknown) => {
    console.error(
      "[sitemap] the database could not be read, so only the code routes are listed. This corrects " +
        "itself at the next revalidation. " +
        `Reason: ${error instanceof Error ? error.message : String(error)}`
    );
    return NO_COLLECTIONS;
  });

  const entries: Entry[] = [];

  /**
   * The listing pages. These are code routes, not `Page` rows, so they are listed explicitly — a sitemap
   * built only from the database would omit every index page on the site.
   *
   * `priority` is relative and only meaningful WITHIN this file. The homepage leads; the listings that
   * are the real entry points to the corpus come next.
   *
   * `flag` names the feature switch that 404s the route, where there is one. It is the second publish
   * condition these pages apply and the sitemap must apply it too (decision 4).
   */
  const staticRoutes: {
    path: string;
    priority: number;
    changeFrequency: Entry["changeFrequency"];
    flag?: FeatureFlag;
  }[] = [
    { path: "", priority: 1.0, changeFrequency: "weekly" },
    { path: "about", priority: 0.8, changeFrequency: "monthly" },
    { path: "research", priority: 0.9, changeFrequency: "weekly" },
    { path: "projects", priority: 0.9, changeFrequency: "weekly" },
    { path: "publications", priority: 0.9, changeFrequency: "weekly", flag: "publications" },
    { path: "people", priority: 0.8, changeFrequency: "weekly" },
    { path: "craft-explorer", priority: 0.9, changeFrequency: "weekly", flag: "craftExplorer" },
    { path: "gallery", priority: 0.7, changeFrequency: "weekly", flag: "gallery" },
    { path: "news", priority: 0.8, changeFrequency: "daily" },
    { path: "events", priority: 0.8, changeFrequency: "daily", flag: "events" },
    { path: "contact", priority: 0.6, changeFrequency: "yearly" },
    /*
     * The newsletter sign-up page. A real destination: it is the address a printed leaflet or an email
     * quotes, and somebody who wants to hear from the Centre searches for it by name.
     *
     * ⚠ PRIORITY 0.4, AND THE NUMBER IS ARGUED AGAINST THE LADDER BELOW RATHER THAN PICKED. It sits under
     * `a-z` (0.5) because that page is a way into the whole corpus and this one is a way into a single
     * form — it leads nowhere else on the site. It sits above `credits` and `accessibility` (0.3) because
     * those are obligations the site must carry and this is something a reader actively wants. Between
     * the two, so 0.4.
     *
     * `yearly`, with `contact`: what changes here is the consent wording, which changes when the consent
     * VERSION does and not otherwise.
     *
     * ⚠ NO `flag`. There is no `features.newsletter` — the flags are `craftExplorer`, `events`, `gallery`
     * and `publications` (lib/settings/schema.ts), so there is no switch that makes this route 404 and
     * inventing one here would hide the page for a condition that cannot arise.
     *
     * ⚠ `/newsletter/confirm` AND `/newsletter/unsubscribe` ARE DELIBERATELY ABSENT. Each is the outcome
     * of a POST, each carries a signed token in its query string, and each sends `noIndex` — advertising
     * them would contradict their own metadata and publish a credential. `app/robots.ts` disallows both
     * for the same reason.
     *
     * The path is written as a literal, without a leading slash, because that is this array's shape —
     * `route.path ? `${base}/${route.path}` : base` — and every sibling entry is a literal too.
     * `NEWSLETTER_PATH` in lib/newsletter/paths.ts is `/newsletter`, with the slash, so importing it here
     * would mean slicing a character off a shared constant to fit a local convention.
     */
    { path: "newsletter", priority: 0.4, changeFrequency: "yearly" },
    /*
     * The three reference pages. Low priority and rarely changing, but they belong here: each is a
     * real destination a reader may search for.
     *
     * ⚠ THIS NOTE USED TO ADD "and none of them is linked from every page", WHICH IS FALSE and
     * contradicted the `accessibility` bullet below, which says "rather than hunting the footer" —
     * describing the very footer link the clause denied existed. All three are in `REFERENCE_LINKS` in
     * `components/site/SiteFooter.tsx`, an unconditional `<nav aria-label="Reference">` rendered in the
     * footer of every public page precisely so an editor cannot tidy them away. Being linked from every
     * page was never the test anyway — `/`, `/about` and `/news` are in the header or footer of every
     * page and are listed here too. The test is whether the URL is a real, indexable destination.
     *
     *   • `a-z` is the index of everything, and is the page a researcher who knows a name but not
     *     where it lives actually wants. It changes whenever any record does, hence "weekly".
     *   • `credits` carries the photography attribution that the Creative Commons licences on the
     *     bundled imagery require. It changes only when the picture set does.
     *   • `accessibility` is the statement. A reader looking for it usually searches rather than
     *     hunting the footer, so it must be findable.
     *
     * ⚠ NO `flag` ON ANY OF THEM, deliberately. They are not feature-gated surfaces — `a-z` degrades
     * to a shorter list when a feature is switched off rather than 404ing, and the other two hold no
     * records at all. Giving them a flag would hide a licence obligation behind a toggle.
     */
    { path: "a-z", priority: 0.5, changeFrequency: "weekly" },
    { path: "credits", priority: 0.3, changeFrequency: "yearly" },
    { path: "accessibility", priority: 0.3, changeFrequency: "yearly" }
  ];

  // A `Page` row can OWN one of these paths (an editor built /about in the page builder). Where it does,
  // the row's real `updatedAt` is used and the static entry is dropped — two entries for one URL is a
  // duplicate a crawler reports as an error.
  const pageBySlug = new Map(pages.map((page) => [page.slug, page]));

  // The code routes an editor has marked "hide from search engines" on the `Page` row behind them. See
  // `readCollections` for why this is read positively rather than inferred from an absence.
  const noIndexed = new Set(noIndexPages.map((page) => page.slug));

  for (const route of staticRoutes) {
    // Two conditions the page itself applies, applied here as well: a URL that answers 404 because a
    // flag is off, or that asks not to be indexed, has no business being advertised.
    if (route.flag && !enabled(route.flag)) continue;
    if (noIndexed.has(route.path)) continue;

    const owned = pageBySlug.get(route.path);
    entries.push({
      url: route.path ? `${base}/${route.path}` : base,
      lastModified: owned?.updatedAt ?? new Date(),
      changeFrequency: route.changeFrequency,
      priority: route.priority
    });
  }

  const staticPaths = new Set(staticRoutes.map((route) => route.path));

  for (const page of pages) {
    // Handled by the loop above, which used this row's own timestamp — or deliberately dropped it
    // because the flag gating that route is off. Either way it must not be emitted a second time.
    if (staticPaths.has(page.slug)) continue;
    entries.push({
      url: page.slug ? `${base}/${page.slug}` : base,
      lastModified: page.updatedAt,
      changeFrequency: "monthly",
      priority: 0.7
    });
  }

  // `flag`, again: a switched-off surface takes its detail pages down with its listing, so every album
  // or craft URL below would answer 404 too.
  const collections: {
    rows: SlugRow[];
    prefix: string;
    priority: number;
    flag?: FeatureFlag;
  }[] = [
    { rows: areas, prefix: "research", priority: 0.8 },
    { rows: projects, prefix: "projects", priority: 0.8 },
    { rows: publications, prefix: "publications", priority: 0.7, flag: "publications" },
    { rows: people, prefix: "people", priority: 0.6 },
    { rows: posts, prefix: "news", priority: 0.7 },
    { rows: events, prefix: "events", priority: 0.6, flag: "events" },
    { rows: crafts, prefix: "craft-explorer", priority: 0.8, flag: "craftExplorer" },
    { rows: albums, prefix: "gallery", priority: 0.6, flag: "gallery" }
  ];

  for (const collection of collections) {
    if (collection.flag && !enabled(collection.flag)) continue;

    for (const row of collection.rows) {
      entries.push({
        url: `${base}/${collection.prefix}/${row.slug}`,
        lastModified: row.updatedAt,
        changeFrequency: "monthly",
        priority: collection.priority
      });
    }
  }

  if (entries.length > SITEMAP_URL_LIMIT) {
    // Loud, not silent. A truncated sitemap that says nothing looks exactly like a complete one.
    console.error(
      `[sitemap] ${entries.length} URLs exceeds the ${SITEMAP_URL_LIMIT} limit — the file is being ` +
        "truncated and this must be split into a sitemap index."
    );
    return entries.slice(0, SITEMAP_URL_LIMIT);
  }

  return entries;
}
