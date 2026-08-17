/**
 * /search — the results page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `force-dynamic`, AND NOT NEGOTIABLE.
 *
 * A search page is one document per query string. Cached, the first reader's search would be served to
 * the second, and the ISR key would be the path — so "bagru" and "indigo" would be the same entry.
 * There is nothing to gain from caching it either: the work is one indexed Postgres query.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A THIN SERVER COMPONENT. It reads the query string, calls `search()` from lib/search/query.ts, and
 * hands the outcome to `SearchResults` — which owns every decision about how it reads. Ranking happens
 * in Postgres, because pulling the corpus into Node to sort it would mean reading everything to render
 * twenty rows.
 *
 * IT DOES NOT LOG THE QUERY. `logSearch()` exists and never throws, but a write during a render is a
 * write that runs again on every retry and on every double-render, and the analytics screen would then
 * count one search several times. The place for that is the search API route, where a query is one
 * request and one write.
 *
 * SUGGESTIONS ARE FETCHED ONLY WHEN THEY WILL BE SHOWN — an empty query, or a query that matched
 * nothing. A page that found what it was asked for should not also pay for two more queries.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS PAGE ADDS NO ENTRANCE MOTION, AND THAT IS THE DECISION RATHER THAN THE OMISSION.
 *
 * Every other index on the site rises into place — `CardGrid`'s capped stagger for a grid of cards,
 * one `Reveal` for the pager under it. A RESULTS LIST MAY NOT HAVE ONE. `FilterBar` writes `q` on a
 * debounce and calls `router.replace(…, { scroll: false })`, so these rows are re-rendered while the
 * reader is still typing: a fade-up on them replays on the way to the word being searched for, over
 * the one region of the page the reader is actually watching. That is a flicker book, not an entrance,
 * and it is the reason app/(site)/people/PeopleDirectory.tsx keeps its own grid's stagger switched off.
 *
 * The suggestion rows DO stagger, inside `SearchResults`, and the difference is what they are: they
 * appear only when the reader has asked for nothing or matched nothing, and they are the newest news
 * and the featured projects — a fixed set that does not change as the query does. Nothing is being
 * animated out from under a search in progress.
 *
 * So: if an audit finds this page still and takes that for a page somebody forgot, this paragraph is
 * the answer. The frame moves elsewhere; the answers do not move under the person reading them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Metadata } from "next";

import { FilterBar } from "@/components/site/FilterBar";
import { PageHero } from "@/components/site/PageHero";
import {
  SearchResults,
  type SearchSuggestionGroup,
  type SearchSuggestionItem
} from "@/components/site/SearchResults";
import { liveStatusWhere, livePublishableWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { searchUrlFor } from "@/lib/search/index";
import { search } from "@/lib/search/query";
import { pageMetadata } from "@/lib/seo";
import { truncateWords } from "@/lib/utils";

const SEARCH_PATH = "/search";

/**
 * The cap `search()` is called with, which is also its own MAX_LIMIT.
 *
 * DELIBERATELY NOT PAGINATED. lib/search/query.ts puts the reason plainly: deep paging over a ranked
 * scan costs the same as reading everything before it, and the UI should refine instead. So the page
 * offers a cap it states, facets that narrow, and a remedy sentence — rather than a page 3 that costs
 * three times page 1 to produce.
 */
const RESULT_LIMIT = 50;

/** How many rows each suggestion row shows. */
const SUGGESTION_LIMIT = 3;

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

interface SearchPageProps {
  searchParams: Promise<SearchParams>;
}

/** The media columns a suggestion card needs, from the one shared fragment (crop included). */
const MEDIA_SELECT = MEDIA_IMAGE_SELECT;

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return (value ?? "").trim();
}

function allValues(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export async function generateMetadata({ searchParams }: SearchPageProps): Promise<Metadata> {
  const params = await searchParams;
  const query = firstValue(params.q);

  return pageMetadata({
    title: query.length > 0 ? `Search: ${query}` : "Search",
    description:
      query.length > 0
        ? `Everything on the site matching “${query}”.`
        : "Search the Centre's research, publications, news, events, people and craft archive.",
    path: SEARCH_PATH,
    /**
     * A page WITH a query is `noindex`; the bare page is indexable.
     *
     * A results page is thin, duplicated content that competes with the records it lists, and crawlers
     * following one query string will follow a thousand. `pageMetadata` sets both `robots` and
     * `googleBot`, which is the part that is easy to get half right.
     */
    noIndex: query.length > 0
  });
}

/** "ON_HOLD" → "On hold". An enum read verbatim is a shout in the middle of a sentence. */
function humaniseState(value: string): string {
  const words = value.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * What to offer a reader who has not asked for anything, or who asked for something the archive does
 * not hold: the newest news and the Centre's featured work.
 *
 * `livePublishableWhere()` for posts, which carry `publishAt`/`unpublishAt`, and `liveStatusWhere()`
 * for projects, which do not. The two are separate functions because referencing a column a model does
 * not have is a runtime error, not a type error (lib/content.ts).
 */
async function loadSuggestions(): Promise<SearchSuggestionGroup[]> {
  const [posts, projects] = await Promise.all([
    prisma.post.findMany({
      where: livePublishableWhere(),
      // `nulls: "last"` is load-bearing: Postgres sorts NULLs FIRST on a descending order, so a
      // SCHEDULED post with no `publishedAt` yet would otherwise lead the newest-first list.
      orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: SUGGESTION_LIMIT,
      select: {
        id: true,
        slug: true,
        title: true,
        subtitle: true,
        excerpt: true,
        publishedAt: true,
        cover: { select: MEDIA_SELECT }
      }
    }),
    prisma.project.findMany({
      where: liveStatusWhere(),
      // Featured first, then the editor's own order, then a total tiebreak on the unique slug.
      orderBy: [{ isFeatured: "desc" }, { sortOrder: "asc" }, { title: "asc" }, { slug: "asc" }],
      take: SUGGESTION_LIMIT,
      select: {
        id: true,
        slug: true,
        title: true,
        tagline: true,
        summary: true,
        state: true,
        cover: { select: MEDIA_SELECT }
      }
    })
  ]);

  const newsItems: SearchSuggestionItem[] = posts.map((post) => ({
    id: post.id,
    title: post.title,
    href: searchUrlFor("post", post.slug),
    // Truncated on the server: a CSS line clamp hides the tail from sighted readers and leaves it in
    // the accessibility tree, so the two disagree about what the card says.
    summary: post.excerpt
      ? truncateWords(post.excerpt, 140)
      : post.subtitle
        ? truncateWords(post.subtitle, 140)
        : null,
    meta: post.publishedAt ? formatDate(post.publishedAt) : null,
    media: post.cover
  }));

  const projectItems: SearchSuggestionItem[] = projects.map((project) => ({
    id: project.id,
    title: project.title,
    href: searchUrlFor("project", project.slug),
    summary: project.tagline
      ? truncateWords(project.tagline, 140)
      : project.summary
        ? truncateWords(project.summary, 140)
        : null,
    meta: humaniseState(project.state),
    media: project.cover
  }));

  const groups: SearchSuggestionGroup[] = [];

  if (newsItems.length > 0) {
    groups.push({
      id: "news",
      heading: "Latest news",
      description: "The most recent pieces from the newsroom.",
      items: newsItems
    });
  }

  if (projectItems.length > 0) {
    groups.push({
      id: "projects",
      heading: "Projects",
      description: "Featured work first, then the Centre's own order.",
      items: projectItems
    });
  }

  return groups;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const query = firstValue(params.q);
  const types = allValues(params.type);

  const outcome =
    query.length > 0
      ? await search({ q: query, types, limit: RESULT_LIMIT })
      : null;

  // Shown when there is nothing else to show — an unasked question or an unanswered one.
  const suggestions = outcome === null || outcome.total === 0 ? await loadSuggestions() : [];

  return (
    <>
      <PageHero
        eyebrow="Search"
        title={query.length > 0 ? `Results for “${outcome?.query ?? query}”` : "Search"}
        description={
          query.length > 0
            ? undefined
            : "One box over everything the Centre publishes: research areas, projects, publications, news, events, people, the craft archive and the files."
        }
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Search", href: SEARCH_PATH }
        ]}
      >
        {/*
          The box lives in the hero's `children` slot. `FilterBar` owns the debounce, writes `q` with
          `router.replace(…, { scroll: false })` and preserves the `type` parameters it does not own —
          so changing the words keeps the facet.

          `formAction` makes the bar a real `<form method="get">` with `name="q"`, so the box works
          WITHOUT JavaScript too: Enter performs the GET, this page is `force-dynamic`, and the results
          are rendered on the server from `searchParams` either way. With JavaScript the submit is
          intercepted and the live-search behaviour above is exactly what it was.
        */}
        <FilterBar
          label="Search"
          formAction={SEARCH_PATH}
          search={{
            key: "q",
            label: "Search the site",
            placeholder: "A craft, a person, a publication, a place…"
          }}
          className="max-w-2xl"
        />
      </PageHero>

      <div className="shell pb-24">
        <SearchResults
          // The query AS RUN, so a 400-character paste is echoed at the length that was searched for.
          query={outcome?.query ?? query}
          outcome={outcome}
          selectedTypes={types}
          suggestions={suggestions}
          cap={RESULT_LIMIT}
          basePath={SEARCH_PATH}
        />
      </div>
    </>
  );
}
