/**
 * TagList — keywords, materials, techniques, categories. Chips, optionally linked.
 *
 * `max` TRUNCATES OUT LOUD. The overflow is a visible "+3 more" chip, and where a `moreHref` is
 * given it is a real link to the place the rest can be read. A list that quietly stops at four is
 * indistinguishable from an item with exactly four tags — the single most repeated bug class in the
 * sibling product (contract §1.6). There is no silent mode and there should not be one.
 *
 * A chip with no `href` is a `<span>`, not a `<button>` and not an `<a href="#">`. A control that
 * looks pressable and does nothing costs a keyboard user a tab stop and a screen-reader user an
 * announcement, in exchange for nothing.
 *
 * The list is a real `<ul>`: "list, 6 items" is the fastest way to know how many tags there are
 * without reading them all.
 *
 * A Server Component — chips do not need JavaScript.
 */

import type { ReactNode } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export interface TagObject {
  label: string;
  /** Internal path. Omitted, the chip is plain text. */
  href?: string;
  /** A longer form for the tooltip — an expanded acronym, a full technique name. */
  title?: string;
}

/** A plain string is the common case (`Craft.materials`, `Publication.keywords`). */
export type TagListItem = string | TagObject;

export type TagListTone = "light" | "dark";
export type TagListSize = "sm" | "md";

export interface TagListProps {
  tags: readonly TagListItem[];
  /** Names the list for a screen reader — "Keywords", "Materials". Default "Tags". */
  label?: string;
  /** Show at most this many, then an honest "+N more". Omitted, every tag is rendered. */
  max?: number;
  /**
   * Where "+N more" goes — normally the detail page that lists them all. Strongly preferred: an
   * overflow chip that is a link tells the reader where the rest are, not merely that they exist.
   */
  moreHref?: string;
  tone?: TagListTone;
  size?: TagListSize;
  /** Rendered before the first chip — a small icon, the word "Tagged". */
  prefix?: ReactNode;
  className?: string;
}

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const BASE = "inline-flex items-center rounded-full border font-medium leading-none";

const SIZE_CLASS: Record<TagListSize, string> = {
  sm: "gap-1 px-2 py-0.5 text-[0.6875rem]",
  md: "gap-1.5 px-2.5 py-1 text-xs"
};

const STATIC_CLASS: Record<TagListTone, string> = {
  light: "border-line-200 bg-surface-100 text-ink-700",
  dark: "border-white/20 bg-white/10 text-white/85"
};

const LINK_CLASS: Record<TagListTone, string> = {
  light:
    "border-line-200 bg-surface-100 text-ink-700 transition hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700",
  dark: "border-white/20 bg-white/10 text-white transition hover:border-white/40 hover:bg-white/20"
};

function normalise(tag: TagListItem): TagObject {
  return typeof tag === "string" ? { label: tag } : tag;
}

export function TagList({
  tags,
  label = "Tags",
  max,
  moreHref,
  tone = "light",
  size = "md",
  prefix,
  className
}: TagListProps) {
  const items = tags.map(normalise).filter((tag) => tag.label.trim().length > 0);
  if (items.length === 0) return null;

  const limit = typeof max === "number" && max > 0 ? Math.floor(max) : items.length;
  const shown = items.slice(0, limit);
  const hidden = items.slice(limit);

  const chipClass = (interactive: boolean) =>
    cn(BASE, SIZE_CLASS[size], interactive ? LINK_CLASS[tone] : STATIC_CLASS[tone]);

  return (
    <ul aria-label={label} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {prefix ? (
        <li aria-hidden="true" className="text-xs text-ink-500">
          {prefix}
        </li>
      ) : null}

      {shown.map((tag, index) => (
        // The label alone is not guaranteed unique — a keyword list can legitimately repeat after a
        // merge — so the index is part of the key. The list is rendered whole and never reordered.
        <li key={`${tag.label}-${index}`}>
          {tag.href ? (
            <Link href={tag.href} title={tag.title} className={chipClass(true)}>
              {tag.label}
            </Link>
          ) : (
            <span title={tag.title} className={chipClass(false)}>
              {tag.label}
            </span>
          )}
        </li>
      ))}

      {hidden.length > 0 ? (
        <li>
          {moreHref ? (
            <Link href={moreHref} className={chipClass(true)}>
              {/* The count is spoken as part of the link, and the names of what was hidden are in
                  the title for a pointer. Neither is a substitute for the destination itself. */}
              +{hidden.length} more
              <span className="sr-only">
                {" "}
                {label.toLowerCase()}: {hidden.map((tag) => tag.label).join(", ")}
              </span>
            </Link>
          ) : (
            <span
              // No destination was given, so this is a statement rather than a link. It still says
              // exactly how many were dropped, and names them on hover — never a silent stop.
              title={hidden.map((tag) => tag.label).join(", ")}
              className={chipClass(false)}
            >
              +{hidden.length} more
              <span className="sr-only">
                {" "}
                {label.toLowerCase()}: {hidden.map((tag) => tag.label).join(", ")}
              </span>
            </span>
          )}
        </li>
      ) : null}
    </ul>
  );
}
