import type { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma, type ContentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  conflict,
  forbidden,
  notFound,
  ok,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { requireCapability, type SessionUser } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { indexDocument, removeDocument, searchDocFromCraft, searchUrlFor } from "@/lib/search/index";
import { isSafeObjectKey } from "@/lib/storage/keys";
import { parseStudioJson, screenFramingField } from "@/lib/studio/crud";
import { unique } from "@/lib/utils";

/**
 * One craft: read it, save it, or move it to the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE LOCAL NAME AND ITS LANGUAGE ARE REFUSED SEPARATELY. A name in another script with no `lang`
 * recorded is read aloud by an English voice letter by letter, which is worse than not recording the name
 * at all — so both fields are checked against the values that will actually be STORED, not only against
 * the ones this request happened to send. Clearing the language on a craft that has a local name is
 * therefore refused, which is the whole point.
 *
 * THE MEDIA LIST IS REPLACED WHOLE, WITH POSITIONS FROM THE ARRAY ORDER, because the position is the only
 * evidence of the before-and-after pairing: a "before" pairs with the NEXT "after" below it. A merge that
 * got one row wrong would pair a "before" with the wrong "after" and the comparison slider would show two
 * unrelated photographs. The same rule lives in the editor and in
 * `components/site/BeforeAfterSlider.tsx`; all three must agree.
 *
 * `PATCH` IS PARTIAL: the editor sends the whole payload on every autosave and the list screen's Archive
 * button sends `{ status: "ARCHIVED" }` alone.
 *
 * ⚠ THE VALIDATION RULES BELOW ARE DUPLICATED FROM THE SIBLING COLLECTION ROUTE, DELIBERATELY: a
 * `route.ts` is validated by Next against the shape of a route module, so importing shared code out of one
 * is a dependency on behaviour Next does not promise. Change both in the same commit.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const MAX_MEDIA = 200;
const MAX_LIST = 60;

const CONTENT_STATUSES = ["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"] as const;

const slugField = z
  .string()
  .trim()
  .min(1, "The web address is empty. It is the part after /craft-explorer/ and it cannot be blank.")
  .max(96, "Keep the web address to 96 characters or fewer.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "A web address can only use lower-case letters, numbers and single hyphens — “bagru-block-printing”, not “Bagru Block Printing”."
  );

const richTextField = z.union([
  z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() }).passthrough(),
  z.null()
]);

const idField = z.string().trim().min(1).max(64);

const languageField = z
  .string()
  .trim()
  .max(20)
  .regex(
    /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    "A language tag looks like “hi”, “ta” or “hi-Deva” — the two- or three-letter code for the language."
  )
  .nullable();

const PatchBody = z.object({
  name: z.string().trim().min(1, "The craft needs a name.").max(300).optional(),
  slug: slugField.optional(),
  localName: z.string().trim().max(300).nullable().optional(),
  localNameLang: languageField.optional(),
  summary: z.string().trim().max(3000).nullable().optional(),
  body: richTextField.optional(),
  regionId: idField.nullable().optional(),
  schoolId: idField.nullable().optional(),
  /** Negative is BCE, exactly as the schema says. Nothing here rewrites it. */
  originYear: z.number().int().min(-6000).max(new Date().getUTCFullYear()).nullable().optional(),
  originNote: z.string().trim().max(600).nullable().optional(),
  materials: z.array(z.string().trim().min(1).max(120)).max(MAX_LIST).optional(),
  techniques: z.array(z.string().trim().min(1).max(120)).max(MAX_LIST).optional(),
  latitude: z
    .number()
    .min(-90, "A latitude is between -90 and 90.")
    .max(90, "A latitude is between -90 and 90.")
    .nullable()
    .optional(),
  longitude: z
    .number()
    .min(-180, "A longitude is between -180 and 180.")
    .max(180, "A longitude is between -180 and 180.")
    .nullable()
    .optional(),
  coverId: idField.nullable().optional(),
  /**
   * The cover's per-screen framing. `.nullable().optional()` is two statements and both are needed: absent
   * leaves the column alone, null clears it — see `screenFramingColumn` for why collapsing them would make
   * an editor unable to unset a framing.
   */
  coverScreens: screenFramingField(),
  media: z
    .array(
      z.object({
        assetId: idField,
        caption: z.string().trim().max(600).nullable().optional(),
        restorationPhase: z.enum(["before", "after"]).nullable().optional(),
        /**
         * The row's per-screen framing, accepted beside the id it frames. Without it here the panel in the
         * editor would be a control that saves successfully and changes nothing — see `coverScreens` above.
         */
        assetScreens: screenFramingField()
      })
    )
    .max(MAX_MEDIA, `A craft can hold up to ${MAX_MEDIA} pictures.`)
    .optional(),
  modelObjectKey: z.string().trim().max(1024).nullable().optional(),
  isFeatured: z.boolean().optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  /** Defaults to true where it applies: leaving a link broken is never the safer default. */
  createRedirect: z.boolean().optional()
});

type CraftInput = z.infer<typeof PatchBody>;

const INDEX_SELECT = {
  id: true,
  slug: true,
  name: true,
  localName: true,
  summary: true,
  body: true,
  originNote: true,
  materials: true,
  techniques: true,
  status: true,
  publishedAt: true,
  deletedAt: true,
  region: { select: { name: true } },
  school: { select: { name: true } }
} satisfies Prisma.CraftSelect;

function jsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

function assertLocalNamePair(localName: string | null, localNameLang: string | null): void {
  if (localName && !localNameLang) {
    throw badRequest(
      "The local name needs its language recorded beside it — “hi” for Hindi, “ta” for Tamil, “bn” for Bengali. " +
        "Without it a screen reader reads the name with an English voice, which produces sounds that are not words " +
        "in either language."
    );
  }
  if (!localName && localNameLang) {
    throw badRequest("A language is recorded but the local name is empty. Fill in the name, or clear the language.");
  }
}

function assertModelKey(key: string | null): void {
  if (!key) return;
  if (!isSafeObjectKey(key) || !/^(models|media)\//.test(key)) {
    throw badRequest("That 3D model address is not one this site issues. Upload the model again.");
  }
}

async function assertCraftReferences(body: CraftInput): Promise<void> {
  if (body.regionId) {
    const region = await prisma.craftRegion.findUnique({ where: { id: body.regionId }, select: { id: true } });
    if (!region) throw badRequest("The region this craft was filed under no longer exists. Choose another.");
  }

  if (body.schoolId) {
    const school = await prisma.craftSchool.findUnique({ where: { id: body.schoolId }, select: { id: true } });
    if (!school) throw badRequest("The school this craft was filed under no longer exists. Choose another.");
  }

  if (body.coverId) {
    const cover = await prisma.mediaAsset.findFirst({
      where: { id: body.coverId, deletedAt: null },
      select: { id: true }
    });
    if (!cover) throw badRequest("The cover picture no longer exists in the media library. Choose another.");
  }

  const assetIds = unique((body.media ?? []).map((entry) => entry.assetId));
  if (assetIds.length > 0) {
    const assets = await prisma.mediaAsset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, fileName: true, deletedAt: true }
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const binned = assetIds.map((id) => byId.get(id)).filter((row) => row?.deletedAt);
    const missing = assetIds.filter((id) => !byId.has(id));

    if (binned.length > 0) {
      throw badRequest(
        `${binned.length === 1 ? "One picture is" : `${binned.length} pictures are`} in the recycle bin: ` +
          `${binned.map((row) => row?.fileName).join(", ")}. Restore them, or take them off this craft.`
      );
    }
    if (missing.length > 0) {
      throw badRequest(
        `${missing.length === 1 ? "One picture on this craft no longer exists" : `${missing.length} pictures on this craft no longer exist`}. ` +
          "Reload the page to see what is still there, then save again."
      );
    }
  }
}

/** Replaced whole, with positions from the array order — the position is the pairing evidence. */
async function replaceCraftMedia(tx: TxClient, craftId: string, body: CraftInput): Promise<void> {
  if (!body.media) return;

  const seen = new Set<string>();
  const media = body.media.filter((entry) => {
    if (seen.has(entry.assetId)) return false;
    seen.add(entry.assetId);
    return true;
  });

  await tx.craftMedia.deleteMany({ where: { craftId } });
  if (media.length > 0) {
    await tx.craftMedia.createMany({
      data: media.map((entry, position) => ({
        craftId,
        assetId: entry.assetId,
        caption: entry.caption?.trim() || null,
        restorationPhase: entry.restorationPhase ?? null,
        // The list is replaced whole on every save, so this row is a create either way and the framing has
        // to come with it or a save would be how an editor loses one.
        assetScreens: jsonColumn(entry.assetScreens),
        position
      }))
    });
  }
}

function assertMayChangeStatus(
  user: SessionUser,
  next: ContentStatus | undefined,
  before: { status: ContentStatus; publishedAt: Date | null }
): void {
  if (next === undefined || next === before.status) return;
  if (canPublish(user)) return;

  const goingLive = next === "PUBLISHED" || next === "SCHEDULED";
  if (!goingLive && !isLive(before)) return;

  throw forbidden(
    goingLive
      ? "Publishing needs editor access, or permission to publish granted by an administrator. Leave it as a draft and ask an editor."
      : "Taking something off the public site needs editor access, or permission to publish granted by an administrator."
  );
}

async function recordRename(tx: TxClient, fromSlug: string, toSlug: string): Promise<void> {
  const source = searchUrlFor("craft", fromSlug);
  const destination = searchUrlFor("craft", toSlug);
  if (source === destination) return;

  await tx.redirect.updateMany({ where: { destination: source }, data: { destination } });
  await tx.redirect.upsert({
    where: { source },
    create: { source, destination, permanent: true },
    update: { destination }
  });
  await tx.redirect.deleteMany({ where: { source: destination } });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const EDITOR_MEDIA_SELECT = {
  // `fileName` on top of the shared list: the editor labels a swap control with the stored file name.
  select: { ...MEDIA_IMAGE_SELECT_WITH_ID, fileName: true }
};

export const GET = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(
    canManageResearch,
    "The craft archive needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const craft = await prisma.craft.findFirst({
    where: { id, deletedAt: null },
    include: {
      cover: EDITOR_MEDIA_SELECT,
      region: { select: { id: true, name: true, level: true } },
      school: { select: { id: true, name: true } },
      // IN STORED ORDER. The order is what pairs a "before" with its "after", so the editor has to open on
      // exactly the sequence the page will render.
      media: {
        orderBy: { position: "asc" },
        select: {
          assetId: true,
          caption: true,
          restorationPhase: true,
          // The framing rides in the same select as the picture it frames, wherever the row is read.
          assetScreens: true,
          position: true,
          asset: EDITOR_MEDIA_SELECT
        }
      }
    }
  });

  if (!craft) throw notFound("That craft");
  return ok(craft);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Editing a craft needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, PatchBody);

  const before = await prisma.craft.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw notFound("That craft");

  assertMayChangeStatus(user, body.status, before);

  // Checked against the values that will actually be STORED, so clearing the language on a craft that keeps
  // its local name is refused rather than quietly leaving a name no screen reader can pronounce.
  const nextLocalName =
    "localName" in body ? body.localName?.trim() || null : before.localName;
  const nextLocalNameLang = "localNameLang" in body ? (body.localNameLang ?? null) : before.localNameLang;
  assertLocalNamePair(nextLocalName, nextLocalNameLang);

  if ("modelObjectKey" in body) assertModelKey(body.modelObjectKey?.trim() || null);

  if (body.slug && body.slug !== before.slug) {
    const taken = await prisma.craft.findUnique({
      where: { slug: body.slug },
      select: { id: true, name: true, deletedAt: true }
    });
    if (taken && taken.id !== id) {
      throw conflict(
        taken.deletedAt
          ? `The address /craft-explorer/${body.slug} belongs to “${taken.name}”, which is in the recycle bin.`
          : `The address /craft-explorer/${body.slug} is already used by “${taken.name}”. Choose a different one.`
      );
    }
  }

  await assertCraftReferences(body);

  // The UNCHECKED variant: it is the one that exposes the raw `coverId`, `regionId` and `schoolId` columns.
  const data: Prisma.CraftUncheckedUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if ("localName" in body) data.localName = nextLocalName;
  if ("localNameLang" in body) data.localNameLang = nextLocalNameLang;
  if ("summary" in body) data.summary = body.summary?.trim() || null;
  if ("body" in body) data.body = jsonColumn(body.body);
  if ("regionId" in body) data.regionId = body.regionId ?? null;
  if ("schoolId" in body) data.schoolId = body.schoolId ?? null;
  if ("originYear" in body) data.originYear = body.originYear ?? null;
  if ("originNote" in body) data.originNote = body.originNote?.trim() || null;
  if (body.materials) {
    data.materials = unique(body.materials.map((entry) => entry.trim()).filter(Boolean));
  }
  if (body.techniques) {
    data.techniques = unique(body.techniques.map((entry) => entry.trim()).filter(Boolean));
  }
  if ("latitude" in body) data.latitude = body.latitude ?? null;
  if ("longitude" in body) data.longitude = body.longitude ?? null;
  if ("coverId" in body) data.coverId = body.coverId ?? null;
  if ("coverScreens" in body) data.coverScreens = jsonColumn(body.coverScreens);
  if ("modelObjectKey" in body) data.modelObjectKey = body.modelObjectKey?.trim() || null;
  if (body.isFeatured !== undefined) data.isFeatured = body.isFeatured;

  if (body.status !== undefined) {
    data.status = body.status;
    // Stamped once, the first time it goes public, and never cleared afterwards.
    if (body.status === "PUBLISHED" && before.publishedAt === null) data.publishedAt = new Date();
  }

  const renamed = body.slug !== undefined && body.slug !== before.slug;
  const shouldRedirect = renamed && body.createRedirect !== false && isLive(before);

  const updated = await mutateWithHistory<Prisma.CraftGetPayload<{ select: typeof INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action:
        body.status === "PUBLISHED" && before.status !== "PUBLISHED"
          ? "PUBLISH"
          : body.status === "ARCHIVED" && before.status !== "ARCHIVED"
            ? "ARCHIVE"
            : "UPDATE",
      entityType: "Craft",
      entityLabel: body.name ?? before.name,
      before,
      summary: renamed ? `Address changed from ${before.slug}` : "Edited"
    },
    async (tx) => {
      if (Object.keys(data).length > 0) await tx.craft.update({ where: { id }, data });
      await replaceCraftMedia(tx, id, body);
      if (shouldRedirect) await recordRename(tx, before.slug, body.slug ?? before.slug);

      const row = await tx.craft.findUniqueOrThrow({ where: { id }, select: INDEX_SELECT });
      await indexDocument(tx, searchDocFromCraft(row));
      return row;
    }
  );

  return ok({
    ...updated,
    ...(shouldRedirect
      ? {
          redirectCreated: {
            from: searchUrlFor("craft", before.slug),
            to: searchUrlFor("craft", updated.slug)
          }
        }
      : {})
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — soft, always
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Removing a craft needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const craft = await prisma.craft.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      modelObjectKey: true,
      _count: { select: { media: true } }
    }
  });
  if (!craft) throw notFound("That craft");

  const wasLive = isLive({ status: craft.status, publishedAt: null });

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "Craft",
      entityLabel: craft.name,
      before: { slug: craft.slug, name: craft.name, status: craft.status },
      revise: false
    },
    async (tx) => {
      const row = await tx.craft.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true }
      });
      /**
       * The picture list stays attached and the photographs themselves are untouched — they belong to the
       * media library, not to this record. The 3D model's bytes are untouched too: nothing here removes an
       * object from storage, and the purge job is the only writer that may.
       */
      await removeDocument(tx, "craft", id);
      return row;
    }
  );

  return ok({
    deleted: true,
    id: craft.id,
    name: craft.name,
    picturesKept: craft._count.media,
    message:
      `“${craft.name}” is in the recycle bin and has gone from the craft explorer. ` +
      (wasLive ? `The address /craft-explorer/${craft.slug} now answers “not found”. ` : "") +
      (craft._count.media > 0
        ? `Its ${craft._count.media === 1 ? "photograph is" : `${craft._count.media} photographs are`} still in the ` +
          "media library and are not affected. "
        : "") +
      (craft.modelObjectKey ? "The 3D model is kept in storage as well. " : "") +
      "Restoring the craft brings the arrangement, the captions and the before-and-after pairing back exactly as it was."
  });
});
