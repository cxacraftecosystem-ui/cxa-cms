import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  notFound,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";
import { unique } from "@/lib/utils";

/**
 * One media asset: read it, change its description, or move it to the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `GET` ANSWERS `MediaAssetDetail` (components/studio/media/MediaGrid.tsx) and `PATCH` answers
 * `StudioMediaAsset`, because the detail panel writes the patched row straight back into the grid.
 *
 * `altText` HAS THREE STATES AND THE COLUMN CARRIES ALL THREE. `null` means nobody has written a
 * description; `""` means somebody decided the image is decorative, which is MEANINGFUL in HTML — it
 * tells a screen reader to skip the image — and counts as finished; anything else is a description.
 * The panel's checkbox is what turns the first into the second, so **`null` and `""` must both survive
 * the round trip** and neither may be normalised into the other. The whole accessibility backlog
 * depends on that distinction being real.
 *
 * `DELETE` IS A SOFT DELETE, ALWAYS. It sets `deletedAt` and nothing else: the row goes to the recycle
 * bin and the BYTES SURVIVE until the purge cron passes the recovery window
 * (`MEDIA_PURGE_AFTER_DAYS`, 30 days by default). Nothing in this file removes an object from storage,
 * and nothing in this file may be changed to — the purge job's ordering (bytes first, row second) is
 * the only safe sequence and it lives in app/api/cron/purge.
 *
 * DELETING COUNTS THE REFERENCES FIRST AND RETURNS THEM. An administrator about to remove a photograph
 * that appears on four pages must be told which four. The panel asks the same question on `GET` so it
 * can say so BEFORE the confirm; the answer here is the same list, so an asset that gained a reference
 * between the two is still reported.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many places per relation are named.
 *
 * The panel lists the first few and says "at least these" when the count was capped. Reading every
 * reference across fifteen relations for an asset used in a thousand gallery items would make opening
 * the panel slow, and the number past a handful does not change the decision.
 */
const USAGE_TAKE = 6;

/** The whole list is capped as well, so fifteen relations cannot add up to ninety lines. */
const USAGE_TOTAL = 24;

const VARIANT_SELECT = {
  select: { label: true, format: true, objectKey: true, width: true },
  orderBy: { width: "asc" as const }
};

/** The full variant rows the detail panel tabulates — id, dimensions and size as well. */
const VARIANT_DETAIL_SELECT = {
  select: {
    id: true,
    label: true,
    format: true,
    objectKey: true,
    width: true,
    height: true,
    byteSize: true
  },
  orderBy: { width: "asc" as const }
};

/**
 * Every relation that can point at an asset, with just enough of each row to NAME it.
 *
 * "This file is used in 4 places" is not actionable; "the About page, Anita Sharma's profile, the Bagru
 * project and the Convocation 2026 album" is. Soft-deleted owners are excluded — a photograph used only
 * by an article that is itself in the recycle bin is not holding anything up.
 */
const USAGE_INCLUDE = {
  userAvatars: { select: { id: true, name: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  pageSeoImages: { select: { id: true, title: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  personPhotos: { select: { id: true, name: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  projectCovers: { select: { id: true, title: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  projectGallery: {
    select: { project: { select: { id: true, title: true } } },
    where: { project: { deletedAt: null } },
    take: USAGE_TAKE
  },
  postCovers: { select: { id: true, title: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  eventCovers: { select: { id: true, title: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  eventGallery: {
    select: { event: { select: { id: true, title: true } } },
    where: { event: { deletedAt: null } },
    take: USAGE_TAKE
  },
  partnerLogos: { select: { id: true, name: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  craftImages: {
    select: { craft: { select: { id: true, name: true } } },
    where: { craft: { deletedAt: null } },
    take: USAGE_TAKE
  },
  craftCovers: { select: { id: true, name: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  albumCovers: { select: { id: true, title: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  albumItems: {
    select: { album: { select: { id: true, title: true } } },
    where: { album: { deletedAt: null } },
    take: USAGE_TAKE
  },
  researchAreaCovers: { select: { id: true, title: true }, where: { deletedAt: null }, take: USAGE_TAKE },
  collections: {
    select: { collection: { select: { id: true, name: true } } },
    take: USAGE_TAKE
  }
} satisfies Prisma.MediaAssetInclude;

/**
 * What `collectUsage` needs, declared STRUCTURALLY rather than as a Prisma payload type.
 *
 * Both call sites below read the same relations but a different set of scalar columns, and one of them
 * also pulls `variants`. A structural shape means one function serves both without a payload type that
 * has to be kept in step with two `include` blocks.
 */
interface AssetUsageRows {
  userAvatars: { id: string; name: string }[];
  pageSeoImages: { id: string; title: string }[];
  personPhotos: { id: string; name: string }[];
  projectCovers: { id: string; title: string }[];
  projectGallery: { project: { id: string; title: string } }[];
  postCovers: { id: string; title: string }[];
  eventCovers: { id: string; title: string }[];
  eventGallery: { event: { id: string; title: string } }[];
  partnerLogos: { id: string; name: string }[];
  craftImages: { craft: { id: string; name: string } }[];
  craftCovers: { id: string; name: string }[];
  albumCovers: { id: string; title: string }[];
  albumItems: { album: { id: string; title: string } }[];
  researchAreaCovers: { id: string; title: string }[];
  collections: { collection: { id: string; name: string } }[];
}

interface Usage {
  label: string;
  where: string;
  href: string | null;
}

/**
 * Flatten the relations into one list of plain sentences.
 *
 * `where` is deliberately in ordinary words — "news article cover", not "Post.coverId". This list is
 * read by an administrator deciding whether a deletion is safe, and a column name tells them nothing.
 * `href` is null where there is no studio screen for that kind of record (partners and media
 * collections have none), because a dead link is worse than plain text.
 */
function collectUsage(asset: AssetUsageRows): { usage: Usage[]; truncated: boolean } {
  const usage: Usage[] = [];
  let truncated = false;

  const push = (rows: readonly unknown[], entries: Usage[]) => {
    // A relation that came back exactly full is a relation with possibly more behind it.
    if (rows.length >= USAGE_TAKE) truncated = true;
    usage.push(...entries);
  };

  push(
    asset.userAvatars,
    asset.userAvatars.map((row) => ({
      label: row.name,
      where: "profile picture of a studio user",
      href: "/studio/users"
    }))
  );
  push(
    asset.pageSeoImages,
    asset.pageSeoImages.map((row) => ({
      label: row.title,
      where: "sharing image for a page",
      href: `/studio/pages/${row.id}`
    }))
  );
  push(
    asset.personPhotos,
    asset.personPhotos.map((row) => ({
      label: row.name,
      where: "photograph on a profile",
      href: `/studio/people/${row.id}`
    }))
  );
  push(
    asset.projectCovers,
    asset.projectCovers.map((row) => ({
      label: row.title,
      where: "cover of a project",
      href: `/studio/projects/${row.id}`
    }))
  );
  push(
    asset.projectGallery,
    asset.projectGallery.map((row) => ({
      label: row.project.title,
      where: "picture in a project gallery",
      href: `/studio/projects/${row.project.id}`
    }))
  );
  push(
    asset.postCovers,
    asset.postCovers.map((row) => ({
      label: row.title,
      where: "cover of a news article",
      href: `/studio/news/${row.id}`
    }))
  );
  push(
    asset.eventCovers,
    asset.eventCovers.map((row) => ({
      label: row.title,
      where: "cover of an event",
      href: `/studio/events/${row.id}`
    }))
  );
  push(
    asset.eventGallery,
    asset.eventGallery.map((row) => ({
      label: row.event.title,
      where: "picture in an event gallery",
      href: `/studio/events/${row.event.id}`
    }))
  );
  push(
    asset.partnerLogos,
    asset.partnerLogos.map((row) => ({
      label: row.name,
      where: "logo of a partner",
      href: null
    }))
  );
  push(
    asset.craftImages,
    asset.craftImages.map((row) => ({
      label: row.craft.name,
      where: "photograph of a craft",
      href: `/studio/crafts/${row.craft.id}`
    }))
  );
  push(
    asset.craftCovers,
    asset.craftCovers.map((row) => ({
      label: row.name,
      where: "cover of a craft",
      href: `/studio/crafts/${row.id}`
    }))
  );
  push(
    asset.albumCovers,
    asset.albumCovers.map((row) => ({
      label: row.title,
      where: "cover of a gallery album",
      href: `/studio/gallery/${row.id}`
    }))
  );
  push(
    asset.albumItems,
    asset.albumItems.map((row) => ({
      label: row.album.title,
      where: "photograph in a gallery album",
      href: `/studio/gallery/${row.album.id}`
    }))
  );
  push(
    asset.researchAreaCovers,
    asset.researchAreaCovers.map((row) => ({
      label: row.title,
      where: "cover of a research area",
      href: `/studio/research/${row.id}`
    }))
  );
  push(
    asset.collections,
    asset.collections.map((row) => ({
      label: row.collection.name,
      where: "item in a media collection",
      href: null
    }))
  );

  if (usage.length > USAGE_TOTAL) {
    return { usage: usage.slice(0, USAGE_TOTAL), truncated: true };
  }
  return { usage, truncated };
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(
    canManageMedia,
    "The media library needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const asset = await prisma.mediaAsset.findFirst({
    // The recycle bin is not reachable from this panel — a restore happens in /studio/recycle-bin, and
    // offering the editing form for a deleted row would let somebody describe a file that is not there.
    where: { id, deletedAt: null },
    include: {
      folder: { select: { id: true, name: true, path: true } },
      uploader: { select: { id: true, name: true } },
      variants: VARIANT_DETAIL_SELECT,
      ...USAGE_INCLUDE
    }
  });

  if (!asset) throw notFound("That file");

  const { usage, truncated } = collectUsage(asset);

  // Byte-identical siblings, on the checksum and never the filename. Reported so the administrator can
  // decide which copy to keep; nothing here merges them.
  const duplicates = asset.checksum
    ? await prisma.mediaAsset.findMany({
        where: { checksum: asset.checksum, deletedAt: null, id: { not: asset.id } },
        select: { id: true, fileName: true },
        orderBy: { createdAt: "asc" },
        take: 5
      })
    : [];

  // The usage relations are stripped from the answer: they were read to build `usage` and shipping the
  // raw rows as well would send the same records twice under names the screen does not use.
  const {
    userAvatars: _avatars,
    pageSeoImages: _pages,
    personPhotos: _people,
    projectCovers: _projectCovers,
    projectGallery: _projectGallery,
    postCovers: _postCovers,
    eventCovers: _eventCovers,
    eventGallery: _eventGallery,
    partnerLogos: _partners,
    craftImages: _craftImages,
    craftCovers: _craftCovers,
    albumCovers: _albumCovers,
    albumItems: _albumItems,
    researchAreaCovers: _areaCovers,
    collections: _collections,
    ...row
  } = asset;

  return ok({ ...row, usage, usageTruncated: truncated, duplicates });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_TAGS = 30;

const PatchBody = z.object({
  /**
   * ⚠ `null` and `""` are DIFFERENT VALUES and both are accepted. See the header. `.nullable()` rather
   * than a transform that folds one into the other: Zod's `.default()` fires for a MISSING key and
   * never for an explicit `null` (contract §14), and folding here would erase the decision the
   * decorative checkbox exists to record.
   */
  altText: z.string().max(500, "Keep a description to 500 characters or fewer.").nullable().optional(),
  caption: z.string().max(1000).nullable().optional(),
  credit: z.string().max(300).nullable().optional(),
  copyright: z.string().max(300).nullable().optional(),
  tags: z
    .array(z.string().trim().min(1).max(80))
    .max(MAX_TAGS, `Keep it to ${MAX_TAGS} tags or fewer — past that they stop helping anybody find things.`)
    .optional(),
  folderId: z.string().trim().min(1).max(64).nullable().optional()
});

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Changing a file in the media library needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseJson(request, PatchBody);

  const before = await prisma.mediaAsset.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw notFound("That file");

  if (body.folderId) {
    const folder = await prisma.mediaFolder.findUnique({
      where: { id: body.folderId },
      select: { id: true }
    });
    if (!folder) {
      throw badRequest("That folder no longer exists. Reload the media library and choose another.");
    }
  }

  // Built key by key from what was SENT, so a bulk action that only carries `{ credit }` cannot blank
  // the description. `in` rather than `!== undefined`, because an explicit `null` is a real value here
  // and `undefined` is what an absent key looks like after Zod strips it.
  // The UNCHECKED variant, because it is the one that exposes the raw `folderId` column. The checked
  // input only offers `folder: { connect | disconnect }`, which cannot express "move it out of every
  // folder" and "leave the filing alone" as two different things in one built-up object.
  const data: Prisma.MediaAssetUncheckedUpdateInput = {};
  if ("altText" in body) data.altText = body.altText;
  if ("caption" in body) data.caption = body.caption?.trim() || null;
  if ("credit" in body) data.credit = body.credit?.trim() || null;
  if ("copyright" in body) data.copyright = body.copyright?.trim() || null;
  if ("folderId" in body) data.folderId = body.folderId ?? null;
  if (body.tags) {
    // De-duplicated case-insensitively, first spelling wins. "Bagru, bagru" is one tag, and which one
    // is stored has to be predictable or the filter list grows a near-duplicate every week.
    const seen = new Set<string>();
    data.tags = unique(
      body.tags
        .map((tag) => tag.trim())
        .filter((tag) => {
          const key = tag.toLowerCase();
          if (tag.length === 0 || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
    );
  }

  if (Object.keys(data).length === 0) {
    // Nothing to write. Answered with the row rather than a 400: a save with no changes is a no-op the
    // panel can treat as success, and a refusal would leave "Unsaved changes" on screen for ever.
    const unchanged = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id },
      include: { variants: VARIANT_SELECT }
    });
    return ok(unchanged);
  }

  const updated = await mutateWithHistory<
    Prisma.MediaAssetGetPayload<{ include: { variants: typeof VARIANT_SELECT } }>
  >(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "UPDATE",
      entityType: "MediaAsset",
      entityLabel: before.fileName,
      before,
      summary: "Details edited"
    },
    async (tx) => {
      await tx.mediaAsset.update({ where: { id }, data });
      return tx.mediaAsset.findUniqueOrThrow({
        where: { id },
        include: { variants: VARIANT_SELECT }
      });
    }
  );

  return ok(updated);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — soft, always
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Removing a file from the media library needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const asset = await prisma.mediaAsset.findFirst({
    where: { id, deletedAt: null },
    include: {
      variants: { select: { objectKey: true } },
      ...USAGE_INCLUDE
    }
  });
  if (!asset) throw notFound("That file");

  const { usage, truncated } = collectUsage(asset);
  const deletedAt = new Date();

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "MediaAsset",
      entityLabel: asset.fileName,
      before: { fileName: asset.fileName, objectKey: asset.objectKey, folderId: asset.folderId },
      // A delete is logged, not versioned: there is no new state worth restoring, and the restore path
      // reads the row itself out of the recycle bin.
      revise: false
    },
    async (tx) => {
      /**
       * ⚠ `deletedAt` AND NOTHING ELSE. The relations pointing at this asset are all `onDelete:
       * SetNull` at the referring side and are deliberately left alone: an article whose cover has been
       * removed keeps the reference, so restoring the photograph restores the page as it was. Clearing
       * them here would turn a reversible removal into a permanent one.
       *
       * The BYTES are not touched. app/api/cron/purge removes them once the row has been in the recycle
       * bin longer than MEDIA_PURGE_AFTER_DAYS, and it is the only writer that may.
       */
      return tx.mediaAsset.update({
        where: { id },
        data: { deletedAt },
        select: { id: true }
      });
    }
  );

  return ok({
    deleted: true,
    id: asset.id,
    fileName: asset.fileName,
    /**
     * What has just been left without a picture. Returned even though the panel asked the same question
     * a moment ago on `GET`: a reference added in between would otherwise go unmentioned, and the
     * administrator would find out from a reader.
     */
    references: usage,
    referenceCount: usage.length,
    referencesTruncated: truncated,
    /** Said plainly, because "delete" that keeps the file is the opposite of what the word suggests. */
    message:
      usage.length === 0
        ? `${asset.fileName} is in the recycle bin. Nothing on the site was using it, so nothing has broken.`
        : `${asset.fileName} is in the recycle bin, and ${
            usage.length === 1 ? "1 record that used it" : `${usage.length} records that used it`
          }${truncated ? " (at least)" : ""} will now render without a picture. It can be restored.`
  });
});
