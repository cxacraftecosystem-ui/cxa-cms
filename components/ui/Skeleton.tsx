/**
 * Skeleton — the shimmer placeholder, composing the `.skeleton` recipe from globals.css.
 *
 * THE SHIMMER IS THE MOTION HALF; the recipe's `background-color` is the static half, so under
 * reduced motion (where the global rule collapses every animation to 0.01ms) the block is still
 * visibly a placeholder rather than an empty area of page (contract §1.4). Nothing here needs to
 * branch in JS, because nothing here is framer-motion.
 *
 * ONE ANNOUNCEMENT PER SKELETON, NOT PER BAR. The bars live inside an `aria-hidden` wrapper and a
 * single visually-hidden "Loading…" sits beside them. Left unhidden, a six-line skeleton would be
 * six meaningless blocks in the accessibility tree; announced per block, it would be "Loading" six
 * times. → **Render ONE Skeleton with `lines={6}`, not six Skeletons.**
 *
 * WIDTH AND HEIGHT ARE INLINE STYLES, DELIBERATELY. A Tailwind class assembled from a variable
 * (`w-${n}`) is purged, because the scanner only ever sees complete literal strings in the source
 * (contract §5). A runtime dimension has to be a style, and pretending otherwise produces a skeleton
 * that is correct in development and 0px wide in production.
 *
 * ⚠ `items === null` means "loading" and `items === []` means "empty" (contract §9). This component
 * belongs to the first; EmptyState belongs to the second. Rendering "No publications" during a fetch
 * is both wrong and discouraging.
 */

import { cn } from "@/lib/utils";

export interface SkeletonProps {
  /** How many bars. The last one is shortened when there is more than one, as prose ends ragged. */
  lines?: number;
  /** CSS length or a number of pixels. Applies to every bar. */
  width?: number | string;
  /** CSS length or a number of pixels. Default one line of text. */
  height?: number | string;
  /** An avatar or a thumbnail: square, fully rounded, sized from `width` (or `height`). */
  circle?: boolean;
  className?: string;
  /** The sentence a screen reader hears. Name the thing: "Loading publications…". */
  label?: string;
}

export function Skeleton({
  lines = 1,
  width,
  height,
  circle = false,
  className,
  label = "Loading…"
}: SkeletonProps) {
  const count = Math.max(1, Math.floor(lines));
  const diameter = circle ? (width ?? height ?? "2.5rem") : undefined;

  return (
    <div className={cn(circle ? "inline-block" : "w-full", className)}>
      <span role="status" className="sr-only">
        {label}
      </span>

      <div aria-hidden="true" className={count > 1 ? "space-y-2" : undefined}>
        {Array.from({ length: count }, (_unused, index) => {
          const isLast = index === count - 1;
          const style = circle
            ? { width: diameter, height: diameter }
            : {
                // An explicit width wins everywhere; otherwise the closing line is short, which is
                // what makes a stack of bars read as a paragraph rather than as a table.
                width: width ?? (isLast && count > 1 ? "60%" : "100%"),
                height: height ?? "1rem"
              };

          return (
            // The index is the right key here: these are identical, ordered placeholders with no
            // identity of their own and nothing to reorder.
            <div key={index} style={style} className={cn("skeleton", circle && "rounded-full")} />
          );
        })}
      </div>
    </div>
  );
}
