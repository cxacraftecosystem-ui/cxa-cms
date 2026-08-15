import type { Metadata } from "next";

import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canManageStructure } from "@/lib/permissions";
import { livePublishableWhere } from "@/lib/content";
import { pagePath } from "@/lib/pages";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { NavigationEditor, type NavItemDraft, type NavLocation, type NavigationDraft } from "./NavigationEditor";

/**
 * The menus: the site header, the footer, and the small utility bar above them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageStructure)` IS THE FIRST STATEMENT, and it is the same predicate the
 * `/api/studio/navigation` handler calls and the same one `StudioNav` hides the sidebar entry with. It
 * THROWS rather than rendering (contract §1.8). Navigation changes the shape of the whole site, so it is
 * an editor's job and above.
 *
 * THE BROKEN-LINK CHECK IS ANSWERED ONCE, HERE, AND HANDED DOWN. Every published page's path is one small
 * query; asking a lookup endpoint per menu entry would be twenty requests on first paint for a warning
 * that has to be visible before anybody opens a row. The editor does the comparing, because it also has
 * to re-check as an address is typed.
 *
 * A THIRD LEVEL IS FLATTENED, AND THE SCREEN SAYS SO. `NavigationItem` is a self-relation with no depth
 * limit, so a row three levels down is possible in the database even though the editor cannot create one —
 * from an import, or from an older release. Those entries are lifted to level two rather than dropped:
 * silently discarding a menu item on load would delete it the next time anybody pressed Save.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Navigation"
};

/**
 * The three locations, written out here rather than imported from the editor.
 *
 * ⚠ `NAV_LOCATIONS` is exported from a `"use client"` module, so importing it into this Server Component
 * would give a client reference rather than an array — the trap MediaGrid.tsx sets out. The TYPE crosses
 * the boundary safely (types are erased), so the two lists cannot disagree about which words are legal
 * even though the array is written twice.
 */
const LOCATIONS: readonly NavLocation[] = ["header", "footer", "utility"];

function isLocation(value: string): value is NavLocation {
  return (LOCATIONS as readonly string[]).includes(value);
}

interface NavRow {
  id: string;
  location: string;
  label: string;
  href: string;
  parentId: string | null;
  position: number;
  isExternal: boolean;
  isVisible: boolean;
}

export default async function StudioNavigationPage() {
  await requireStudioCapability(
    canManageStructure,
    "Editing the menus needs editor access or higher. An administrator can raise yours."
  );

  const [rows, livePages] = await prisma.$transaction([
    prisma.navigationItem.findMany({
      select: {
        id: true,
        location: true,
        label: true,
        href: true,
        parentId: true,
        position: true,
        isExternal: true,
        isVisible: true
      },
      // A total ordering, so two renders of the same data produce the same menu. `position` alone is not
      // total — nothing stops two rows sharing one — and an unstable sort reads as items swapping places
      // on their own.
      orderBy: [{ position: "asc" }, { label: "asc" }]
    }),
    prisma.page.findMany({ where: livePublishableWhere(), select: { slug: true } })
  ]);

  const byId = new Map<string, NavRow>(rows.map((row) => [row.id, row]));
  const childrenOf = new Map<string, NavRow[]>();
  const roots: NavRow[] = [];

  /**
   * Walk up to the nearest row with no parent, so a grandchild is filed under its GRANDPARENT rather than
   * being lost. The hop count is bounded, because a cycle in a self-relation (which the database does not
   * forbid) would otherwise be an infinite loop inside a page render.
   */
  function topAncestorOf(row: NavRow): NavRow | null {
    let current: NavRow | undefined = row;
    for (let hops = 0; hops < 8 && current; hops += 1) {
      if (current.parentId === null) return current;
      current = byId.get(current.parentId);
    }
    return null;
  }

  let flattenedGrandchildren = 0;

  for (const row of rows) {
    if (row.parentId === null) {
      roots.push(row);
      continue;
    }
    const parent = byId.get(row.parentId);
    if (!parent) {
      // An orphan: its parent has been deleted, and Prisma's cascade should have taken it too. Treated as
      // a top-level item rather than dropped, so nothing disappears without anybody being told.
      roots.push(row);
      continue;
    }
    if (parent.parentId !== null) {
      const ancestor = topAncestorOf(row);
      if (ancestor) {
        flattenedGrandchildren += 1;
        const bucket = childrenOf.get(ancestor.id) ?? [];
        bucket.push(row);
        childrenOf.set(ancestor.id, bucket);
        continue;
      }
      // No reachable ancestor — a cycle. Lifted to the top level so it is visible and fixable.
      roots.push(row);
      continue;
    }
    const bucket = childrenOf.get(parent.id) ?? [];
    bucket.push(row);
    childrenOf.set(parent.id, bucket);
  }

  function toDraft(row: NavRow, children: readonly NavRow[]): NavItemDraft {
    return {
      // The stored id is the row's stable key, so React reuses its DOM when it moves.
      key: row.id,
      label: row.label,
      href: row.href,
      isExternal: row.isExternal,
      isVisible: row.isVisible,
      children: children.map((child) => ({
        key: child.id,
        label: child.label,
        href: child.href,
        isExternal: child.isExternal,
        isVisible: child.isVisible,
        children: []
      }))
    };
  }

  const navigation: NavigationDraft = { header: [], footer: [], utility: [] };
  let strayLocations = 0;

  for (const root of roots) {
    if (!isLocation(root.location)) {
      // A location this build does not know about. Counted and reported rather than silently kept, because
      // a Save would rewrite the three known menus and leave this row stranded and invisible.
      strayLocations += 1;
      continue;
    }
    navigation[root.location].push(toDraft(root, childrenOf.get(root.id) ?? []));
  }

  const livePagePaths = livePages.map((page) => pagePath(page.slug));

  return (
    <div className="mx-auto w-full max-w-[84rem]">
      <StudioPageHeader
        title="Navigation"
        description="The menus a visitor uses to find their way around: the main menu across the top, the links at the foot of every page, and the small strip above the header. A menu with nothing in it is left off the site rather than shown as a blank strip."
      />

      {flattenedGrandchildren > 0 ? (
        <HelpText tone="warn" className="mt-5">
          {flattenedGrandchildren === 1
            ? "1 menu entry was stored three levels deep, which no menu on this site can show."
            : `${flattenedGrandchildren} menu entries were stored three levels deep, which no menu on this site can show.`}{" "}
          They are shown here at the second level, under the item they belong to. Saving will store them
          that way — check they are where you want them first.
        </HelpText>
      ) : null}

      {strayLocations > 0 ? (
        <HelpText tone="warn" className="mt-5">
          {strayLocations === 1
            ? "1 menu item is filed under a menu this version of the studio does not have, so it is not shown below."
            : `${strayLocations} menu items are filed under a menu this version of the studio does not have, so they are not shown below.`}{" "}
          Saving these menus will remove them. Ask whoever imported the data before you save if that is not
          what you want.
        </HelpText>
      ) : null}

      <NavigationEditor navigation={navigation} livePagePaths={livePagePaths} />
    </div>
  );
}
