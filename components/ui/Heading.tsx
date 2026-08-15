import type { ComponentPropsWithoutRef } from "react";

/**
 * A heading whose RANK is a prop.
 *
 * Every component that renders a heading it does not own the context of — `EmptyState`,
 * `SectionHeading`, `EntityCard`, and every card and panel that follows — needs to be told which
 * level it is sitting at, because heading order is a document-wide property and a component cannot
 * know it locally. A card inside a section's `<h2>` must be an `<h3>`; the same card on a page with
 * no section heading must be an `<h2>`. Hard-coding either one guarantees the other case skips a
 * level, and a skipped level is a screen-reader user losing the outline of the page.
 *
 * WHY THIS EXISTS AS A COMPONENT rather than as a `Record<level, ElementType>` lookup in each caller,
 * which is the obvious approach and does not compile:
 *
 *   const Heading = HEADING_TAGS[level];   // typed Record<HeadingLevel, ElementType>
 *   <Heading className="…">{title}</Heading>
 *   //        ^ error TS2322: Type 'string' is not assignable to type 'never'.
 *
 * `ElementType` with no type argument is a union over every intrinsic tag. When TypeScript checks a
 * JSX call against a union of element types it INTERSECTS their prop types, and the intersection of
 * six different elements' `children` (and of `ElementType`'s wider union) collapses to `never`. The
 * error names `children`, so the instinct is to look at the children — but the cause is the union in
 * the map's value type, and no amount of casting the children fixes it. Annotating the map as
 * `ElementType` does not help either; it is what produces the union in the first place.
 *
 * A `switch` returning a CONCRETE intrinsic element per branch has no union to intersect. Each branch
 * is checked on its own, `props` is a single known type, and it compiles with no casts at all.
 *
 * `ComponentPropsWithoutRef<"h2">` is the full prop surface — `id`, `className`, `children`, every
 * ARIA and data attribute. All six heading tags share `HTMLHeadingElement`, so h2's props ARE h1's
 * props and naming one of them is not a narrowing.
 */

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Levels 2–6. Excludes 1 because a page has exactly one `<h1>` and it is never a component's call. */
export type SubHeadingLevel = 2 | 3 | 4 | 5 | 6;

export interface HeadingProps extends ComponentPropsWithoutRef<"h2"> {
  /** 1–6. There is no default: a component that renders a heading must state its rank explicitly. */
  level: HeadingLevel;
}

export function Heading({ level, ...props }: HeadingProps) {
  switch (level) {
    case 1:
      return <h1 {...props} />;
    case 2:
      return <h2 {...props} />;
    case 3:
      return <h3 {...props} />;
    case 4:
      return <h4 {...props} />;
    case 5:
      return <h5 {...props} />;
    case 6:
      return <h6 {...props} />;
    default: {
      // Unreachable while `level` is typed. It exists so that widening `HeadingLevel` without adding
      // a branch is a compile error here rather than a heading that silently vanishes from the page.
      const exhaustive: never = level;
      return <h2 {...props} data-unhandled-level={String(exhaustive)} />;
    }
  }
}
