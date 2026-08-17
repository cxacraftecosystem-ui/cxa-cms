import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, noContent, ok, route } from "@/lib/api";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { MEDIA_FIGURE_SELECT } from "@/lib/media/select";
import { canAccessStudio, canManageContent } from "@/lib/permissions";
import {
  assertMediaAvailable,
  assertSlugAvailable,
  boundedInt,
  buildAuditContext,
  dropSearchDocument,
  found,
  isUniqueViolation,
  optionalDateTime,
  optionalId,
  optionalText,
  parseStudioJson,
  publishTransition,
  requiredText,
  slugSchema,
  statusSchema,
  syncSearchDocument
} from "@/lib/studio/crud";

/**
 * One gallery album: read it, save it, put it in the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PICTURES ARE REPLACED BY UPSERT, NOT BY DELETE-AND-RECREATE.
 *
 * A `GalleryItem` row is identified by (albumId, assetId), and the editor uses that row's id as the React
 * key for the tile on screen. Recreating every row on every save would hand every tile a new key, so a
 * picture that had simply moved would be treated as a different picture: focus would jump off whatever the
 * editor had selected, and any column the payload does not carry would be lost. Upserting keeps the row,
 * its id and anything else on it, and writes only what the editor sent.
 *
 * Pictures no longer in the payload are deleted FIRST, so a re-ordering that also removes one cannot leave
 * two rows claiming the same position — `GalleryItem.position` is not unique, but a list with holes reads
 * as a bug in the gallery.
 *
 * A SOFT-DELETED ALBUM KEEPS ITS PICTURES. `GalleryItem` cascades on a REAL delete only, so an album
 * restored from the recycle bin comes back whole.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const TAG_LIMIT = 20;
const ITEM_LIMIT = 300;
const PRESENTATIONS = ["image", "video", "panorama", "tour"] as const;

const itemSchema = z.object({
  assetId: z.string().trim().min(1, "A picture reference cannot be empty.").max(40),
  caption: optionalText(300),
  presentation: z.enum(PRESENTATIONS).default("image"),
  tourEntry: optionalText(120)
});

const albumBodySchema = z.object({
  title: requiredText(140, "An album needs a title. It is what appears on the gallery page."),
  slug: z.union([z.literal(""), slugSchema()]),
  description: optionalText(600),
  category: optionalText(80),
  location: optionalText(160),
  credit: optionalText(160),
  happenedOn: optionalDateTime("The date this happened"),
  coverId: optionalId(),
  sortOrder: boundedInt({ min: -9999, max: 9999, fallback: 0 }),
  status: statusSchema,
  tags: z
    .array(z.string().trim().max(40))
    .max(TAG_LIMIT, `Use at most ${TAG_LIMIT} tags. A longer list stops describing anything.`),
  items: z
    .array(itemSchema)
    .max(ITEM_LIMIT, `An album holds at most ${ITEM_LIMIT} pictures. Start a second album for the rest.`)
});

const ALBUM_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  category: true,
  location: true,
  credit: true,
  happenedOn: true,
  coverId: true,
  sortOrder: true,
  status: true,
  publishedAt: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true
} as const;

type AlbumRow = Prisma.GalleryAlbumGetPayload<{ select: typeof ALBUM_SELECT }>;

// The figure list — the album editor prints the asset's own caption — plus the columns the picker
// shows beside the thumbnail.
const MEDIA_SELECT = {
  ...MEDIA_FIGURE_SELECT,
  id: true,
  kind: true,
  fileName: true
} as const;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = route(async (request: Request, context: RouteContext) => {
  await requireCapability(canAccessStudio);
  const { id } = await context.params;

  const album = found(
    await prisma.galleryAlbum.findUnique({
      where: { id },
      select: {
        ...ALBUM_SELECT,
        cover: { select: MEDIA_SELECT },
        items: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            position: true,
            caption: true,
            presentation: true,
            tourEntry: true,
            asset: { select: MEDIA_SELECT }
          }
        }
      }
    }),
    "That album"
  );

  return ok({ album });
});

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageContent,
    "Changing a gallery album needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, albumBodySchema.partial());

  const existing = found(
    await prisma.galleryAlbum.findFirst({ where: { id, deletedAt: null }, select: ALBUM_SELECT }),
    "That album"
  );

  // An empty address arrives from the editor when somebody clears the field. Read as "leave it alone": an
  // album cannot have an empty address, and refusing the whole save mid-edit would block the autosave.
  const slug = body.slug !== undefined && body.slug.length > 0 ? body.slug : existing.slug;
  if (slug !== existing.slug) await assertSlugAvailable("album", slug, id);

  if (body.coverId !== undefined) {
    await assertMediaAvailable(prisma, body.coverId, { field: "coverId", what: "cover picture" });
  }

  // No `schedulable`: `GalleryAlbum` has only a `status` column.
  const transition = publishTransition(existing, { status: body.status }, user);

  const requested = body.items;
  const items = requested === undefined ? null : await keepLiveItems(requested);
  const dropped = requested === undefined || items === null ? 0 : requested.length - items.length;

  try {
    const updated = await mutateWithHistory<AlbumRow>(
      buildAuditContext(request, user),
      {
        action: transition.action,
        entityType: "GalleryAlbum",
        entityLabel: body.title ?? existing.title,
        before: existing,
        summary: slug !== existing.slug ? `Address changed from /${existing.slug}` : null
      },
      async (tx) => {
        const row = await tx.galleryAlbum.update({
          where: { id },
          data: {
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.category !== undefined ? { category: body.category } : {}),
            ...(body.location !== undefined ? { location: body.location } : {}),
            ...(body.credit !== undefined ? { credit: body.credit } : {}),
            ...(body.happenedOn !== undefined ? { happenedOn: body.happenedOn } : {}),
            ...(body.coverId !== undefined ? { coverId: body.coverId } : {}),
            ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
            ...(body.tags !== undefined ? { tags: cleanTags(body.tags) } : {}),
            slug,
            status: transition.status,
            ...(transition.publishedAt ? { publishedAt: transition.publishedAt } : {})
          },
          select: ALBUM_SELECT
        });

        if (items !== null) await replaceItems(tx, id, items);

        const indexable = await tx.galleryAlbum.findUnique({
          where: { id },
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            category: true,
            location: true,
            credit: true,
            tags: true,
            status: true,
            publishedAt: true,
            deletedAt: true,
            items: { select: { caption: true } }
          }
        });
        if (indexable) await syncSearchDocument(tx, "album", indexable);

        return row;
      }
    );

    return ok({ id: updated.id, album: updated, droppedPictures: dropped });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("album", slug, id);
    throw error;
  }
});

export const DELETE = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageContent,
    "Deleting a gallery album needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const existing = found(
    await prisma.galleryAlbum.findUnique({
      where: { id },
      select: { id: true, title: true, slug: true, deletedAt: true }
    }),
    "That album"
  );

  if (existing.deletedAt) return noContent();

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "GalleryAlbum",
      entityLabel: existing.title,
      before: existing,
      revise: false
    },
    async (tx) => {
      const row = await tx.galleryAlbum.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true, title: true, deletedAt: true }
      });

      await dropSearchDocument(tx, "album", id);
      await tx.contentLock.deleteMany({ where: { entityType: "GalleryAlbum", entityId: id } });

      return row;
    }
  );

  return noContent();
});

type ItemInput = z.output<typeof itemSchema>;

/**
 * The pictures that are still in the library, in the order given, with duplicates removed.
 *
 * A duplicate would be refused by `@@unique([albumId, assetId])`; keeping the FIRST occurrence matches what
 * the editor shows, where the picker refuses to add a picture the album already has.
 */
async function keepLiveItems(items: readonly ItemInput[]): Promise<ItemInput[]> {
  const seen = new Set<string>();
  const wanted: ItemInput[] = [];
  for (const item of items) {
    if (item.assetId.length === 0 || seen.has(item.assetId)) continue;
    seen.add(item.assetId);
    wanted.push(item);
  }
  if (wanted.length === 0) return [];

  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: wanted.map((item) => item.assetId) }, deletedAt: null },
    select: { id: true }
  });
  const live = new Set(rows.map((row) => row.id));
  return wanted.filter((item) => live.has(item.assetId));
}

/** Delete what has gone, then upsert what is left with its new position. See the header. */
async function replaceItems(tx: TxClient, albumId: string, items: readonly ItemInput[]): Promise<void> {
  const keep = items.map((item) => item.assetId);

  // The empty case is spelled out rather than left to `notIn: []`, whose meaning is a detail of the query
  // builder and not something a reader should have to know to see that clearing the list clears the rows.
  if (keep.length === 0) {
    await tx.galleryItem.deleteMany({ where: { albumId } });
    return;
  }

  await tx.galleryItem.deleteMany({ where: { albumId, assetId: { notIn: keep } } });

  for (const [index, item] of items.entries()) {
    await tx.galleryItem.upsert({
      where: { albumId_assetId: { albumId, assetId: item.assetId } },
      create: {
        albumId,
        assetId: item.assetId,
        caption: item.caption,
        presentation: item.presentation,
        tourEntry: item.tourEntry,
        position: index
      },
      update: {
        caption: item.caption,
        presentation: item.presentation,
        tourEntry: item.tourEntry,
        position: index
      }
    });
  }
}

function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}
