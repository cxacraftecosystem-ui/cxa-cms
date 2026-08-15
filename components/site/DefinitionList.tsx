/**
 * DefinitionList — the `<dl>` every detail page's fact panel is built from: funding, dates, DOI,
 * venue, region, licence.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AN EMPTY FIELD IS ABSENT, NOT AN EMPTY ROW. Every one of these panels is assembled from optional
 * columns, and a row reading "DOI —" tells a reader that this publication has a DOI which the site
 * has failed to show them. It does not. Nothing is a row.
 *
 * ⚠ `0` IS A VALUE. `hasValue` tests for null, undefined, booleans and whitespace — never for
 * falsiness — because a project at 0% progress, a dataset with 0 downloads and a craft dated to year
 * 0 are all facts, and a `value && <dd>` would drop every one of them.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `hasVisibleDefinitions` is exported so a caller can decide whether to render the PANEL at all —
 * this component returns null when nothing survives, which would otherwise leave a "Details"
 * heading with nothing under it.
 *
 * THE ROWS ARE `<div>`s INSIDE THE `<dl>`. That is valid HTML (a `<div>` may group a `<dt>`/`<dd>`
 * pair) and it is what lets the pair be laid out as a unit without breaking the list semantics that
 * make a fact panel navigable.
 *
 * A Server Component.
 */

import type { ReactNode } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export interface DefinitionItem {
  /** The label — "Funding body", "Published", "DOI". */
  term: string;
  /** Null, undefined, an empty string or a boolean means the row is not rendered at all. */
  value: ReactNode;
  /** Turns the value into a link. Absolute URLs open in a new tab with the `rel` pair. */
  href?: string;
  /** A short note under the value — a unit, a caveat, "as of March 2026". */
  note?: ReactNode;
}

export type DefinitionListLayout = "stacked" | "inline";

export interface DefinitionListProps {
  items: readonly DefinitionItem[];
  /**
   * `stacked` puts the term above the value (a narrow side panel); `inline` sets them side by side
   * from `sm` up (a wide fact table under an article).
   */
  layout?: DefinitionListLayout;
  /** Two columns of stacked pairs from `sm` up. Ignored by the `inline` layout. */
  columns?: 1 | 2;
  className?: string;
}

/**
 * Is there anything to show?
 *
 * Deliberately not a falsiness test — see the header. `true`/`false` are excluded because React
 * renders neither, so a boolean in this slot would produce a term with nothing beside it.
 */
function hasValue(value: ReactNode): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => hasValue(entry as ReactNode));
  return true;
}

/** True when at least one row would render. Use it to decide whether to render the panel around it. */
export function hasVisibleDefinitions(items: readonly DefinitionItem[]): boolean {
  return items.some((item) => hasValue(item.value));
}

const VALUE_LINK =
  "rounded text-purple-700 underline decoration-purple-300 underline-offset-2 transition-colors hover:decoration-purple-700 dark:text-purple-300 dark:decoration-purple-300/50";

export function DefinitionList({
  items,
  layout = "stacked",
  columns = 1,
  className
}: DefinitionListProps) {
  const rows = items.filter((item) => hasValue(item.value));
  if (rows.length === 0) return null;

  const inline = layout === "inline";

  return (
    <dl
      className={cn(
        inline
          ? "divide-y divide-line-200 border-y border-line-200"
          : cn("grid gap-x-8 gap-y-5", columns === 2 ? "sm:grid-cols-2" : "grid-cols-1"),
        className
      )}
    >
      {rows.map((item, index) => {
        const external = typeof item.href === "string" && /^https?:/i.test(item.href);
        const value =
          item.href === undefined ? (
            item.value
          ) : external ? (
            <a
              href={item.href}
              target="_blank"
              rel="noopener noreferrer"
              className={VALUE_LINK}
            >
              {item.value}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <Link href={item.href} className={VALUE_LINK}>
              {item.value}
            </Link>
          );

        return (
          // The term is not guaranteed unique — a publication can carry two "Identifier" rows — so
          // the index is part of the key. The panel is rendered whole and never reordered.
          <div
            key={`${item.term}-${index}`}
            className={cn(inline ? "grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-6" : undefined)}
          >
            <dt className="field-label">{item.term}</dt>
            <dd className={cn("text-sm leading-relaxed text-ink-900", inline ? undefined : "mt-1.5")}>
              {value}
              {item.note ? (
                <span className="mt-1 block text-xs leading-relaxed text-ink-500">{item.note}</span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
