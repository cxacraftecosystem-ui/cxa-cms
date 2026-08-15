import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import {
  DEFAULT_FOOTER,
  DEFAULT_HEADER,
  withSyntheticIds,
  type NavNode,
  type SiteNavigation
} from "@/lib/navigation";

/**
 * Reading the navigation tree out of the database.
 *
 * SPLIT FROM `lib/navigation.ts` DELIBERATELY. That module is imported by the site header, which is
 * a CLIENT component (it owns the mobile sheet, the scroll-collapse and the active-route highlight),
 * and by `prisma/seed.ts`, which is a plain Node script. Neither can import anything carrying
 * `import "server-only"` — the seed would throw on the import itself, and the header would fail the
 * build. So the shapes, the defaults and the pure active-route resolution live there; the query
 * lives here.
 */

/**
 * Read the whole menu in ONE query and assemble the tree in memory.
 *
 * A recursive query per level would be three round trips for a two-level menu, on every page. The
 * tree is small enough that assembling it here is free, and doing it in one place means the header,
 * the footer and the mobile sheet cannot disagree about what the menu is.
 */
export const getNavigation = cache(async (): Promise<SiteNavigation> => {
  /**
   * An unreachable database yields NO ROWS, which this function already knows how to handle: the
   * fallbacks below take over and the site renders its shipped default menu.
   *
   * That path exists for a fresh installation, and the two situations want the same answer — a header
   * with links in it. The difference matters because `getNavigation` is called by the SITE LAYOUT, so it
   * runs for every page the build renders: a throw here failed the whole build on whichever page Next
   * happened to prerender first, which is why the failure kept appearing to move between pages.
   *
   * ⚠ IT DOES NOT MASK A RUNTIME OUTAGE. A page that also reads content still fails on that query and
   * returns a 500 as it should; this only stops the MENU from being what decides it.
   */
  const rows = await prisma.navigationItem
    .findMany({
      where: { isVisible: true },
      orderBy: [{ position: "asc" }, { label: "asc" }]
    })
    .catch((error: unknown) => {
      console.error(
        "[navigation] the menu could not be read, so the shipped default is being used. " +
          `Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      return [] as Awaited<ReturnType<typeof prisma.navigationItem.findMany>>;
    });

  const byLocation: Record<string, NavNode[]> = { header: [], footer: [], utility: [] };
  const nodes = new Map<string, NavNode>();

  // Two passes. The first materialises every node so a child can find its parent regardless of the
  // order rows came back in — ordering by position does NOT guarantee a parent precedes its child.
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      label: row.label,
      href: row.href,
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
});

