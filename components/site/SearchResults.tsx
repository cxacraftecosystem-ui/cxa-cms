/**
 * SearchResults — the presentational half of `/search`, so the page itself stays a thin server
 * component that reads the index and hands the answer over.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE STATES, AND NONE OF THEM IS A BLANK PAGE.
 *
 *   • NO QUERY → suggestions. A search page that opens with "no results" has told the reader they
 *     failed at something they have not yet done. Recent news and featured projects are a way in.
 *   • NO MATCHES → the query is NAMED, the facets are offered with their real counts, and the
 *     suggestions are still there. "No results for “bagr”" plus "News (3)" is a page a reader can act
 *     on; "No results" is a dead end.
 *   • MATCHES → grouped by type, in rank order, with the cap stated.
 *
 * `truncated` IS PRINTED, ALWAYS. `search()` stops at fifty matches and the page must never stop
 * quietly: a list that ends without saying so is indistinguishable from a corpus with exactly fifty
 * matches (contract §1.6). `ResultSummary` is the component that owns that sentence, which is why its
 * `truncated` prop is required and has no default.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A SERVER COMPONENT. Every facet is a `<Link>` carrying the whole query string, so a filtered result
 * set is a URL somebody can send, the Back button walks the facets, and none of this needs JavaScript.
 *
 * THE FACET COUNTS DELIBERATELY IGNORE THE CURRENT TYPE FILTER. That is `byType`'s contract in
 * lib/search/query.ts: a facet list has to show what selecting a DIFFERENT type would give, and one
 * that only counts the current selection can never offer anything else. It is also what lets a
 * zero-result page for "publications" say that News has three.
 */

import Link from "next/link";
import { FileSearch, Search, SearchX, TriangleAlert } from "lucide-react";

import { EntityCard } from "@/components/site/EntityCard";
import { CardGrid } from "@/components/site/CardGrid";
import { ResultSummary } from "@/components/site/ResultSummary";
import { SectionHeading } from "@/components/site/SectionHeading";
import { searchTypeLabel } from "@/lib/search/index";
import type { SearchOutcome, SearchResult } from "@/lib/search/query";
import type { Picture } from "@/lib/media/screens";
import type { MediaLike } from "@/lib/media/url";
import { cn } from "@/lib/utils";

/** Complete literal class strings, matching the chips in components/site/FilterBar.tsx. */
const CHIP_BASE =
  "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition";
const CHIP_OFF =
  "border-line-200 bg-card text-ink-700 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700";
const CHIP_ON = "border-purple-700 bg-purple-700 text-white hover:bg-purple-800";

export interface SearchSuggestionItem {
  id: string;
  title: string;
  /** An internal path. Built by `searchUrlFor()` so it cannot drift from the index's own links. */
  href: string;
  summary: string | null;
  /** A date, a status — one short line under the title. */
  meta: string | null;
  media: MediaLike | null;
  /**
   * The suggestion's per-screen framing, already resolved by the page that built the item.
   *
   * Optional and resolved UPSTREAM because the alternate photographs a framing names live in a JSONB
   * column no relation can join, so only the page holding the query can fetch them. Omitted, or a single
   * band, and `MediaImage` renders exactly as it did before per-screen framing existed.
   */
  picture?: Picture | null;
}

export interface SearchSuggestionGroup {
  id: string;
  heading: string;
  description: string;
  items: readonly SearchSuggestionItem[];
}

export interface SearchResultsProps {
  /**
   * The query AS RUN — trimmed and capped by `search()`, not the raw parameter. Echoing the raw value
   * would show a reader 400 characters they pasted and imply all of it was searched for.
   */
  query: string;
  /** Null when no query was given at all. `total: 0` is a different fact and renders differently. */
  outcome: SearchOutcome | null;
  /** The `type` values in force. Unrecognised values are still shown — they are still narrowing. */
  selectedTypes: readonly string[];
  suggestions: readonly SearchSuggestionGroup[];
  /** The limit `search()` was called with, named in the truncation sentence. */
  cap: number;
  basePath?: string;
}

/** Group the ranked results by type, keeping rank order inside each group and between them. */
function groupByType(results: readonly SearchResult[]): { type: string; rows: SearchResult[] }[] {
  const groups = new Map<string, SearchResult[]>();

  for (const result of results) {
    const existing = groups.get(result.entityType);
    if (existing) {
      existing.push(result);
      continue;
    }
    groups.set(result.entityType, [result]);
  }

  // A `Map` preserves insertion order, and the results arrive ranked — so the group whose best match
  // ranked highest leads, without a second sort inventing an order of its own.
  return [...groups.entries()].map(([type, rows]) => ({ type, rows }));
}

function buildHref(
  basePath: string,
  query: string,
  types: readonly string[]
): string {
  const params = new URLSearchParams();
  if (query.length > 0) params.set("q", query);
  for (const type of types) params.append("type", type);
  const serialised = params.toString();
  return serialised.length > 0 ? `${basePath}?${serialised}` : basePath;
}

export function SearchResults({
  query,
  outcome,
  selectedTypes,
  suggestions,
  cap,
  basePath = "/search"
}: SearchResultsProps) {
  const asked = query.trim().length > 0;
  const results = outcome?.results ?? [];
  const groups = groupByType(results);

  /**
   * The facets: every type the query matched anywhere, plus any type the reader has selected that
   * matched nothing.
   *
   * The second half matters. Selecting "Publications" and getting nothing must leave the chip visible
   * and pressed — a filter that vanishes when it excludes everything leaves a reader looking at an
   * empty page with no visible reason for it.
   */
  const facetTypes = new Set<string>(Object.keys(outcome?.byType ?? {}));
  for (const type of selectedTypes) facetTypes.add(type);
  const facets = [...facetTypes]
    .map((type) => ({
      type,
      label: searchTypeLabel(type),
      count: outcome?.byType[type] ?? 0
    }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.label.localeCompare(b.label, "en-GB");
    });

  return (
    <div className="flex flex-col gap-10">
      {asked && outcome ? (
        <div className="flex flex-col gap-6">
          <ResultSummary
            shown={results.length}
            total={outcome.total}
            noun={{ singular: "result", plural: "results" }}
            truncated={outcome.truncated}
            cap={cap}
            omitted={Math.max(0, outcome.total - results.length)}
            remedy="Add another word, or narrow it to one kind of record below."
          />

          {outcome.mode === "prefix" ? (
            /**
             * WHY THIS LIST LOOKS DIFFERENT, SAID OUT LOUD.
             *
             * Full text cannot complete a partial word — "bagr" is not the lexeme "bagru" — and a
             * one- or two-letter query is all stopwords, so `search()` falls back to matching titles.
             * A reader who is not told that sees a search that ignored the body of every document.
             */
            <p className="flex items-start gap-2.5 rounded-md border border-line-200 bg-surface-50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warn-800" />
              <span>
                {query.length < 3
                  ? `“${query}” is too short to search the full text of anything, so these are titles that contain it.`
                  : `Nothing contained “${query}” as a whole word, so these are titles that contain it as part of one.`}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      {facets.length > 0 ? (
        <nav aria-label="Narrow by kind of record" className="flex flex-wrap items-center gap-2">
          <Link
            href={buildHref(basePath, query, [])}
            // `aria-current` rather than colour alone: which facet is selected must survive a
            // monochrome screen and reach a screen reader (contract §11).
            aria-current={selectedTypes.length === 0 ? "true" : undefined}
            className={cn(CHIP_BASE, selectedTypes.length === 0 ? CHIP_ON : CHIP_OFF)}
          >
            Everything
            {outcome ? (
              <span className={selectedTypes.length === 0 ? "text-white/70" : "text-ink-500"}>
                {Object.values(outcome.byType).reduce((sum, count) => sum + count, 0)}
              </span>
            ) : null}
          </Link>

          {facets.map((facet) => {
            const on = selectedTypes.includes(facet.type);
            return (
              <Link
                key={facet.type}
                // Pressing the selected chip again clears it — back to everything, which is the only
                // other state a single-type filter has.
                href={buildHref(basePath, query, on ? [] : [facet.type])}
                aria-current={on ? "true" : undefined}
                className={cn(CHIP_BASE, on ? CHIP_ON : CHIP_OFF)}
              >
                {facet.label}
                <span className={on ? "text-white/70" : "text-ink-500"}>{facet.count}</span>
              </Link>
            );
          })}
        </nav>
      ) : null}

      {asked && results.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-200 bg-surface-50 px-6 py-12 text-center">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-surface-200 text-ink-500">
            <SearchX aria-hidden="true" className="h-5 w-5" />
          </span>

          <h2 className="mt-4 font-display text-base font-semibold text-ink-900">
            Nothing matched “{query}”
          </h2>

          <p className="prose-measure mx-auto mt-2 text-sm leading-relaxed text-ink-500">
            {selectedTypes.length > 0 && facets.some((facet) => facet.count > 0)
              ? "Nothing of the kind you asked for matched. Other kinds of record did — the counts above say how many."
              : "The archive is searched by title, summary and body text. Try fewer words, a different spelling, or the name of a place or a material."}
          </p>

          {selectedTypes.length > 0 ? (
            <p className="mt-5">
              <Link
                href={buildHref(basePath, query, [])}
                className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-purple-700 transition-colors hover:text-purple-800"
              >
                <Search aria-hidden="true" className="h-4 w-4" />
                Search everything for “{query}”
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {groups.map(({ type, rows }) => {
        const label = searchTypeLabel(type);
        const matching = outcome?.byType[type] ?? rows.length;

        return (
          <section key={type} className="min-w-0">
            <SectionHeading
              title={label}
              description={
                matching > rows.length
                  ? `${rows.length} of ${matching} matching ${matching === 1 ? "record" : "records"} shown.`
                  : `${rows.length} matching ${rows.length === 1 ? "record" : "records"}.`
              }
              className="mb-6"
              titleClassName="text-xl sm:text-2xl"
            />

            <ol className="flex flex-col gap-3">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="rounded-lg border border-line-200 bg-card p-5 transition hover:border-purple-200 hover:shadow-md"
                >
                  <h3 className="display-title text-base leading-snug">
                    <Link
                      href={row.url}
                      className="rounded transition-colors hover:text-purple-700"
                    >
                      {row.title}
                    </Link>
                  </h3>

                  {row.summary ? (
                    <p className="mt-2 text-sm leading-relaxed text-ink-500">{row.summary}</p>
                  ) : null}

                  {/* The path, in plain sight. On a results page mixing ten kinds of record, where a
                      link goes is part of deciding whether to follow it. */}
                  <p className="mt-2 truncate text-xs text-ink-300">{row.url}</p>
                </li>
              ))}
            </ol>
          </section>
        );
      })}

      {suggestions.map((group) => (
        <section key={group.id} className="min-w-0">
          <SectionHeading
            title={group.heading}
            description={group.description}
            className="mb-8"
            titleClassName="text-xl sm:text-2xl"
          />

          <CardGrid
            columns={3}
            stagger
            empty={{
              icon: FileSearch,
              headingLevel: 3,
              title: "Nothing published here yet",
              description: "This is the only reason the row is empty — nothing has failed to load."
            }}
          >
            {group.items.map((item) => (
              <EntityCard
                key={item.id}
                href={item.href}
                media={item.media}
                picture={item.picture ?? null}
                headingLevel={3}
                title={item.title}
                description={item.summary ?? undefined}
                sizes="(min-width: 1024px) 30vw, (min-width: 640px) 46vw, 92vw"
                meta={item.meta ? <span>{item.meta}</span> : undefined}
              />
            ))}
          </CardGrid>
        </section>
      ))}
    </div>
  );
}
