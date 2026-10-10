/**
 * MdxLink — every link in an MDX article, whether the author wrote it as markdown (`[words](/page)`) or
 * as a JSX `<a>` (which lib/mdx-links.ts renames to `MDX_SAFE_LINK` so that it reaches this component
 * too; MDX would otherwise compile it to a literal anchor that nothing checks).
 *
 * Its own file so the rule can be rendered in a test without ProseArticle's settings read.
 */

import type { ReactNode } from "react";
import Link from "next/link";

import { isExternalHref, isInternalHref, safeHref } from "@/lib/safe-href";

/**
 * Links inside MDX.
 *
 * Anything that is not a path, an anchor or a query is another origin: it opens in a new tab with
 * the `rel` pair, and says so, because a reader whose focus lands in a new tab with no warning has
 * lost their place and their Back button with it.
 */
const LINK_CLASSES =
  "text-purple-700 underline decoration-purple-300 underline-offset-2 transition-colors hover:decoration-purple-700 dark:text-purple-300 dark:decoration-purple-300/50 dark:hover:decoration-purple-300";

export function MdxLink({ href, children }: { href?: string; children?: ReactNode }) {
  // lib/safe-href.ts — the same rule as the Tiptap renderer. `javascript:`, `//evil.example` and
  // `/\evil.example` render as their words with no anchor; a bare relative href stays a plain anchor.
  const target = safeHref(href, { relative: true });
  if (target === null) return <>{children}</>;
  if (isInternalHref(target)) {
    return (
      <Link href={target} className={LINK_CLASSES}>
        {children}
      </Link>
    );
  }
  const external = isExternalHref(target);
  return (
    <a
      href={target}
      className={LINK_CLASSES}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
      {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </a>
  );
}
