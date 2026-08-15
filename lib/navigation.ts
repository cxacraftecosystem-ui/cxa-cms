/**
 * Site navigation — DATA, not code.
 *
 * `location` separates the header, the footer columns and the utility bar so one editor screen
 * drives every menu on the site. The tree is at most two levels deep by design: a third level in a
 * header menu is a level nobody finds, and it is the level a CMS lets an administrator create by
 * accident.
 *
 * FALLBACK, NOT EMPTINESS. A fresh installation has no navigation rows, and a site whose header is
 * empty looks broken rather than new. `DEFAULT_HEADER` / `DEFAULT_FOOTER` below are used when the
 * table has nothing for a location, and the seed writes them as real rows on first run so an
 * administrator can immediately edit what they see.
 */

export interface NavNode {
  id: string;
  label: string;
  href: string;
  isExternal: boolean;
  children: NavNode[];
}

export interface SiteNavigation {
  header: NavNode[];
  footer: NavNode[];
  utility: NavNode[];
}

/** A default entry, before the database gives it a real id. Also the shape the seed writes. */
export interface NavSeed {
  label: string;
  href: string;
  isExternal?: boolean;
  children?: NavSeed[];
}

/**
 * The shipped default menu. Order is an editorial claim about what the Centre is: what it studies,
 * who does it, what came out of it, then the archive, then how to reach anyone.
 */
export const DEFAULT_HEADER: NavSeed[] = [
  {
    label: "About",
    href: "/about",
    children: [
      { label: "Vision and mission", href: "/about#vision" },
      { label: "Leadership", href: "/about#leadership" },
      { label: "History", href: "/about#history" }
    ]
  },
  {
    label: "Research",
    href: "/research",
    children: [
      { label: "Research areas", href: "/research" },
      { label: "Projects", href: "/projects" },
      { label: "Publications", href: "/publications" }
    ]
  },
  { label: "People", href: "/people" },
  {
    label: "Archive",
    href: "/craft-explorer",
    children: [
      { label: "Craft Explorer", href: "/craft-explorer" },
      { label: "Gallery", href: "/gallery" }
    ]
  },
  {
    label: "News and events",
    href: "/news",
    children: [
      { label: "Newsroom", href: "/news" },
      { label: "Events", href: "/events" }
    ]
  },
  { label: "Contact", href: "/contact" }
];

export const DEFAULT_FOOTER: NavSeed[] = [
  { label: "About", href: "/about" },
  { label: "Research", href: "/research" },
  { label: "People", href: "/people" },
  { label: "Publications", href: "/publications" },
  { label: "Craft Explorer", href: "/craft-explorer" },
  { label: "Contact", href: "/contact" }
];

/**
 * Give the defaults stable synthetic ids.
 *
 * Stable matters: React keys the menu on these, and an id that changed per render would remount the
 * whole header on every navigation, replaying its entrance animation each time.
 */
export function withSyntheticIds(nodes: NavSeed[], prefix: string): NavNode[] {
  return nodes.map((node, index) => ({
    id: `${prefix}-${index}`,
    label: node.label,
    href: node.href,
    isExternal: node.isExternal ?? false,
    children: (node.children ?? []).map((child, childIndex) => ({
      id: `${prefix}-${index}-${childIndex}`,
      label: child.label,
      href: child.href,
      isExternal: child.isExternal ?? false,
      children: []
    }))
  }));
}

/**
 * Which nav entry is the current page? **Longest base wins.**
 *
 * A bare `pathname.startsWith(href)` marks `/research` and `/research/heritage-ai` at once, and
 * `aria-current="page"` on two links tells a screen reader the reader is in two places. Resolving to
 * the longest matching base gives exactly one answer, and `/projects` plus `/projects?year=2026`
 * both resolve to the same entry — same page, correct.
 *
 * Reuse this for breadcrumbs, tabs and the mobile sheet; three independent implementations of "which
 * one is active" is three chances to disagree.
 */
export function resolveActiveHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const base = href.split("?")[0]?.split("#")[0] ?? "";
    if (!base || base === "#") continue;

    // "/" is the one base a prefix test gets wrong: it prefixes EVERY path, so an unguarded test
    // would light the homepage link on every page of the site. It matches exactly, and nothing else.
    const matches =
      base === "/" ? pathname === "/" : pathname === base || pathname.startsWith(`${base}/`);
    if (!matches) continue;

    if (!best || base.length > best.length) best = base;
  }
  return best;
}

/** True when `href` is the active entry, given the resolved base. */
export function isActiveHref(href: string, activeBase: string | null): boolean {
  if (!activeBase) return false;
  return (href.split("?")[0]?.split("#")[0] ?? "") === activeBase;
}

/** Every href in a tree, flattened — the input to `resolveActiveHref`. */
export function collectHrefs(nodes: NavNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    out.push(node.href);
    out.push(...collectHrefs(node.children));
  }
  return out;
}
