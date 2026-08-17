import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canAccessStudio, canManageContent } from "@/lib/permissions";
import {
  assertMediaAvailable,
  assertSlugAvailable,
  binWhere,
  boundedInt,
  buildAuditContext,
  fieldProblem,
  isUniqueViolation,
  listQuerySchema,
  optionalDateTime,
  optionalId,
  optionalText,
  pageWindow,
  paginated,
  parseStudioJson,
  parseStudioQuery,
  publishTransition,
  requiredText,
  resolveSort,
  slugFromTitle,
  slugSchema,
  statusSchema,
  syncSearchDocument,
  textSearchWhere
} from "@/lib/studio/crud";

/**
 * Gallery albums — the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ORDER OF THE `items` ARRAY IS THE ORDER OF THE PICTURES. Nothing on screen carries a position
 * number, so deriving it from the array is the only reading that cannot disagree with what the editor is
 * looking at. `GalleryItem.position` is NOT unique, so this needs none of the two-pass dance the page
 * builder does — the constraint there is what makes that necessary, and its absence here is why this is
 * simply an index.
 *
 * A PICTURE THAT IS NO LONGER IN THE LIBRARY IS DROPPED, NOT REFUSED. The cause is always somebody else
 * putting a photograph in the recycle bin while this album was open, and failing the save would strand the
 * editor with no way forward from that screen. The response says how many were dropped so the screen can
 * state it rather than leaving a silently shorter album.
 *
 * `presentation` IS HOW A PICTURE IS SHOWN, NOT WHAT IT IS — a still frame can introduce a virtual tour
 * (prisma/schema.prisma). It is a closed list here because a typo would fall back to "image" silently and
 * the tour would simply never open.
 *
 * THE GALLERY FEATURE FLAG IS NOT CHECKED. The public gallery can be switched off while an editor builds the
 * first albums; a studio that refused to let them work until the surface was live would make the flag
 * impossible to use as intended.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** Matches `TAG_LIMIT` in the album editor. Past this many tags nothing is being described any more. */
const TAG_LIMIT = 20;

/** An album longer than this is a whole archive. The refusal says so and suggests a second album. */
const ITEM_LIMIT = 300;

const PRESENTATIONS = ["image", "video", "panorama", "tour"] as const;

const SORTABLE = {
  updatedAt: "updatedAt",
  createdAt: "createdAt",
  publishedAt: "publishedAt",
  happenedOn: "happenedOn",
  title: "title",
  order: "sortOrder"
} as const;

const listSchema = listQuerySchema.extend({
  category: z.string().trim().max(80).default("")
});

const itemSchema = z.object({
  assetId: z.string().trim().min(1, "A picture reference cannot be empty.").max(40),
  caption: optionalText(300),
  presentation: z.enum(PRESENTATIONS).default("image"),
  tourEntry: optionalText(120)
});

const albumBodySchema = z.object({
  title: requiredText(140, "An album needs a title. It is what appears on the gallery page."),
  /** May arrive empty — the editor trims it — in which case it is taken from the title. */
  slug: z.union([z.literal(""), slugSchema()]).default(""),
  description: optionalText(600),
  category: optionalText(80),
  location: optionalText(160),
  credit: optionalText(160),
  happenedOn: optionalDateTime("The date this happened"),
  coverId: optionalId(),
  sortOrder: boundedInt({ min: -9999, max: 9999, fallback: 0 }),
  status: statusSchema.default("DRAFT"),
  tags: z
    .array(z.string().trim().max(40))
    .max(TAG_LIMIT, `Use at most ${TAG_LIMIT} tags. A longer list stops describing anything.`)
    .default([]),
  items: z
    .array(itemSchema)
    .max(ITEM_LIMIT, `An album holds at most ${ITEM_LIMIT} pictures. Start a second album for the rest.`)
    .default([])
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

export const GET = route(async (request: Request) => {
  await requireCapability(canAccessStudio);

  const query = parseStudioQuery(request, listSchema);
  const { page, pageSize, skip, take } = pageWindow(query);

  const where: Record<string, unknown> = {
    ...binWhere(query.bin),
    ...(query.status === "" ? {} : { status: query.status }),
    ...(query.category === "" ? {} : { category: query.category }),
    ...textSearchWhere(query.q, ["title", "description", "location", "credit"])
  };

  const [rows, total] = await prisma.$transaction([
    prisma.galleryAlbum.findMany({
      where,
      orderBy: resolveSort(query, SORTABLE, "updatedAt"),
      skip,
      take,
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        category: true,
        location: true,
        happenedOn: true,
        sortOrder: true,
        status: true,
        publishedAt: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        cover: { select: MEDIA_IMAGE_SELECT_WITH_ID },
        _count: { select: { items: true } }
      }
    }),
    prisma.galleryAlbum.count({ where })
  ]);

  return ok(
    paginated(
      rows.map(({ _count, ...row }) => ({ ...row, itemCount: _count.items })),
      total,
      page,
      pageSize
    )
  );
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageContent,
    "Creating a gallery album needs editor access. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, albumBodySchema);

  const slug = body.slug.length > 0 ? body.slug : slugFromTitle(body.title);
  if (slug.length === 0) {
    throw fieldProblem(
      "slug",
      "This album needs a web address, and one could not be made from its title. Type one — lower-case letters, numbers and hyphens."
    );
  }

  await assertSlugAvailable("album", slug);
  await assertMediaAvailable(prisma, body.coverId, { field: "coverId", what: "cover picture" });

  // `GalleryAlbum` has no publishAt column, so it cannot be scheduled — `publishTransition` refuses
  // SCHEDULED and says what to choose instead.
  const transition = publishTransition({ status: "DRAFT", publishedAt: null }, { status: body.status }, user);

  const wanted = body.items;
  const live = await liveAssetIds(wanted.map((item) => item.assetId));
  const items = wanted.filter((item) => live.has(item.assetId));
  const dropped = wanted.length - items.length;

  try {
    const created = await mutateWithHistory<AlbumRow>(
      buildAuditContext(request, user),
      {
        action: transition.action,
        entityType: "GalleryAlbum",
        entityLabel: body.title,
        summary: "Created"
      },
      async (tx) => {
        const row = await tx.galleryAlbum.create({
          data: {
            title: body.title,
            slug,
            description: body.description,
            category: body.category,
            location: body.location,
            credit: body.credit,
            happenedOn: body.happenedOn,
            coverId: body.coverId,
            sortOrder: body.sortOrder,
            tags: cleanTags(body.tags),
            status: transition.status,
            ...(transition.publishedAt ? { publishedAt: transition.publishedAt } : {})
          },
          select: ALBUM_SELECT
        });

        if (items.length > 0) {
          await tx.galleryItem.createMany({
            data: items.map((item, index) => ({
              albumId: row.id,
              assetId: item.assetId,
              caption: item.caption,
              presentation: item.presentation,
              tourEntry: item.tourEntry,
              position: index
            })),
            // The same picture twice in one album is a duplicate the unique index refuses; skipping is
            // kinder than failing a save over a double-click in the picker.
            skipDuplicates: true
          });
        }

        // Captions are often the only prose an album has, so they are part of what it can be found by.
        const indexable = await tx.galleryAlbum.findUnique({
          where: { id: row.id },
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

    // `id` at the top level as well as the whole row: the album editor reads `created.id` to correct the
    // address bar, and everything else about the album is useful to whoever else calls this.
    return ok({ id: created.id, album: created, droppedPictures: dropped }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("album", slug);
    throw error;
  }
});

/** Trimmed, de-duplicated, empty ones dropped. A `String[]` column will happily store `["", "", ""]`. */
function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

/** Which of these pictures are still in the library. */
async function liveAssetIds(ids: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id) => id.length > 0))];
  if (wanted.length === 0) return new Set();
  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: wanted }, deletedAt: null },
    select: { id: true }
  });
  return new Set(rows.map((row) => row.id));
}
