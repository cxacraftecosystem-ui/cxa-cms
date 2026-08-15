import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, badRequest, conflict, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { mutateWithHistory } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { canManageStructure } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";

/**
 * Reordering one menu, without touching what any item says.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS ALONGSIDE `PUT /api/studio/navigation`. That endpoint replaces the menus by DESCRIPTION
 * — every label and destination crosses the wire and every row is created anew, which also means every
 * row gets a new id. That is right for a save from the editor, and wrong for a drag: a reorder that
 * changed thirty ids would invalidate every reference to them and rewrite thirty audit payloads to record
 * a change of position.
 *
 * So this endpoint moves EXISTING rows by id. It changes `position` and `parentId` and nothing else.
 *
 * ⚠ THE WHOLE ORDERED SET IS REWRITTEN IN ONE TRANSACTION — the same rule as page sections, and for the
 * same reason. `NavigationItem` has no unique index on (location, position), so nothing in the database
 * would catch two rows claiming position 3; and N independent updates mean a failure part-way leaves an
 * order nobody chose. The body must therefore name EVERY item in the location, and a set that is missing
 * one is refused rather than half-applied.
 *
 * ⚠ A PARENT CYCLE IS REFUSED. An item that is its own ancestor makes `getNavigation()`'s tree builder
 * recurse forever — the site's header would hang rather than render. The database does not forbid it (the
 * self-relation has no such constraint), the reorder gesture can express it, and this is the only place
 * that can stop it. Depth is also capped at two, because the shape the editor and the renderers use
 * cannot show a third level.
 *
 * SIBLING ORDER IS THE ARRAY ORDER. `position` is not sent: it is the index among the items that share a
 * `parentId`, computed here. A client that sent positions could send a set with two 3s and no 4, and the
 * server would have to decide what that meant.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const LOCATIONS = ["header", "footer", "utility"] as const;
type NavLocation = (typeof LOCATIONS)[number];

/** ⚠ Must match `MAX_ITEMS` in `app/api/studio/navigation/route.ts` and `LOCATION_META` in the editor. */
const MAX_ITEMS: Record<NavLocation, number> = { header: 8, footer: 12, utility: 6 };
const MAX_CHILDREN = 12;

/** A safety bound on one request. A menu larger than this is a menu with a different problem. */
const MAX_ITEMS_PER_REQUEST = 200;

const OrderBody = z.object({
  location: z.enum(LOCATIONS),
  items: z
    .array(
      z.object({
        id: z.string().trim().min(1, "Every item needs its id.").max(64),
        /** `null` for a top-level item. A missing key is not the same thing, so it is required. */
        parentId: z.string().trim().max(64).nullable()
      })
    )
    .min(1, "Send every item in the menu, in the order you want them.")
    .max(MAX_ITEMS_PER_REQUEST, `At most ${MAX_ITEMS_PER_REQUEST} items can be reordered in one request.`)
});

export const PATCH = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageStructure,
    "Rearranging the menus needs editor access or higher. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, OrderBody);
  const location: NavLocation = body.location;

  /** Every stored row for this location. The reorder is checked against reality, not against the body. */
  const stored = await prisma.navigationItem.findMany({
    where: { location },
    select: { id: true, label: true, parentId: true, position: true },
    orderBy: [{ position: "asc" }, { label: "asc" }]
  });

  const storedIds = new Set(stored.map((row) => row.id));
  const sentIds = new Set<string>();

  for (const item of body.items) {
    if (sentIds.has(item.id)) {
      throw badRequest(
        "One menu item was sent twice. Each item appears exactly once, and its place in the list is its position."
      );
    }
    sentIds.add(item.id);
    if (!storedIds.has(item.id)) {
      /**
       * A 409 rather than a 404: the most likely cause is that somebody else removed or re-saved this menu
       * while this screen was open, and "reload and try again" is the answer to that — not "this address
       * does not exist".
       */
      throw conflict(
        "One of the menu items no longer exists. Somebody may have changed this menu while your screen was open. Reload the page and arrange it again — nothing has been moved."
      );
    }
  }

  /**
   * THE SET MUST BE COMPLETE. A partial set would leave the omitted rows on their old positions, which
   * collide with the new ones — and with no unique index to catch it, the menu would render in an order
   * nobody chose and no error would be raised anywhere.
   */
  if (sentIds.size !== stored.length) {
    const missing = stored.filter((row) => !sentIds.has(row.id));
    const named = missing
      .slice(0, 3)
      .map((row) => (row.label.trim().length > 0 ? `“${row.label.trim()}”` : "an item with no words on it"))
      .join(", ");
    throw badRequest(
      `This menu has ${stored.length} ${stored.length === 1 ? "item" : "items"} and ${sentIds.size} ` +
        `${sentIds.size === 1 ? "was" : "were"} sent, so nothing has been moved. Missing: ${named}` +
        `${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}. Reload the page and try again.`
    );
  }

  // ── The proposed tree, checked before anything is written ──────────────────────────────────────

  const parentOf = new Map<string, string | null>();
  for (const item of body.items) parentOf.set(item.id, item.parentId);

  for (const item of body.items) {
    if (item.parentId === null) continue;

    if (item.parentId === item.id) {
      throw badRequest(
        "A menu item cannot be filed underneath itself. Nothing has been moved."
      );
    }
    if (!parentOf.has(item.parentId)) {
      throw badRequest(
        "One item was filed underneath something that is not in this menu. Nothing has been moved."
      );
    }

    /**
     * WALK THE ANCESTORS. `seen` is what turns an infinite loop into a refusal: without it a cycle would
     * spin here instead of spinning in the site's header, which is not an improvement.
     */
    const seen = new Set<string>([item.id]);
    let cursor: string | null = item.parentId;
    let depth = 1;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw badRequest(
          "That arrangement makes a menu item its own parent, which the site's menu could not draw — it would go round forever. Nothing has been moved."
        );
      }
      seen.add(cursor);
      depth += 1;
      if (depth > 2) {
        throw badRequest(
          "Menus on this site are two levels deep. One of these items would end up three levels down, where no menu can show it. Move its entries out first — nothing has been moved."
        );
      }
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  // ── Positions: the index among siblings, in the order they were sent ───────────────────────────

  const nextPosition = new Map<string, number>();
  const updates: { id: string; parentId: string | null; position: number }[] = [];
  const childCounts = new Map<string, number>();
  let topLevel = 0;

  for (const item of body.items) {
    const key = item.parentId ?? "";
    const position = nextPosition.get(key) ?? 0;
    nextPosition.set(key, position + 1);
    updates.push({ id: item.id, parentId: item.parentId, position });

    if (item.parentId === null) {
      topLevel += 1;
    } else {
      childCounts.set(item.parentId, (childCounts.get(item.parentId) ?? 0) + 1);
    }
  }

  if (topLevel > MAX_ITEMS[location]) {
    throw badRequest(
      `The ${location} menu holds at most ${MAX_ITEMS[location]} items, and that arrangement has ${topLevel}. Nothing has been moved.`
    );
  }
  for (const [parentId, count] of childCounts) {
    if (count > MAX_CHILDREN) {
      const parent = stored.find((row) => row.id === parentId);
      throw badRequest(
        `“${parent?.label ?? "One item"}” would hold ${count} entries underneath it, and the most a submenu can show is ${MAX_CHILDREN}. Nothing has been moved.`
      );
    }
  }

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "UPDATE",
      entityType: "Navigation",
      entityLabel: `The ${location} menu was rearranged`,
      /**
       * NO REVISION. Nothing about any item's content changed — only where it sits — so a revision here
       * would be an identical second copy of a state that already has one from the last real save. The
       * audit entry carries the before and after order, which is what somebody putting a drag right
       * actually needs.
       */
      revise: false,
      before: { location, order: stored.map((row) => ({ id: row.id, parentId: row.parentId, position: row.position })) }
    },
    async (tx) => {
      /**
       * ONE TRANSACTION, EVERY ROW. A parent's `parentId` is set in the same statement batch as its
       * children's, so there is no instant at which the tree is inconsistent — and a failure anywhere
       * rolls the whole arrangement back to the order that was there before.
       */
      for (const update of updates) {
        await tx.navigationItem.update({
          where: { id: update.id },
          data: { parentId: update.parentId, position: update.position },
          select: { id: true }
        });
      }
      return { id: "navigation", location, moved: updates.length };
    }
  );

  const rows = await prisma.navigationItem.findMany({
    where: { location },
    select: { id: true, label: true, href: true, parentId: true, position: true, isVisible: true, isExternal: true },
    orderBy: [{ position: "asc" }, { label: "asc" }]
  });

  return ok({
    location,
    items: rows,
    moved: updates.length,
    message: `The ${location} menu has been rearranged. The site shows the new order straight away.`
  });
});
