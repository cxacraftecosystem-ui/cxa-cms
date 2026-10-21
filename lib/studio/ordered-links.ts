import { Prisma } from "@prisma/client";

import type { TxClient } from "@/lib/audit";

/**
 * Ordered link rows — an album's pictures, an event's speakers and pictures — written as a SET.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE NOT A LOOP OF `upsert`s. Each one used to delete what had gone and then upsert every
 * remaining row in turn: one statement per row, inside a transaction that holds the parent's row lock for
 * as long as it runs. Twenty-five pictures were twenty-five round trips to the pooler before the save could
 * commit, which is exactly the shape lib/db.ts warns about ("neither replaces keeping the work inside a
 * transaction small").
 *
 * Now every list is THREE statements whatever its length:
 *
 *   1. delete the rows no longer listed (unchanged);
 *   2. `createMany({ skipDuplicates })` — `INSERT … ON CONFLICT DO NOTHING` — adds the rows that are new,
 *      with the same values the upsert's `create` branch wrote;
 *   3. one `UPDATE … FROM (VALUES …)` writes the upsert's `update` branch onto every listed row.
 *
 * Step 3 also touches the rows step 2 has just inserted, writing the values they already hold, so the end
 * state is the one the upsert loop produced row for row. The same `UPDATE … FROM (VALUES …)` form renumbers
 * a people group in app/api/studio/people/reorder/route.ts.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every function takes ids that are already unique and already checked to exist; the callers do both.
 */

/** A nullable `Json` column takes `Prisma.JsonNull`, never a bare `null` (contract §14). */
function jsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

/** A JSON value as a `jsonb` parameter: SQL NULL for nothing, the serialised value otherwise. */
function jsonbParameter(value: unknown): Prisma.Sql {
  if (value === null || value === undefined) return Prisma.sql`NULL::jsonb`;
  return Prisma.sql`${JSON.stringify(value)}::jsonb`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gallery album pictures
// ─────────────────────────────────────────────────────────────────────────────

export interface GalleryItemWrite {
  assetId: string;
  caption: string | null;
  presentation: string;
  tourEntry: string | null;
  /**
   * ⚠ ABSENT AND NULL ARE DIFFERENT. `undefined` leaves a stored framing exactly as it is; `null` clears it
   * ("the panel was cleared"). `assetScreens` is `.nullable().optional()` on the route's item schema, so a
   * caller that sends `items` without the key — a script, a bulk re-order, an older client — must not wipe
   * the per-screen framing off every row in the album while appearing to save a re-order. The events route
   * guards the identical write the same way (`replaceEventMedia`).
   */
  assetScreens?: unknown;
}

/** Delete what has gone, then write what is left with its new position. See the header. */
export async function replaceGalleryItems(
  tx: TxClient,
  albumId: string,
  items: readonly GalleryItemWrite[]
): Promise<void> {
  const keep = items.map((item) => item.assetId);

  // The empty case is spelled out rather than left to `notIn: []`, whose meaning is a detail of the query
  // builder and not something a reader should have to know to see that clearing the list clears the rows.
  if (keep.length === 0) {
    await tx.galleryItem.deleteMany({ where: { albumId } });
    return;
  }

  await tx.galleryItem.deleteMany({ where: { albumId, assetId: { notIn: keep } } });

  await tx.galleryItem.createMany({
    data: items.map((item, index) => ({
      albumId,
      assetId: item.assetId,
      caption: item.caption,
      presentation: item.presentation,
      tourEntry: item.tourEntry,
      position: index,
      ...(item.assetScreens === undefined ? {} : { assetScreens: jsonColumn(item.assetScreens) })
    })),
    skipDuplicates: true
  });

  await tx.$executeRaw(Prisma.sql`
    UPDATE "gallery_items" AS g
       SET "caption" = v."caption",
           "presentation" = v."presentation",
           "tourEntry" = v."tourEntry",
           "position" = v."position",
           "assetScreens" = CASE WHEN v."setScreens" THEN v."assetScreens" ELSE g."assetScreens" END
      FROM (VALUES ${Prisma.join(
        items.map(
          (item, index) =>
            Prisma.sql`(${item.assetId}::text, ${item.caption}::text, ${item.presentation}::text, ${item.tourEntry}::text, ${index}::int, ${item.assetScreens !== undefined}::boolean, ${jsonbParameter(item.assetScreens)})`
        )
      )}) AS v("assetId", "caption", "presentation", "tourEntry", "position", "setScreens", "assetScreens")
     WHERE g."albumId" = ${albumId}
       AND g."assetId" = v."assetId"
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Site menus
// ─────────────────────────────────────────────────────────────────────────────

export interface MenuEntryWrite {
  label: string;
  href: string;
  isExternal: boolean;
  isVisible: boolean;
}

export interface MenuItemWrite extends MenuEntryWrite {
  children: readonly MenuEntryWrite[];
}

/**
 * Write the menus into an EMPTY navigation table (the caller has just deleted every row) and say how many
 * rows that was.
 *
 * Two statements whatever the size of the menus: every top-level item in one `INSERT … RETURNING`, then
 * every child in one `INSERT`, each child pointed at its parent's new id. A parent is unique by its
 * location and position, which is how the returned ids are matched back — never by the order of RETURNING.
 * It was an INSERT per item before, parents and children interleaved.
 */
export async function writeMenus(
  tx: TxClient,
  locations: Readonly<Record<string, readonly MenuItemWrite[]>>
): Promise<number> {
  const key = (location: string, position: number) => `${location}\u0000${position}`;

  const parents = Object.entries(locations).flatMap(([location, items]) =>
    items.map((item, index) => ({
      location,
      label: item.label,
      href: item.href,
      isExternal: item.isExternal,
      isVisible: item.isVisible,
      position: index,
      parentId: null
    }))
  );
  if (parents.length === 0) return 0;

  const created = await tx.navigationItem.createManyAndReturn({
    data: parents,
    select: { id: true, location: true, position: true }
  });
  const parentIdOf = new Map(created.map((row) => [key(row.location, row.position), row.id]));

  const children = Object.entries(locations).flatMap(([location, items]) =>
    items.flatMap((item, index) => {
      const parentId = parentIdOf.get(key(location, index));
      if (parentId === undefined) throw new Error(`The menu item at ${location} #${index} was not written.`);
      return item.children.map((child, childIndex) => ({
        location,
        label: child.label,
        href: child.href,
        isExternal: child.isExternal,
        isVisible: child.isVisible,
        position: childIndex,
        parentId
      }));
    })
  );
  if (children.length > 0) await tx.navigationItem.createMany({ data: children });

  return parents.length + children.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event speakers and pictures
// ─────────────────────────────────────────────────────────────────────────────

/** Speakers, in the order given, keeping the role already recorded against anybody who stays. */
export async function replaceEventSpeakers(
  tx: TxClient,
  eventId: string,
  personIds: readonly string[]
): Promise<void> {
  // The empty case is spelled out rather than left to `notIn: []` — see `replaceGalleryItems`.
  if (personIds.length === 0) {
    await tx.eventSpeaker.deleteMany({ where: { eventId } });
    return;
  }

  await tx.eventSpeaker.deleteMany({ where: { eventId, personId: { notIn: [...personIds] } } });

  await tx.eventSpeaker.createMany({
    data: personIds.map((personId, index) => ({ eventId, personId, position: index })),
    skipDuplicates: true
  });

  // Only the position: `role` is edited elsewhere and must survive a re-order.
  await tx.$executeRaw(Prisma.sql`
    UPDATE "event_speakers" AS s
       SET "position" = v."position"
      FROM (VALUES ${Prisma.join(
        personIds.map((personId, index) => Prisma.sql`(${personId}::text, ${index}::int)`)
      )}) AS v("personId", "position")
     WHERE s."eventId" = ${eventId}
       AND s."personId" = v."personId"
  `);
}

export interface EventFramingWrite {
  assetId: string;
  screens?: unknown;
}

/**
 * Pictures, in the order given, keeping each caption.
 *
 * `framings` is the list from the body or `undefined`. Undefined means the caller said nothing about
 * framing, so a stored one is left exactly as it is — the same distinction `coverScreens` draws between
 * "absent" and "cleared", one level down. A listed picture with no entry in a supplied list is cleared.
 */
export async function replaceEventMedia(
  tx: TxClient,
  eventId: string,
  assetIds: readonly string[],
  framings: readonly EventFramingWrite[] | undefined
): Promise<void> {
  if (assetIds.length === 0) {
    await tx.eventMedia.deleteMany({ where: { eventId } });
    return;
  }

  await tx.eventMedia.deleteMany({ where: { eventId, assetId: { notIn: [...assetIds] } } });

  // `as const` so each pair infers as a TUPLE rather than an array of the union of its two members,
  // which is what `new Map` needs to see.
  const byAsset = new Map(
    (framings ?? []).map((entry) => [entry.assetId, entry.screens ?? null] as const)
  );
  const screensOf = (assetId: string): unknown => byAsset.get(assetId) ?? null;
  const setScreens = framings !== undefined;

  await tx.eventMedia.createMany({
    data: assetIds.map((assetId, index) => ({
      eventId,
      assetId,
      position: index,
      ...(setScreens ? { assetScreens: jsonColumn(screensOf(assetId)) } : {})
    })),
    skipDuplicates: true
  });

  await tx.$executeRaw(Prisma.sql`
    UPDATE "event_media" AS m
       SET "position" = v."position",
           "assetScreens" = CASE WHEN ${setScreens}::boolean THEN v."assetScreens" ELSE m."assetScreens" END
      FROM (VALUES ${Prisma.join(
        assetIds.map(
          (assetId, index) =>
            Prisma.sql`(${assetId}::text, ${index}::int, ${jsonbParameter(setScreens ? screensOf(assetId) : null)})`
        )
      )}) AS v("assetId", "position", "assetScreens")
     WHERE m."eventId" = ${eventId}
       AND m."assetId" = v."assetId"
  `);
}
