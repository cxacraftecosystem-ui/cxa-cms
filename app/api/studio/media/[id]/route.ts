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
  route,
  userAgent
} from "@/lib/api";
import { parseStudioJson } from "@/lib/studio/crud";
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { mediaPurgeAfterDays } from "@/lib/env";
import { canManageMedia } from "@/lib/permissions";
import { unique } from "@/lib/utils";

/**
 * One media asset: read it, change its description or its crop, or move it to the recycle bin.
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
 * THE CROP IS FIVE NUMBERS ON THE ROW AND `PATCH` IS THE ONLY THING THAT WRITES THEM. They say which
 * part of the picture the site is allowed to show, as fractions of the full image, and they are applied
 * at RENDER — no byte is re-encoded, no derivative is regenerated, no new asset is created. Which is
 * what makes RE-cropping an already-uploaded photograph the same operation as cropping a new one: an
 * editor drags a rectangle, five columns change, every page already using the file picks the new
 * framing up on its next render. See prisma/migrations/20260816190000_media_asset_crop for why a stored
 * rectangle rather than re-encoded bytes, and `CropBody` below for what is enforced.
 *
 * ⚠ THERE IS DELIBERATELY NO SEPARATE `/crop` ROUTE. A crop is five scalar columns on `MediaAsset`, the
 * same kind of thing as `altText`, and a second endpoint writing the same five columns would be a
 * second place for the validation, the audit entry and the "is this rectangle usable" rule to drift
 * apart. `PATCH` already builds its update key by key from what was SENT, so a crop-only body cannot
 * disturb the description and a description-only body cannot disturb the crop.
 *
 * `DELETE` IS A SOFT DELETE, ALWAYS. It sets `deletedAt` and nothing else: the row goes to the recycle
 * bin and the BYTES SURVIVE until the purge cron passes the recovery window
 * (`MEDIA_PURGE_AFTER_DAYS`, 30 days by default). Nothing in this file removes an object from storage,
 * and nothing in this file may be changed to — the purge job's ordering (bytes first, row second) is
 * the only safe sequence and it lives in app/api/cron/purge.
 *
 * BOTH `GET` AND `DELETE` CARRY `recoveryDays`, THE REAL CONFIGURED NUMBER. The studio has to be able
 * to say "it can be restored for the next 30 days" and mean it, and the browser cannot read
 * `MEDIA_PURGE_AFTER_DAYS` — it is a server variable with no `NEXT_PUBLIC_` prefix, which is correct.
 * A hard-coded 30 in a component would go on saying 30 the day an administrator sets it to 7, and a
 * confirmation that lies about how long you have to change your mind is worse than one that says
 * nothing.
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

  /**
   * Sent with the row so the delete confirmation can name the real window BEFORE anybody agrees to
   * anything. See the header: the browser cannot read `MEDIA_PURGE_AFTER_DAYS` itself, and a panel that
   * guesses 30 would go on saying 30 the day an administrator sets it to 7.
   */
  return ok({ ...row, usage, usageTruncated: truncated, duplicates, recoveryDays: mediaPurgeAfterDays() });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_TAGS = 30;

/**
 * A crop edge, as a fraction of the full image.
 *
 * FRACTIONS AND NOT PIXELS, because the same asset is served at six widths (`VARIANT_WIDTHS` in
 * lib/media/url.ts, 320 → 2560) and a pixel rectangle is meaningful against exactly one of them.
 */
const CropEdge = z
  .number()
  .finite("A crop has to be four ordinary numbers.")
  .min(0, "A crop cannot start outside the picture.")
  .max(1, "A crop cannot extend past the edge of the picture.");

/** The five crop keys, named once so `hasAnyCropKey` and the error sentences cannot drift apart. */
const CROP_KEYS = ["cropX", "cropY", "cropWidth", "cropHeight", "cropAspect"] as const;

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
  folderId: z.string().trim().min(1).max(64).nullable().optional(),

  /**
   * ⚠ THE FIVE CROP FIELDS TRAVEL TOGETHER OR NOT AT ALL, and the check that enforces it is the
   * `superRefine` below. Four of five is not a rectangle; three numbers and a stale `cropAspect` is a
   * row the render side has to guess about. Sending all five as `null` is the way to say "show the
   * whole picture again", which is a real answer and not the absence of one.
   */
  cropX: CropEdge.nullable().optional(),
  cropY: CropEdge.nullable().optional(),
  cropWidth: CropEdge.nullable().optional(),
  cropHeight: CropEdge.nullable().optional(),
  /**
   * Which preset the editor was working on ("16-9", "og", "free", …). NOTHING RENDERS FROM IT — it is
   * kept only so the cropper reopens on the shape they chose, and the four numbers above are the
   * truth. Not validated against the preset list: that list lives in a `"use client"` module which a
   * route handler cannot import, and an unrecognised value already degrades to "free" in the dialog.
   */
  cropAspect: z.string().trim().min(1).max(24).nullable().optional()
})
  .superRefine((body, ctx) => {
    const present = CROP_KEYS.filter((key) => key in body);
    if (present.length === 0) return;

    if (present.length !== CROP_KEYS.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cropX"],
        message:
          "A crop is five values and they have to be sent together. Send all of cropX, cropY, cropWidth, cropHeight and cropAspect, or none of them."
      });
      return;
    }

    const { cropX, cropY, cropWidth, cropHeight, cropAspect } = body;
    const numbers = [cropX, cropY, cropWidth, cropHeight];
    const nulls = numbers.filter((value) => value === null).length;

    // All four null is "show the whole picture". `cropAspect` has to go with them, or the dialog would
    // reopen locked to a shape whose rectangle no longer exists.
    if (nulls === numbers.length) {
      if (cropAspect !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cropAspect"],
          message: "Clearing a crop clears the shape with it. Send cropAspect as null too."
        });
      }
      return;
    }

    // `typeof` rather than a null count, because this is also what NARROWS all four to `number` for
    // the arithmetic below — a count TypeScript cannot follow would leave four casts behind it.
    if (
      typeof cropX !== "number" ||
      typeof cropY !== "number" ||
      typeof cropWidth !== "number" ||
      typeof cropHeight !== "number"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cropX"],
        message:
          "Part of a crop is missing. Send all four of cropX, cropY, cropWidth and cropHeight, or all four as null to show the whole picture."
      });
      return;
    }

    /**
     * ⚠ THE SAME TEST AS `isUsableCrop()` in components/studio/ImageCropper.tsx, written out again
     * rather than imported: that module carries `"use client"`, and a plain function exported from a
     * client module and imported by a route handler is a client reference, not the function — calling
     * it on the server throws. The cropper's header records the intention to move both to
     * `lib/media/crop.ts`, which is the edit that lets this duplication go.
     *
     * A hair over 1 is tolerated on the two sums because the numbers arrive from floating-point
     * division and `0.3 + 0.7` is famously not 1. A hair is not a crop.
     */
    if (cropWidth <= 0 || cropHeight <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cropWidth"],
        message: "A crop has to keep some of the picture — its width and height cannot be zero."
      });
      return;
    }
    if (cropX + cropWidth > 1.0001 || cropY + cropHeight > 1.0001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cropWidth"],
        message: "That crop runs off the edge of the picture. Move it back inside before saving."
      });
    }
  });

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageMedia,
    "Changing a file in the media library needs media manager access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, PatchBody);

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
  // All five or none — the `superRefine` above has already refused every other combination, so these
  // five lines cannot write half a rectangle.
  if ("cropX" in body) data.cropX = body.cropX;
  if ("cropY" in body) data.cropY = body.cropY;
  if ("cropWidth" in body) data.cropWidth = body.cropWidth;
  if ("cropHeight" in body) data.cropHeight = body.cropHeight;
  if ("cropAspect" in body) data.cropAspect = body.cropAspect;
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

  /**
   * What the history entry says.
   *
   * A crop is not a detail: it changes what every page already using this file DRAWS, without anybody
   * touching those pages. Filing it under the same "Details edited" as a typo fixed in a caption is how
   * "the About page picture changed and nobody knows why" happens.
   */
  const cropTouched = "cropX" in body;
  const otherTouched = Object.keys(data).some((key) => !CROP_KEYS.some((cropKey) => cropKey === key));
  const summary = !cropTouched
    ? "Details edited"
    : otherTouched
      ? "Details and the crop edited"
      : body.cropX === null
        ? "Crop cleared — the whole picture is shown again"
        : "Crop changed — a different part of the picture is now shown";

  const updated = await mutateWithHistory<
    Prisma.MediaAssetGetPayload<{ include: { variants: typeof VARIANT_SELECT } }>
  >(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "UPDATE",
      entityType: "MediaAsset",
      entityLabel: before.fileName,
      before,
      summary
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
  const recoveryDays = mediaPurgeAfterDays();

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
    /**
     * How long there is to change their mind, from the same function the purge job reads. Repeated in
     * the answer as well as in `GET` because a batch delete never opened the panel: the bulk bar knows
     * the window only because each reply carries it.
     */
    recoveryDays,
    /** Said plainly, because "delete" that keeps the file is the opposite of what the word suggests. */
    /**
     * ⚠ "AN ADMINISTRATOR CAN PUT IT BACK", NOT "IT CAN BE RESTORED". Reaching this handler needs
     * `canManageMedia`; the restore route needs `canRestoreDeleted`, which is ADMINISTRATOR only. A
     * media manager told they can undo this would find out otherwise after the fact.
     */
    message:
      usage.length === 0
        ? `${asset.fileName} is in the recycle bin, where an administrator can put it back for the next ${recoveryDays} days. Nothing on the site was using it, so nothing has broken.`
        : `${asset.fileName} is in the recycle bin, and ${
            usage.length === 1 ? "1 record that used it" : `${usage.length} records that used it`
          }${truncated ? " (at least)" : ""} will now render without a picture. An administrator can put it back for the next ${recoveryDays} days.`
  });
});
