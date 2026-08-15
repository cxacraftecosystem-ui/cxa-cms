"use client";

/**
 * Pagination — page numbers, and the sentence that makes them mean something.
 *
 * ⚠ THE RANGE LINE IS NOT OPTIONAL. "Page 2 of 7" tells a reader where they are; "Showing 21–40 of
 * 137 publications" tells them how much there IS, which is the fact a list is usually asked for. A
 * page count alone cannot say whether the list was capped, and a list that quietly stops is
 * indistinguishable from a place with no records — the most repeated bug class upstream (contract
 * §1.6). `countIsLowerBound` exists for the case where the total is itself a cap: it renders "of at
 * least 500", which is the truth rather than a comfortable round number.
 *
 * TWO MODES, AND `baseHref` IS NOT A CALLBACK. A server-rendered public list paginates with real
 * links so a page can be bookmarked, shared and crawled — but a Server Component cannot hand a
 * function to a Client Component, so link mode takes the path as a STRING and builds the query here.
 * A studio list, which fetches over HTTP and keeps its filters in state, passes `onPageChange`
 * instead and gets buttons. Pass one or the other; `baseHref` wins if both arrive.
 *
 * DISABLED MEANS `disabled`. Previous at page 1 is a real disabled `<button>` in both modes, never a
 * link to nowhere and never an `aria-disabled` anchor that still looks pressable.
 *
 * THE CURRENT PAGE STAYS FOCUSABLE, carrying `aria-current="page"`. Disabling it would take it out
 * of the tab order, and a keyboard reader arrowing along the row would then never be told which page
 * they are on — the one thing the row exists to say.
 */

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { clamp, cn } from "@/lib/utils";

/** Two distinct gap markers so the two ellipses have stable, unique React keys. */
type PageEntry = number | "gap-start" | "gap-end";

const ITEM_BASE =
  "inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition";
const ITEM_IDLE =
  "border-line-200 bg-card text-ink-700 hover:border-purple-300 hover:bg-purple-50 hover:text-ink-900";
const ITEM_CURRENT = "border-purple-700 bg-purple-700 text-white";
const ITEM_DISABLED = "cursor-not-allowed border-line-200 bg-surface-100 text-ink-300";

export interface PaginationProps {
  /** 1-based. Clamped for display; a page past the end is a stale link, not a crash. */
  page: number;
  pageSize: number;
  totalItems: number;
  /** Button mode. Client parents only — a function cannot cross the server/client boundary. */
  onPageChange?: (page: number) => void;
  /** Link mode. The current path plus any filters already in the query: "/publications?year=2024". */
  baseHref?: string;
  /** The query parameter carrying the page. Default "page". */
  pageParam?: string;
  /** Names the nav: "Publications" becomes `aria-label="Publications pagination"`. */
  label?: string;
  /** For the range sentence. Default "item"/"items". */
  itemNoun?: { singular: string; plural: string };
  /** True when `totalItems` is a capped count rather than the real one. Renders "of at least N". */
  countIsLowerBound?: boolean;
  /** Page numbers shown either side of the current one. Default 1 — 5 numbers plus the two ends. */
  siblingCount?: number;
  className?: string;
}

/**
 * Page 1 drops the parameter entirely, so the first page has exactly one URL. `?page=1` alongside a
 * bare path is two addresses for one document, which is a canonical-tag problem and a duplicate row
 * in every analytics report.
 */
function hrefForPage(baseHref: string, pageParam: string, page: number): string {
  const [path = "", query = ""] = baseHref.split("?");
  const params = new URLSearchParams(query);
  if (page <= 1) params.delete(pageParam);
  else params.set(pageParam, String(page));
  const search = params.toString();
  return search.length > 0 ? `${path}?${search}` : path;
}

/** First, last, a window around the current page, and an ellipsis wherever a jump was skipped. */
function buildEntries(current: number, totalPages: number, siblings: number): PageEntry[] {
  const start = clamp(current - siblings, 1, totalPages);
  const end = clamp(current + siblings, 1, totalPages);
  const entries: PageEntry[] = [];

  if (start > 1) {
    entries.push(1);
    // Only a real gap earns an ellipsis; a single missing number is just printed.
    if (start > 2) entries.push("gap-start");
  }
  for (let page = start; page <= end; page += 1) entries.push(page);
  if (end < totalPages) {
    if (end < totalPages - 1) entries.push("gap-end");
    entries.push(totalPages);
  }

  return entries;
}

export function Pagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
  baseHref,
  pageParam = "page",
  label = "Results",
  itemNoun = { singular: "item", plural: "items" },
  countIsLowerBound = false,
  siblingCount = 1,
  className
}: PaginationProps) {
  // Nothing to page through: the caller is already rendering an EmptyState, and a lone "Showing 0 of
  // 0" under it would be a second, weaker statement of the same fact.
  if (totalItems <= 0) return null;

  const size = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const current = clamp(Math.floor(page), 1, totalPages);

  const first = (current - 1) * size + 1;
  const last = Math.min(current * size, totalItems);
  const noun = totalItems === 1 ? itemNoun.singular : itemNoun.plural;
  const total = countIsLowerBound ? `at least ${totalItems}` : `${totalItems}`;

  const entries = buildEntries(current, totalPages, Math.max(0, Math.floor(siblingCount)));
  const useLinks = typeof baseHref === "string";

  const goTo = (target: number) => {
    if (target === current) return;
    onPageChange?.(clamp(target, 1, totalPages));
  };

  const renderStep = (target: number, direction: "previous" | "next") => {
    const disabled = direction === "previous" ? current <= 1 : current >= totalPages;
    const Glyph = direction === "previous" ? ChevronLeft : ChevronRight;
    const word = direction === "previous" ? "Previous" : "Next";

    const body =
      direction === "previous" ? (
        <>
          <Glyph aria-hidden="true" className="h-4 w-4" />
          {word}
        </>
      ) : (
        <>
          {word}
          <Glyph aria-hidden="true" className="h-4 w-4" />
        </>
      );

    if (disabled) {
      return (
        <button type="button" disabled className={cn(ITEM_BASE, ITEM_DISABLED)}>
          {body}
        </button>
      );
    }

    if (useLinks && baseHref) {
      return (
        <Link href={hrefForPage(baseHref, pageParam, target)} className={cn(ITEM_BASE, ITEM_IDLE)}>
          {body}
        </Link>
      );
    }

    return (
      <button type="button" onClick={() => goTo(target)} className={cn(ITEM_BASE, ITEM_IDLE)}>
        {body}
      </button>
    );
  };

  return (
    <nav
      aria-label={`${label} pagination`}
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      {/*
        A status region, so a reader who changes page in BUTTON mode hears the new range. In link
        mode the document is replaced and nothing is announced from here, which is correct — the page
        title does that job.
      */}
      <p role="status" className="text-sm text-ink-500">
        Showing {first}–{last} of {total} {noun}
      </p>

      {totalPages > 1 ? (
        <ul className="flex flex-wrap items-center gap-1">
          <li>{renderStep(current - 1, "previous")}</li>

          {entries.map((entry) =>
            typeof entry === "number" ? (
              <li key={entry}>
                {entry === current && useLinks && baseHref ? (
                  <Link
                    href={hrefForPage(baseHref, pageParam, entry)}
                    aria-current="page"
                    aria-label={`Page ${entry}`}
                    className={cn(ITEM_BASE, ITEM_CURRENT)}
                  >
                    {entry}
                  </Link>
                ) : entry === current ? (
                  // A real button, not a tabbable <span>: it stays in the tab order so a keyboard
                  // reader is told "Page 3, current page", and pressing it does nothing (`goTo`
                  // returns early) rather than re-fetching the list they are already looking at.
                  <button
                    type="button"
                    aria-current="page"
                    aria-label={`Page ${entry}`}
                    onClick={() => goTo(entry)}
                    className={cn(ITEM_BASE, ITEM_CURRENT)}
                  >
                    {entry}
                  </button>
                ) : useLinks && baseHref ? (
                  <Link
                    href={hrefForPage(baseHref, pageParam, entry)}
                    aria-label={`Page ${entry}`}
                    className={cn(ITEM_BASE, ITEM_IDLE)}
                  >
                    {entry}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => goTo(entry)}
                    aria-label={`Page ${entry}`}
                    className={cn(ITEM_BASE, ITEM_IDLE)}
                  >
                    {entry}
                  </button>
                )}
              </li>
            ) : (
              // `aria-hidden`: the row is not a complete enumeration in any case, and "ellipsis"
              // read out between two page numbers is noise rather than information.
              <li key={entry} aria-hidden="true">
                <span className="inline-flex min-h-10 min-w-10 items-center justify-center text-sm text-ink-300">
                  …
                </span>
              </li>
            )
          )}

          <li>{renderStep(current + 1, "next")}</li>
        </ul>
      ) : null}
    </nav>
  );
}
