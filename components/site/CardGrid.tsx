/**
 * CardGrid — the responsive grid every listing block lays its cards out on.
 *
 * IT RENDERS AN EmptyState WHEN THERE ARE NO CHILDREN. That is not a convenience: an empty grid is
 * indistinguishable from a grid that failed to render, and "no results" said plainly with a way back
 * is the difference between a dead end and a dead end with a door (contract §1.6). `Children.toArray`
 * drops `null`, `undefined` and `false`, so the ordinary `{rows.map(...)}` with a conditional inside
 * counts correctly.
 *
 * ⚠ `items === null` MEANS LOADING AND `items === []` MEANS EMPTY (contract §9). This component is
 * for the second. Rendering "No publications" while a fetch is in flight is both wrong and
 * discouraging — render a `Skeleton` for the first.
 *
 * ⚠ `EmptyState` RENDERS ITS OWN HEADING. The default here is level 3, because a grid almost always
 * sits under a `SectionHeading`'s `<h2>`; a default of 2 would make "No projects found" a sibling of
 * the section title rather than something under it.
 *
 * THE STAGGER IS CAPPED. Delay is `index × 0.05s` up to eight steps, then flat. Uncapped, the
 * twenty-fourth card of a dense grid arrives 1.2 seconds after the first, which reads as a slow page
 * rather than as a considered entrance. `Reveal` zeroes both the delay and the duration under reduced
 * motion — a zero-duration animation that still honours its delay is a staggered pop, not "no
 * motion".
 *
 * A Server Component. `Reveal` is the only client piece, and it is only mounted when `stagger` is on.
 */

import { Children, isValidElement, type ReactNode } from "react";

import { STAGGER } from "@/components/motion/constants";
import { Reveal } from "@/components/motion/Reveal";
import { EmptyState, type EmptyStateProps } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";

export type CardGridColumns = 2 | 3 | 4;

export interface CardGridProps {
  children?: ReactNode;
  /** Columns at the WIDEST breakpoint. Every setting starts at one column on a phone. */
  columns?: CardGridColumns;
  /** Wrap each child in a `Reveal` with an increasing delay. Off for above-the-fold grids. */
  stagger?: boolean;
  /**
   * What to say when there is nothing. Pass real copy — "No publications match these filters" and
   * "No publications yet" are different facts with different remedies, and only the first one should
   * offer to clear the filters.
   */
  empty?: EmptyStateProps;
  className?: string;
}

/** Complete literal class strings — a `grid-cols-${n}` built from a variable is purged (contract §5). */
const COLUMN_CLASS: Record<CardGridColumns, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
};

/** After this many cards the delay stops growing. See the header. */
const MAX_STAGGER_STEPS = 8;

const DEFAULT_EMPTY: EmptyStateProps = {
  title: "Nothing to show here yet",
  headingLevel: 3
};

export function CardGrid({
  children,
  columns = 3,
  stagger = false,
  empty,
  className
}: CardGridProps) {
  const items = Children.toArray(children);

  if (items.length === 0) {
    // `headingLevel` first so a caller's own value wins; the spread is what carries their copy.
    return <EmptyState headingLevel={3} {...(empty ?? DEFAULT_EMPTY)} />;
  }

  return (
    <div className={cn("grid gap-6", COLUMN_CLASS[columns], className)}>
      {stagger
        ? items.map((child, index) => (
            <Reveal
              // `Children.toArray` has already given every element a stable key derived from the
              // caller's own; reusing it keeps the wrapper's identity tied to the card's.
              key={isValidElement(child) && child.key !== null ? child.key : `card-${index}`}
              delay={Math.min(index, MAX_STAGGER_STEPS) * STAGGER.cards}
              // The grid stretches its items; `h-full` passes that height through the wrapper so the
              // cards in a row still line up along their bottom rails.
              className="h-full"
            >
              {child}
            </Reveal>
          ))
        : items}
    </div>
  );
}
