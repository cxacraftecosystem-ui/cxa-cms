/**
 * /news — the newsroom.
 *
 * A featured lead, then a grid, filtered by category and tag, paginated.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE FILTERS ARE QUERY PARAMETERS AND THE ARCHIVES ARE REAL PAGES. Both exist, on purpose:
 *
 *   • `/news?category=research&tag=textiles` is a VIEW — something a reader assembled while browsing.
 *     It is not linked to from anywhere and it is not a destination.
 *   • `/news/category/research` and `/news/tag/textiles` are PAGES — what gets linked to from an
 *     article, from a newsletter, from another site. They have their own titles and their own canonical
 *     URLs.
 *
 * `generateMetadata` below resolves the two into one answer, because a filtered listing that is
 * indexed separately from the page that already exists for it competes with its own parent. A single
 * category or a single tag CANONICALISES to the archive page for it; any other combination is
 * `noIndex`, because there is no page for it to be the copy of.
 *
 * THERE IS NO SEARCH BOX HERE. Prose search across the whole site lives at /search, backed by the
 * `SearchDocument` index (lib/search/*). A second, weaker `title contains` search on this page would
 * find different things from the site's real search for the same words, and a reader cannot be expected
 * to know which one they are using.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A SERVER COMPONENT that reads Prisma directly (contract §9). `FilterBar` is the only client piece,
 * and it carries its own Suspense boundary — so the list beside it is server-rendered from
 * `searchParams` and is fully present for a reader with no JavaScript, who simply cannot change it.
 */

import type { Metadata } from "next";
import type { Prisma } from "@prisma/client";
import { Newspaper, Rss, SearchX } from "lucide-react";

import { Reveal } from "@/components/motion";
import {
  ARTICLE_LIST_ORDER,
  ArticleCard,
  articleCardSelect
} from "@/components/site/ArticleMeta";
import { CardGrid } from "@/components/site/CardGrid";
import { FilterBar, type FilterGroup } from "@/components/site/FilterBar";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { buttonClasses, LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { livePublishableWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import {
  ATOM_MEDIA_TYPE,
  FEED_ITEM_LIMIT,
  FEED_PATHS,
  RSS_MEDIA_TYPE
} from "@/lib/feed";
import { absoluteUrl, pageMetadata } from "@/lib/seo";
import { prerenderSafe } from "@/lib/prerender";

/** Twelve fills a three-column grid four rows deep, which is as far as anyone scrolls a listing. */
const PAGE_SIZE = 12;

const NOUN = { singular: "article", plural: "articles" } as const;

const DESCRIPTION =
  "Research findings, appointments, fieldwork notes and announcements from the Centre, newest first.";

type SearchParams = Record<string, string | string[] | undefined>;

/** The first value of a parameter. A repeated single-value parameter is a stale or hand-edited link. */
function one(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

/** Every value of a repeated parameter, empties dropped. `?tag=a&tag=b` → ["a", "b"]. */
function many(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((entry) => entry.length > 0);
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

/** 1-based, and never below 1. A junk `?page=abc` is page one rather than an error page. */
function pageFrom(value: string | string[] | undefined): number {
  const raw = one(value);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 1 ? Math.floor(parsed) : 1;
}

interface Filters {
  category: string | null;
  tags: string[];
}

function readFilters(params: SearchParams): Filters {
  return { category: one(params.category), tags: many(params.tag) };
}

/**
 * The `where` for the listing.
 *
 * ⚠ COMPOSED WITH `AND`, NOT BY SPREADING. `livePublishableWhere()` returns an object that already
 * carries a top-level `OR` (the PUBLISHED/SCHEDULED pair). Spreading a second `OR` beside it would
 * silently REPLACE the publication filter and put drafts on the public site — the one mistake this
 * whole listing must not make.
 */
function newsWhere(filters: Filters, now: Date, excludeId: string | null): Prisma.PostWhereInput {
  const clauses: Prisma.PostWhereInput[] = [livePublishableWhere(now)];

  // The featured lead is pinned above the archive, so it is taken OUT of the paged list — on every page,
  // not only on the first. Excluding it on page one alone would shift the window by one row and the same
  // article would reappear halfway down page two.
  if (excludeId) clauses.push({ id: { not: excludeId } });

  if (filters.category) clauses.push({ category: { slug: filters.category } });

  // ANY of the chosen tags, not all of them. A reader ticking two tags is widening the net; an
  // intersection would return nothing for most pairs and look like a broken filter.
  if (filters.tags.length > 0) {
    clauses.push({ tags: { some: { tag: { slug: { in: filters.tags } } } } });
  }

  return { AND: clauses };
}

/** The listing path carrying the current filters, for `Pagination` to hang `?page=` off. */
function listHref(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  for (const tag of filters.tags) params.append("tag", tag);
  const query = params.toString();
  return query.length > 0 ? `/news?${query}` : "/news";
}

export async function generateMetadata({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const params = await searchParams;
  const filters = readFilters(params);
  const page = pageFrom(params.page);

  const onlyCategory = filters.category !== null && filters.tags.length === 0;
  const onlyTag = filters.category === null && filters.tags.length === 1 && filters.tags[0];
  const filtered = filters.category !== null || filters.tags.length > 0;

  // A single-facet view already has a page of its own; it canonicalises there rather than competing
  // with it. Page 2 of such a view is not the same document as page 1 of the archive, so the
  // canonical only collapses on the first page.
  const canonicalOverride =
    page === 1 && onlyCategory && filters.category
      ? absoluteUrl(`/news/category/${filters.category}`)
      : page === 1 && onlyTag
        ? absoluteUrl(`/news/tag/${onlyTag}`)
        : undefined;

  const metadata = pageMetadata({
    title: page > 1 ? `News — page ${page}` : "News",
    description: DESCRIPTION,
    // `?page=` stays in the canonical: page 3 is a different document from page 1, and collapsing the
    // two tells a crawler that every article on page 3 does not exist.
    path: page > 1 ? `/news?page=${page}` : "/news",
    ...(canonicalOverride ? { canonicalOverride } : {}),
    // A hand-assembled combination of facets has no page to be the canonical copy OF, so it is kept
    // out of the index entirely rather than pointed at a URL that does not represent it.
    noIndex: filtered && canonicalOverride === undefined,
    keywords: ["news", "announcements", "research updates"]
  });

  /**
   * Feed discovery — the `<link rel="alternate">` pair a browser's reader extension and every feed
   * client look for before they will offer to subscribe.
   *
   * ⚠ MERGED ONTO `alternates`, NEVER WRITTEN BESIDE IT. `pageMetadata` has just computed the
   * canonical this file's whole header is about; an `alternates: { types: … }` property in the object
   * literal above would REPLACE that object and take the canonical with it — silently, because a
   * metadata URL is never requested by the application itself, only by somebody else's crawler.
   *
   * The URLs are absolute for the same reason the canonical is: a feed reader resolves them from
   * wherever the document was fetched, which is not always this origin.
   *
   * EVERY VIEW OF THE NEWSROOM ADVERTISES THE SAME TWO FEEDS, including a filtered or paged one. The
   * feeds are the newsroom's, not this view's — there is no `?category=` feed to point at, and
   * offering one that ignored the filter would be worse than offering the whole newsroom plainly.
   */
  return {
    ...metadata,
    alternates: {
      ...metadata.alternates,
      types: {
        [RSS_MEDIA_TYPE]: [{ url: absoluteUrl(FEED_PATHS.rss), title: "News (RSS)" }],
        [ATOM_MEDIA_TYPE]: [{ url: absoluteUrl(FEED_PATHS.atom), title: "News (Atom)" }]
      }
    }
  };
}

/**
 * Refreshed every five minutes rather than frozen at build time.
 *
 * ⚠ REQUIRED BY THE `prerenderSafe` GUARD BELOW, not merely nice to have: a page whose data read fell
 * back at build time is prerendered EMPTY, and without a revalidation window that snapshot would be
 * served until the next deploy. It is also right on its own terms — this page lists content an editor
 * publishes without a deploy, so an unlimited lifetime is the wrong default regardless.
 */
export const revalidate = 300;

export default async function NewsIndexPage({
  searchParams
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readFilters(params);
  const page = pageFrom(params.page);
  const filtered = filters.category !== null || filters.tags.length > 0;

  // ONE `now` for the whole render, so the count and the rows cannot answer to two different instants
  // and disagree about how many articles there are.
  const now = new Date();
  const live = livePublishableWhere(now);

  /**
   * THE LEAD IS THE EDITOR'S PICK WHEN THERE IS ONE.
   *
   * `Post.isFeatured` is somebody's decision that a piece should be the front of the newsroom, and it
   * beats "whatever is newest" for the same reason an explicit `relatedTo` beats a category match: a
   * judgement is better than a heuristic, and the heuristic is still there when nobody has made one.
   *
   * Fetched before the list rather than alongside it, because its id has to go into the list's `where` —
   * one extra round trip to avoid printing the same article twice on one page. Only on the UNFILTERED
   * newsroom: a featured piece that does not match the reader's filters has no business being pinned
   * above a list it is not part of.
   */
  const featured = filtered
    ? null
    : await prisma.post.findFirst({
        where: { AND: [live, { isFeatured: true }] },
        orderBy: ARTICLE_LIST_ORDER,
        select: articleCardSelect
      });

  const where = newsWhere(filters, now, featured?.id ?? null);

  const [total, rows, categories, tags] = await prerenderSafe(
    "news",
    () =>
      Promise.all([
          prisma.post.count({ where }),
          prisma.post.findMany({
            where,
            orderBy: ARTICLE_LIST_ORDER,
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
            select: articleCardSelect
          }),
          // Only categories and tags that actually hold a live article. A filter chip that returns nothing
          // is a dead control, and pressing it looks exactly like a broken page.
          prisma.category.findMany({
            where: { posts: { some: live } },
            orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
            select: { slug: true, name: true }
          }),
          prisma.tag.findMany({
            where: { posts: { some: { post: live } } },
            orderBy: { name: "asc" },
            select: { slug: true, name: true }
          })
      ]),
    [0, [], [], []]
  );

  const groups: FilterGroup[] = [];
  if (categories.length > 0) {
    groups.push({
      key: "category",
      label: "Category",
      control: "select",
      placeholder: "All categories",
      options: categories.map((category) => ({ value: category.slug, label: category.name }))
    });
  }
  if (tags.length > 0) {
    groups.push({
      key: "tag",
      label: "Topics",
      multiple: true,
      control: "chips",
      allLabel: "Every topic",
      options: tags.map((tag) => ({ value: tag.slug, label: tag.name }))
    });
  }

  /**
   * The lead, and only on the first page — a lead halfway down an archive is just the thirteenth article
   * in a bigger box.
   *
   * Two sources, LABELLED DIFFERENTLY below, because they are two different claims: "Featured" is an
   * editor saying read this, "Latest" is only the top of the list. When the lead came from the list
   * itself it has to be sliced off the grid; when it came from `isFeatured` the query already excluded
   * it, so the grid is whole.
   */
  const lead = page === 1 ? (featured ?? rows[0]) : undefined;
  const leadIsFeatured = lead !== undefined && featured !== null;
  const rest = lead && !leadIsFeatured ? rows.slice(1) : rows;

  // A `?page=` past the end. Distinguished from "no matches" because the remedy is different: one
  // needs the filters cleared, the other needs page one.
  const pastTheEnd = total > 0 && rows.length === 0;

  return (
    <>
      <PageHero
        eyebrow="Newsroom"
        title="News"
        description={DESCRIPTION}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "News", href: "/news" }
        ]}
      />

      <div className="shell pb-24">
        {groups.length > 0 ? (
          <FilterBar
            label="Filter the newsroom"
            groups={groups}
            className="border-y border-line-200 py-6"
          />
        ) : null}

        {pastTheEnd ? (
          <EmptyState
            className="mt-12"
            headingLevel={2}
            icon={SearchX}
            title="That page is past the end of the list"
            description={`There are ${total} ${total === 1 ? NOUN.singular : NOUN.plural} in this view, which is fewer than page ${page} would need.`}
            action={
              <LinkButton href={listHref(filters)} variant="secondary">
                Back to the first page
              </LinkButton>
            }
          />
        ) : rows.length === 0 && !lead ? (
          // `!lead` matters: a newsroom holding exactly one article, and that article featured, has an
          // empty ARCHIVE and is not an empty newsroom.
          <EmptyState
            className="mt-12"
            headingLevel={2}
            icon={filtered ? SearchX : Newspaper}
            title={filtered ? "No articles match these filters" : "There are no articles yet"}
            description={
              filtered
                ? "Try a different category, or fewer topics."
                : "Pieces appear here as soon as they are published in the studio."
            }
            action={
              filtered ? (
                <LinkButton href="/news" variant="secondary">
                  Clear the filters
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <>
            {lead ? (
              <section className="mt-12">
                {/* "Featured" is a claim about somebody's judgement; "Latest" is a claim about a date.
                    Using one word for both would quietly dress the top of a list up as an editorial
                    choice. */}
                <SectionHeading
                  level={2}
                  title={leadIsFeatured ? "Featured" : "Latest"}
                  titleClassName="text-2xl sm:text-3xl"
                />
                <div className="mt-6">
                  {/* The one card above the fold, so the one `priority` image on the page. */}
                  <ArticleCard post={lead} variant="lead" headingLevel={3} priority />
                </div>
              </section>
            ) : null}

            {rest.length > 0 ? (
              <section className={lead ? "mt-16" : "mt-12"}>
                <SectionHeading
                  level={2}
                  title={lead ? (leadIsFeatured ? "Latest articles" : "More articles") : "Articles"}
                  // On a later page the heading is only there for the document outline: the pagination
                  // line above already says which slice of the archive this is.
                  titleClassName={lead ? "text-2xl sm:text-3xl" : "sr-only"}
                />
                <div className={lead ? "mt-6" : undefined}>
                  <CardGrid columns={3} stagger>
                    {rest.map((post) => (
                      <ArticleCard key={post.id} post={post} headingLevel={3} />
                    ))}
                  </CardGrid>
                </div>
              </section>
            ) : null}

            {/*
              Pagination owns the range sentence ("Showing 13–24 of 137 articles") inside its own
              `role="status"`. `ResultSummary` is deliberately NOT also rendered here — two status
              regions saying the same thing is one announcement too many, and nothing is being capped:
              every matching article is reachable by walking the pages.
            */}
            <Reveal as="div" className="mt-16">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={total}
                baseHref={listHref(filters)}
                label="Newsroom"
                itemNoun={NOUN}
              />
            </Reveal>
          </>
        )}

        {/*
          THE FEEDS, SAID OUT LOUD.

          `alternates.types` in `generateMetadata` tells a machine; this tells a person, and a feed
          nobody can find is not a feature — the discovery link is invisible in a browser that has no
          reader extension, which is most of them.

          OUTSIDE THE BRANCHES ABOVE, on purpose. An empty newsroom is exactly where subscribing is
          most valuable: the reader is asking to be told when the first piece lands instead of coming
          back to check. It is also the one block on this page that is true of every filtered and paged
          view, because the feeds carry the whole newsroom regardless of what is being looked at.
        */}
        <Reveal as="section" className="mt-16 border-t border-line-200 pt-10">
          <SectionHeading
            level={2}
            title="Follow the newsroom"
            titleClassName="text-2xl sm:text-3xl"
            description={`New articles arrive in any feed reader — no account and no newsletter. Both feeds carry up to the ${FEED_ITEM_LIMIT} most recent articles, newest first; anything older is reachable by walking these pages.`}
          />

          {/*
            ⚠ PLAIN `<a>` ELEMENTS, NOT `LinkButton`. These paths look internal, so `LinkButton` would
            route them through `next/link` — which prefetches them into the router cache and, on click,
            asks the client router to render an XML document as a page before giving up and doing a
            full navigation anyway. `buttonClasses` is exported for exactly this case: a control that
            must look like a button and cannot be one (components/ui/Button.tsx).

            `type` names the media type of what is on the other end, so a browser or an extension knows
            it is a feed before fetching it.
          */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <a
              href={FEED_PATHS.rss}
              type={RSS_MEDIA_TYPE}
              className={buttonClasses({ variant: "secondary" })}
            >
              <Rss aria-hidden="true" className="h-4 w-4 shrink-0" />
              RSS feed
            </a>
            <a
              href={FEED_PATHS.atom}
              type={ATOM_MEDIA_TYPE}
              className={buttonClasses({ variant: "secondary" })}
            >
              <Rss aria-hidden="true" className="h-4 w-4 shrink-0" />
              Atom feed
            </a>
          </div>
        </Reveal>
      </div>
    </>
  );
}
