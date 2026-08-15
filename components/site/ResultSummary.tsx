/**
 * ResultSummary — "Showing 21–40 of 137 publications", and the sentence that owns the cap.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `truncated` IS REQUIRED AND HAS NO DEFAULT. This is the component that discharges contract §1.6:
 * a list that quietly stops is indistinguishable from a place with no records, and it is the single
 * most repeated bug class in the sibling product. Making the prop required means every listing that
 * renders a summary has to answer the question — and "did this list stop early?" is a question the
 * query already knows the answer to, because it is the one that applied the `take`.
 *
 * The honest pattern at the call site is to fetch one more row than the page needs:
 *
 *     const rows = await prisma.publication.findMany({ ...where, take: PAGE_SIZE + 1 });
 *     const truncated = rows.length > PAGE_SIZE;
 *
 * Then `truncated` is a fact rather than a guess.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT IS NOT A LIVE REGION BY DEFAULT. `Pagination` already renders its range line inside
 * `role="status"`; two status regions saying the same sentence is one announcement too many. Use
 * ResultSummary OR Pagination's built-in line on a given list, not both — and set `announce` only on
 * a list that updates in place without a navigation.
 *
 * A Server Component.
 */

import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ResultNoun {
  singular: string;
  plural: string;
}

export interface ResultSummaryProps {
  /** How many rows are on screen. */
  shown: number;
  /** How many there are in total, before paging. */
  total: number;
  /** 1-based index of the first row on screen. Default 1 — omit it on an unpaged list. */
  from?: number;
  /** "publication"/"publications". Lower case: it is read inside a sentence. */
  noun: ResultNoun;
  /**
   * REQUIRED. True when the query stopped short of everything that matched. See the header.
   */
  truncated: boolean;
  /** The limit that was applied. Named in the truncation sentence when it is known. */
  cap?: number;
  /** How many matches were left out, when that is known. Named in the truncation sentence. */
  omitted?: number;
  /** True when `total` is itself a capped count. Renders "of at least 500". */
  totalIsLowerBound?: boolean;
  /** What the reader can do about the cap — "Narrow the filters", "Search for a title". */
  remedy?: string;
  /** Wrap the range line in `role="status"`. Only for a list that updates without navigating. */
  announce?: boolean;
  className?: string;
}

export function ResultSummary({
  shown,
  total,
  from = 1,
  noun,
  truncated,
  cap,
  omitted,
  totalIsLowerBound = false,
  remedy,
  announce = false,
  className
}: ResultSummaryProps) {
  const safeShown = Math.max(0, Math.floor(shown));
  const safeTotal = Math.max(0, Math.floor(total));
  const first = Math.max(1, Math.floor(from));
  const last = safeShown > 0 ? first + safeShown - 1 : 0;

  const word = safeTotal === 1 ? noun.singular : noun.plural;
  const totalText = totalIsLowerBound ? `at least ${safeTotal}` : `${safeTotal}`;

  const range =
    safeShown === 0
      ? `No ${noun.plural} to show`
      : safeShown === safeTotal && first === 1
        ? // No paging happened, so a range would be "1–137 of 137" — a number said twice.
          `Showing all ${totalText} ${word}`
        : `Showing ${first}–${last} of ${totalText} ${word}`;

  // The cap sentence, assembled from whatever the caller could actually establish. Every branch says
  // that the list stopped; the better-informed branches also say by how much.
  const capSentence = (() => {
    if (typeof omitted === "number" && omitted > 0) {
      const left = omitted === 1 ? noun.singular : noun.plural;
      return typeof cap === "number"
        ? `This list stops at ${cap} ${noun.plural}. A further ${omitted} ${left} match and are not shown.`
        : `A further ${omitted} ${left} match and are not shown.`;
    }
    if (typeof cap === "number") {
      return `This list stops at ${cap} ${noun.plural}. There are more matches that are not shown.`;
    }
    return `This list was cut short. There are more ${noun.plural} than are shown here.`;
  })();

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <p {...(announce ? { role: "status" } : {})} className="text-sm text-ink-500">
        {range}
      </p>

      {truncated ? (
        // A bordered note rather than another line of grey text: this is the one sentence on the
        // page that changes what the numbers above it mean.
        <p className="flex items-start gap-2.5 rounded-md border border-line-200 bg-surface-50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warn-800" />
          <span>
            {capSentence}
            {remedy ? ` ${remedy}` : null}
          </span>
        </p>
      ) : null}
    </div>
  );
}
