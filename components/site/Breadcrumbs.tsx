/**
 * Breadcrumbs — where this page sits, said once in the DOM and once in the structured data.
 *
 * ⚠ THIS MODULE IS SERVER-ONLY. It imports lib/seo.ts, which carries `server-only`, because the
 * JSON-LD helper below has to build absolute URLs from `siteUrl()`. A client component cannot import
 * it, and that is the right constraint: a breadcrumb trail is a fact about the route, known on the
 * server, and a client that recomputed it from `usePathname()` would have to re-derive every label.
 *
 * THE LAST CRUMB IS NOT A LINK. It carries `aria-current="page"` on a `<span>`. A link to the page
 * you are already on is a control that does nothing, and screen readers announce it as a destination
 * — so the reader is offered a journey to where they are standing.
 *
 * THE SEPARATORS ARE `aria-hidden`. The `<ol>` already tells a reader this is an ordered list of N
 * items; a chevron read out between each pair adds "greater than" five times to a two-second
 * announcement.
 *
 * TWO EXPORTS FOR THE SAME TRAIL, ON PURPOSE. `Breadcrumbs` renders what a person sees;
 * `BreadcrumbJsonLd` renders what a crawler reads. They take the SAME array, so the two cannot
 * disagree — and `PageHero` emits both from its one `breadcrumbs` prop, which is how most pages
 * should reach them.
 */

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { breadcrumbJsonLd, serializeJsonLd } from "@/lib/seo";
import { cn } from "@/lib/utils";

export interface BreadcrumbItem {
  /** The visible label, and the `name` in the structured data. */
  name: string;
  /**
   * Internal path WITH a leading slash. The last item's href is still required — the structured data
   * records an `item` URL for every entry including the current page — but it is not rendered as a
   * link.
   */
  href: string;
}

export type BreadcrumbTone = "light" | "dark";

export interface BreadcrumbsProps {
  items: readonly BreadcrumbItem[];
  /** `dark` is for a crumb trail sitting on a `.surface-dark` hero band. */
  tone?: BreadcrumbTone;
  className?: string;
}

/** Complete literal class strings — a name assembled by concatenation is purged (contract §5). */
const LINK_CLASS: Record<BreadcrumbTone, string> = {
  light: "rounded text-ink-500 transition-colors hover:text-purple-700",
  dark: "rounded text-white/70 transition-colors hover:text-white"
};

const CURRENT_CLASS: Record<BreadcrumbTone, string> = {
  light: "font-medium text-ink-900",
  dark: "font-medium text-white"
};

const SEPARATOR_CLASS: Record<BreadcrumbTone, string> = {
  light: "text-ink-300",
  dark: "text-white/40"
};

export function Breadcrumbs({ items, tone = "light", className }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  const lastIndex = items.length - 1;

  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        {items.map((item, index) => (
          // The href alone is not unique — a trail can legitimately repeat a path — so the index is
          // part of the key. This list is server-rendered whole and never reordered.
          <li key={`${item.href}-${index}`} className="flex items-center gap-1.5">
            {index > 0 ? (
              <ChevronRight
                aria-hidden="true"
                className={cn("h-3.5 w-3.5 shrink-0", SEPARATOR_CLASS[tone])}
              />
            ) : null}

            {index === lastIndex ? (
              <span aria-current="page" className={CURRENT_CLASS[tone]}>
                {item.name}
              </span>
            ) : (
              <Link href={item.href} className={LINK_CLASS[tone]}>
                {item.name}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The same trail as schema.org `BreadcrumbList`.
 *
 * Exported separately from the component so a page that renders its crumbs somewhere unusual (inside
 * a sticky sub-header, say) can still emit the structured data from the one array.
 */
export function breadcrumbTrailJsonLd(items: readonly BreadcrumbItem[]): Record<string, unknown> {
  return breadcrumbJsonLd(items.map((item) => ({ name: item.name, path: item.href })));
}

/**
 * The `<script type="application/ld+json">` for a trail.
 *
 * ⚠ `serializeJsonLd` — never `JSON.stringify` — because a stored title containing `</script>` would
 * otherwise close the element early and everything after it would be parsed as HTML (lib/seo.ts).
 *
 * EMIT IT ONCE PER PAGE. Two BreadcrumbList blocks on one document is a structured-data warning and
 * leaves a crawler to guess which trail is true. `PageHero` already emits this when it is given
 * `breadcrumbs`, so a page using the hero must not render it a second time.
 */
export function BreadcrumbJsonLd({ items }: { items: readonly BreadcrumbItem[] }) {
  if (items.length === 0) return null;

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbTrailJsonLd(items)) }}
    />
  );
}
