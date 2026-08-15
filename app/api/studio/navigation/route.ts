import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { canManageStructure } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";

/**
 * The menus: the site header, the footer columns and the small utility bar.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WHOLE MENU SYSTEM IS WRITTEN IN ONE TRANSACTION, AND THAT IS THE DESIGN.
 *
 * `NavigationItem` has NO unique index on (location, position) — unlike `PageSection`, which does. So
 * nothing in the database would stop two rows claiming position 3, and nothing would stop a child
 * pointing at a parent that a half-finished save had already removed. A per-item endpoint would make
 * both of those reachable through an ordinary failed request.
 *
 * So a save replaces the ordered set whole: every row for every location is deleted and the tree is
 * written again from the body, inside one transaction. Either the menus changed or nothing moved. There
 * is no state in which the header is half of what the editor showed.
 *
 * ⚠ ALL THREE LOCATIONS ARE REQUIRED IN THE BODY. A partial body would wipe whichever menu it omitted,
 * which is exactly the accident a full replace invites — so an omitted key is a 422 rather than an empty
 * header on every page of the site.
 *
 * ⚠ ROWS IN AN UNKNOWN LOCATION ARE REMOVED, and the response counts them. The navigation screen already
 * warns an administrator that this will happen ("Saving these menus will remove them") — a route that
 * quietly preserved them would make that sentence a lie in the other direction, and the administrator who
 * asked for them to go would find them still there. The count is reported so the removal is never silent.
 *
 * TWO LEVELS, AND NO MORE. A third level in a header menu is a level nobody finds, and it is precisely
 * the level a CMS lets an administrator create by accident (lib/navigation.ts says the same). The body
 * shape here cannot express one: a child has no `children`.
 *
 * A PARENT CYCLE IS IMPOSSIBLE BY SHAPE HERE — parents are created before their children and no id
 * crosses the wire, so there is nothing to point at. The cycle check that matters lives in
 * `navigation/order/route.ts`, which DOES move existing rows by id, and where an item made its own
 * ancestor would send `getNavigation()`'s tree builder round forever.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `canManageStructure` — editor and above, the same predicate the navigation screen renders behind.
 * Navigation changes the shape of the whole site, so it is not an author's job.
 */

export const dynamic = "force-dynamic";

/**
 * The three locations. Written out here rather than imported from `NavigationEditor`, which is a
 * `"use client"` module — every one of its exports is a client reference, so importing the array into a
 * route handler would hand back a reference rather than three strings.
 */
const LOCATIONS = ["header", "footer", "utility"] as const;
type NavLocation = (typeof LOCATIONS)[number];

/**
 * How many top-level items each menu holds.
 *
 * ⚠ THESE MUST MATCH `LOCATION_META` IN `app/studio/navigation/NavigationEditor.tsx`. They cannot be
 * shared (see above), and a cap here that is tighter than the editor's would let somebody build a menu
 * the form accepts and the save refuses — which reads as a broken Save button. Both numbers are printed
 * on screen beside the list, per contract §1.6.
 */
const MAX_ITEMS: Record<NavLocation, number> = { header: 8, footer: 12, utility: 6 };

/** How many entries one item may hold underneath it. A longer list is a page, not a menu. */
const MAX_CHILDREN = 12;

const LABEL_MAX = 60;
const HREF_MAX = 500;

const HTTP_SCHEMES = /^https?:\/\//i;

/**
 * Where a menu item may point.
 *
 * A POSITIVE allow-list, and that is the whole security of this field: these values are rendered
 * straight into an `href`, and `new URL()` parses `javascript:` and `data:` perfectly happily. Anything
 * that is not one of the five shapes below is refused.
 *
 * ⚠ `//evil.example` IS REFUSED EXPLICITLY. It starts with a slash, so a naive "must start with /" test
 * accepts it — and a browser reads it as a protocol-relative link to another host. A menu item on the
 * institution's own header that navigates to somebody else's site is an open redirect with the Centre's
 * name on it.
 */
const navHref = z
  .string()
  .trim()
  .min(1, "A menu item needs a destination, or pressing it would do nothing.")
  .max(HREF_MAX, `Keep a destination to ${HREF_MAX} characters or fewer.`)
  .refine((value) => !value.startsWith("//"), {
    message:
      "A destination beginning with // points at another website without saying so. Write the full address with https:// if that is what you meant."
  })
  .refine(
    (value) =>
      value.startsWith("/") ||
      value.startsWith("#") ||
      value.startsWith("mailto:") ||
      value.startsWith("tel:") ||
      HTTP_SCHEMES.test(value),
    { message: "A destination must start with /, #, https://, mailto: or tel:." }
  );

const NavChildBody = z.object({
  label: z
    .string()
    .trim()
    .min(1, "A menu item needs words on it, or it would be invisible on the site.")
    .max(LABEL_MAX, `Keep the words on a menu item to ${LABEL_MAX} characters or fewer.`),
  href: navHref,
  isExternal: z.boolean().default(false),
  isVisible: z.boolean().default(true)
});

const NavItemBody = NavChildBody.extend({
  children: z
    .array(NavChildBody)
    .max(MAX_CHILDREN, `An item holds at most ${MAX_CHILDREN} entries underneath it.`)
    .default([])
});

/** Every location is REQUIRED — see the header. */
const NavigationBody = z.object({
  locations: z.object({
    header: z
      .array(NavItemBody)
      .max(MAX_ITEMS.header, `The header holds at most ${MAX_ITEMS.header} items before it wraps onto two lines.`),
    footer: z.array(NavItemBody).max(MAX_ITEMS.footer, `The footer holds at most ${MAX_ITEMS.footer} items.`),
    utility: z
      .array(NavItemBody)
      .max(MAX_ITEMS.utility, `The utility bar holds at most ${MAX_ITEMS.utility} items.`)
  })
});

/**
 * The audit entity for a whole-menu save.
 *
 * `mutateWithHistory()` wants a row with an `id`, and this write touches many rows rather than one — the
 * same mismatch `setSetting()` describes for `Setting`, whose key is not an id. A stable synthetic id is
 * used instead of inventing a per-row audit trail: what an administrator wants to see in the log is "the
 * menus were changed, here is what they were and what they are now", not thirty deletions and thirty
 * creations they have to reassemble by hand.
 */
const NAVIGATION_ENTITY_TYPE = "Navigation";
const NAVIGATION_ENTITY_ID = "navigation";

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

const navSelect = {
  id: true,
  location: true,
  label: true,
  href: true,
  parentId: true,
  position: true,
  isExternal: true,
  isVisible: true
} as const;

/**
 * Deliberately NOT exported. A `route.ts` is type-checked by Next against a fixed set of allowed exports,
 * and nothing imports this shape — the client that renders it has its own.
 */
interface StudioNavNode {
  id: string;
  label: string;
  href: string;
  isExternal: boolean;
  isVisible: boolean;
  position: number;
  children: StudioNavNode[];
}

/**
 * Assemble the stored rows into the three trees.
 *
 * TWO PASSES, because ordering by `position` does NOT guarantee a parent arrives before its child — the
 * same reason `lib/navigation-server.ts` does it this way. A child whose parent is missing is promoted to
 * the top level rather than dropped: silently losing a destination is worse than showing it one level
 * higher than intended, and the studio can then see it and fix it.
 *
 * A row nested THREE levels deep (possible from an import, since the self-relation has no depth limit) is
 * lifted to the second level under its nearest top-level ancestor, and counted so the caller can say so.
 */
function buildTrees(rows: readonly NavRow[]): {
  locations: Record<NavLocation, StudioNavNode[]>;
  flattened: number;
  stranded: { location: string; count: number }[];
} {
  const nodes = new Map<string, StudioNavNode>();
  const byId = new Map<string, NavRow>();
  for (const row of rows) {
    byId.set(row.id, row);
    nodes.set(row.id, {
      id: row.id,
      label: row.label,
      href: row.href,
      isExternal: row.isExternal,
      isVisible: row.isVisible,
      position: row.position,
      children: []
    });
  }

  /** Bounded, because a cycle in the self-relation is not forbidden by the database. */
  function topAncestorOf(row: NavRow): NavRow | null {
    let current: NavRow | undefined = row;
    for (let hops = 0; hops < 8 && current; hops += 1) {
      if (current.parentId === null) return current;
      current = byId.get(current.parentId);
    }
    return null;
  }

  const locations: Record<NavLocation, StudioNavNode[]> = { header: [], footer: [], utility: [] };
  const strayCounts = new Map<string, number>();
  let flattened = 0;

  const roots: NavRow[] = [];
  const childrenOf = new Map<string, NavRow[]>();

  for (const row of rows) {
    if (row.parentId === null) {
      roots.push(row);
      continue;
    }
    const parent = byId.get(row.parentId);
    if (!parent) {
      roots.push(row);
      continue;
    }
    if (parent.parentId !== null) {
      const ancestor = topAncestorOf(row);
      if (!ancestor) {
        // No reachable top-level ancestor — a cycle. Lifted so it is visible and fixable.
        roots.push(row);
        continue;
      }
      flattened += 1;
      const bucket = childrenOf.get(ancestor.id) ?? [];
      bucket.push(row);
      childrenOf.set(ancestor.id, bucket);
      continue;
    }
    const bucket = childrenOf.get(parent.id) ?? [];
    bucket.push(row);
    childrenOf.set(parent.id, bucket);
  }

  for (const root of roots) {
    const node = nodes.get(root.id);
    if (!node) continue;
    for (const child of childrenOf.get(root.id) ?? []) {
      const childNode = nodes.get(child.id);
      if (childNode) node.children.push(childNode);
    }
    if (!isLocation(root.location)) {
      strayCounts.set(root.location, (strayCounts.get(root.location) ?? 0) + 1 + node.children.length);
      continue;
    }
    locations[root.location].push(node);
  }

  return {
    locations,
    flattened,
    stranded: [...strayCounts.entries()].map(([location, count]) => ({ location, count }))
  };
}

function isLocation(value: string): value is NavLocation {
  return (LOCATIONS as readonly string[]).includes(value);
}

/** Read every row, in a total order so two reads of the same data give the same menu. */
async function readAll(client: TxClient = prisma): Promise<NavRow[]> {
  return client.navigationItem.findMany({
    select: navSelect,
    orderBy: [{ position: "asc" }, { label: "asc" }]
  });
}

export const GET = route(async () => {
  await requireCapability(
    canManageStructure,
    "Editing the menus needs editor access or higher. An administrator can raise yours."
  );

  const rows = await readAll();
  const { locations, flattened, stranded } = buildTrees(rows);

  return ok({
    locations,
    /** The caps, so a client prints the same numbers this route enforces (contract §1.6). */
    limits: { items: MAX_ITEMS, childrenPerItem: MAX_CHILDREN, labelMax: LABEL_MAX, hrefMax: HREF_MAX },
    /** Both of these are facts a menu editor must state on screen rather than absorb quietly. */
    flattenedGrandchildren: flattened,
    strandedLocations: stranded,
    itemCount: rows.length
  });
});

const handleReplace = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageStructure,
    "Editing the menus needs editor access or higher. An administrator can raise yours."
  );

  /**
   * `parseStudioJson`, not `parseJson`.
   *
   * The schema carries `.default()` on `isExternal`, `isVisible` and `children`, so its Zod INPUT and OUTPUT
   * types differ — and `parseJson`'s signature pins both to one `T`, which makes TypeScript infer the input
   * and type every defaulted field as possibly absent. The wrapper in lib/studio/crud.ts keeps the runtime
   * behaviour identical and takes its generic over the schema instead, so the values arrive as Zod actually
   * produced them: filled in.
   */
  const body = await parseStudioJson(request, NavigationBody);

  /**
   * The `before` snapshot for the audit entry, read before the transaction opens.
   *
   * A concurrent save between this read and the write would make `before` a moment stale. That is
   * acceptable for an audit snapshot and is not acceptable for the write itself — which is why the write
   * below does its own `deleteMany` inside the transaction rather than trusting anything read here.
   */
  const existing = await readAll();
  const { locations: locationsBefore, stranded: strandedBefore } = buildTrees(existing);

  const result = await mutateWithHistory<{ id: string; itemCount: number }>(
    buildAuditContext(request, user),
    {
      action: "UPDATE",
      entityType: NAVIGATION_ENTITY_TYPE,
      entityLabel: "Site menus",
      // A REVISION IS WRITTEN. The whole menu system is small and a snapshot of it is genuinely
      // restorable — "put the header back to how it was on Tuesday" is a real request, and without a
      // revision the only record would be an audit payload nobody can replay.
      summary: "The site menus were saved",
      before: { locations: locationsBefore }
    },
    async (tx) => {
      /**
       * EVERY ROW, not only the three known locations. See the header: the navigation screen tells the
       * administrator that items filed under an unknown menu will be removed by a save, and the route has
       * to mean it. `strandedLocations` in the response says how many went.
       */
      await tx.navigationItem.deleteMany({});

      let itemCount = 0;
      for (const location of LOCATIONS) {
        const items = body.locations[location];
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (!item) continue;
          // The parent first, so its id exists for the children. `select` narrows the row to the one
          // column needed — there is nothing else here worth carrying into the audit payload.
          const parent = await tx.navigationItem.create({
            data: {
              location,
              label: item.label,
              href: item.href,
              isExternal: item.isExternal,
              isVisible: item.isVisible,
              position: index,
              parentId: null
            },
            select: { id: true }
          });
          itemCount += 1;

          for (let childIndex = 0; childIndex < item.children.length; childIndex += 1) {
            const child = item.children[childIndex];
            if (!child) continue;
            await tx.navigationItem.create({
              data: {
                location,
                label: child.label,
                href: child.href,
                isExternal: child.isExternal,
                isVisible: child.isVisible,
                position: childIndex,
                parentId: parent.id
              },
              select: { id: true }
            });
            itemCount += 1;
          }
        }
      }

      return { id: NAVIGATION_ENTITY_ID, itemCount, locations: body.locations };
    }
  );

  const rows = await readAll();
  const { locations } = buildTrees(rows);

  return ok({
    locations,
    itemCount: result.itemCount,
    /**
     * What was removed that the body did not describe. Reported rather than assumed: an administrator who
     * ignored the warning on screen should at least find the number in the answer.
     */
    removedFromUnknownLocations: strandedBefore,
    message:
      result.itemCount === 0
        ? "The menus have been saved, and every one of them is now empty. An empty menu is left off the site rather than shown as a blank strip."
        : `The menus have been saved — ${result.itemCount} ${result.itemCount === 1 ? "item" : "items"} across the header, the footer and the utility bar.`
  });
});

/**
 * PUT is what the navigation screen sends, and it is the honest verb: this replaces the menus rather than
 * merging into them. PATCH is accepted for the same reason the settings route accepts both — the write is
 * identical and a 405 over the spelling helps nobody.
 */
export const PUT = handleReplace;
export const PATCH = handleReplace;
