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

/**
 * `import type`, NOT a value import, and that is load-bearing rather than a style choice.
 *
 * This module is imported by `prisma/seed.ts`, which is a plain Node script (lib/navigation-server.ts
 * states that constraint in its own header and splits itself from this file over it). A value import
 * would make every run of the seed load `lucide-react` — a React package — to read a list of labels and
 * hrefs. A type-only import is erased at compile time, so nothing but the type crosses.
 */
import type { LucideIcon } from "lucide-react";

import { safeHref } from "@/lib/safe-href";

export interface NavNode {
  id: string;
  label: string;
  href: string;
  isExternal: boolean;
  /**
   * A glyph drawn beside the label — the ONE field on this type that is not a column in the database.
   *
   * It exists because the Centre's social accounts are rendered as CHILDREN OF THE CONTACT ENTRY
   * rather than as a menu of their own (`socialNavChildren`, lib/socials.ts, hung on the tree by
   * `withSocialsUnderContact`, components/site/SiteHeader.tsx). Those rows want their platform's glyph
   * — that is what makes a social row recognisable at a glance, and it is the same glyph the footer and
   * /contact already draw, resolved once in lib/socials.ts. Every other entry leaves this undefined and
   * renders exactly as it always has.
   *
   * ⚠ SYNTHESISED ON THE CLIENT, NEVER READ FROM THE DATABASE, AND IT CANNOT BE OTHERWISE. The value is
   * a React component, and `SiteHeader` is a Client Component that receives its `items` as props from a
   * Server Component (`app/(site)/layout.tsx`). A server that set this field would hand a FUNCTION
   * across the serialization boundary — "Functions cannot be passed directly to Client Components" —
   * and take the whole site down with it. `getNavigation` (lib/navigation-server.ts) and
   * `withSyntheticIds` below both leave it unset, and must continue to.
   */
  icon?: LucideIcon;
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

/** The columns `assembleNavigation` reads from a `NavigationItem` row. */
export interface NavigationRow {
  id: string;
  label: string;
  href: string;
  isExternal: boolean;
  parentId: string | null;
  location: string;
}

/**
 * The visible rows, in menu order, as the tree the header and footer draw. It lives here, not beside
 * the query in lib/navigation-server.ts, so the read-time href filter below can be tested without a
 * database.
 */
export function assembleNavigation(rows: readonly NavigationRow[]): SiteNavigation {
  const byLocation: Record<string, NavNode[]> = { header: [], footer: [], utility: [] };
  const nodes = new Map<string, NavNode>();

  // Two passes. The first materialises every node so a child can find its parent regardless of the
  // order rows came back in — ordering by position does NOT guarantee a parent precedes its child.
  for (const row of rows) {
    // Re-checked on READ, with the same rule the studio route applies on save (lib/safe-href.ts): a row
    // written before that rule existed — or straight into the table — may hold `//evil.example` or
    // `/\evil.example`, which the header would render through `next/link` as an internal link that
    // leaves the site. Such a row is left out, and its children are promoted as for a hidden parent.
    const href = safeHref(row.href);
    if (href === null) {
      console.error(`[navigation] the menu item "${row.label}" has an unusable destination, so it was left out.`);
      continue;
    }
    nodes.set(row.id, {
      id: row.id,
      label: row.label,
      href,
      isExternal: row.isExternal,
      children: []
    });
  }

  for (const row of rows) {
    const node = nodes.get(row.id);
    if (!node) continue;
    if (row.parentId) {
      const parent = nodes.get(row.parentId);
      // A child whose parent is hidden or missing is promoted to the top level rather than dropped.
      // Silently losing a destination is worse than showing it one level higher than intended.
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    (byLocation[row.location] ??= []).push(node);
  }

  return {
    header: byLocation.header?.length ? byLocation.header : withSyntheticIds(DEFAULT_HEADER, "d-h"),
    footer: byLocation.footer?.length ? byLocation.footer : withSyntheticIds(DEFAULT_FOOTER, "d-f"),
    utility: byLocation.utility ?? []
  };
}
