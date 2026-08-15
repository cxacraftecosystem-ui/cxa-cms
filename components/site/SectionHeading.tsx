/**
 * SectionHeading — eyebrow, heading, body and an optional trailing link. Every section and every
 * listing block on the public site opens with one.
 *
 * `level` IS NOT COSMETIC AND HAS NO DEFAULT WORTH OVERRIDING CASUALLY. Heading levels never skip
 * (contract §11), and a document outline is the table of contents a screen-reader user navigates by:
 * an `<h4>` sitting directly under an `<h1>` tells them two levels of structure exist that do not.
 * The default is 2 because `PageHero` owns the `<h1>` — a section nested inside another section's
 * `<h2>` passes 3, and so on. The rendered SIZE follows the level, but `titleClassName` can override
 * it when a level-3 heading needs to look like a level-2 one; the tag is what the outline reads.
 *
 * Level 1 is deliberately absent from the union. If a block needs the page's only `<h1>`, that block
 * is the hero.
 *
 * A Server Component — nothing here is interactive, so nothing here ships JavaScript.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { Heading } from "@/components/ui/Heading";

/** 1 is missing on purpose. See the header. */
export type SectionHeadingLevel = 2 | 3 | 4 | 5 | 6;
export type SectionHeadingTone = "light" | "dark";

export interface SectionHeadingLink {
  href: string;
  /** Say where it goes — "All 214 publications", not "See more". */
  label: string;
  newTab?: boolean;
}

export interface SectionHeadingProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** One or two sentences under the heading. Held to a readable measure. */
  description?: ReactNode;
  level?: SectionHeadingLevel;
  /** The trailing "see everything" link, rendered to the right on `sm` and up. */
  link?: SectionHeadingLink;
  /** Anything else that belongs beside the heading — a tab row, a sort control. */
  actions?: ReactNode;
  tone?: SectionHeadingTone;
  align?: "start" | "center";
  /**
   * Anchor id. `data-anchor` is set alongside it so globals.css pays `--nav-clearance` for the jump
   * — never restate that as a `scroll-mt-*` here (contract §7).
   */
  id?: string;
  className?: string;
  /** Overrides the size that comes with `level`. It never changes which tag is rendered. */
  titleClassName?: string;
}

/** Complete literal class strings — a size built by concatenation is purged (contract §5). */
const TITLE_SIZE: Record<SectionHeadingLevel, string> = {
  2: "text-3xl sm:text-4xl",
  3: "text-2xl sm:text-3xl",
  4: "text-xl sm:text-2xl",
  5: "text-lg",
  6: "text-base"
};

const TITLE_TONE: Record<SectionHeadingTone, string> = {
  light: "display-title text-balance",
  // `.display-title` carries `text-ink-900`; the utility beats it on source order (contract §5).
  dark: "display-title text-balance text-white"
};

const EYEBROW_TONE: Record<SectionHeadingTone, string> = {
  light: "eyebrow",
  dark: "eyebrow text-gold-300"
};

const DESCRIPTION_TONE: Record<SectionHeadingTone, string> = {
  light: "text-base leading-relaxed text-ink-500",
  dark: "text-base leading-relaxed text-white/70"
};

const LINK_TONE: Record<SectionHeadingTone, string> = {
  light:
    "inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-purple-700 transition-colors hover:text-purple-800",
  dark:
    "inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-gold-300 transition-colors hover:text-white"
};

export function SectionHeading({
  eyebrow,
  title,
  description,
  level = 2,
  link,
  actions,
  tone = "light",
  align = "start",
  id,
  className,
  titleClassName
}: SectionHeadingProps) {
  const centred = align === "center";
  const hasTrailing = Boolean(link) || Boolean(actions);
  const trailing = hasTrailing ? (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-3", centred && "justify-center")}>
      {actions}
      {link ? (
        <Link
          href={link.href}
          className={LINK_TONE[tone]}
          {...(link.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {link.label}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
          {link.newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
        </Link>
      ) : null}
    </div>
  ) : null;

  return (
    <div
      id={id}
      data-anchor={id ? "" : undefined}
      className={cn(
        "flex flex-col gap-4",
        // The trailing link sits beside the heading once there is room for it, and under the
        // description on a phone, where a right-aligned link is a 40px target in the corner.
        trailing && !centred ? "sm:flex-row sm:items-end sm:justify-between sm:gap-8" : undefined,
        centred && "items-center text-center",
        className
      )}
    >
      <div className={cn("min-w-0", centred && "flex flex-col items-center")}>
        {eyebrow ? <p className={EYEBROW_TONE[tone]}>{eyebrow}</p> : null}

        <Heading
          level={level}
          className={cn(
            TITLE_TONE[tone],
            titleClassName ?? TITLE_SIZE[level],
            eyebrow ? "mt-2.5" : undefined
          )}
        >
          {title}
        </Heading>

        {description ? (
          <p className={cn("prose-measure mt-3", DESCRIPTION_TONE[tone], centred && "mx-auto")}>
            {description}
          </p>
        ) : null}
      </div>

      {trailing}
    </div>
  );
}
