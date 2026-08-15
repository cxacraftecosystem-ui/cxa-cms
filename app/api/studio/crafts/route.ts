import type { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  conflict,
  forbidden,
  ok,
  parseJson,
  parseQuery,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { indexDocument, searchDocFromCraft } from "@/lib/search/index";
import { isSafeObjectKey } from "@/lib/storage/keys";
import { unique } from "@/lib/utils";

/**
 * Crafts: the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE LOCAL NAME AND ITS LANGUAGE TRAVEL TOGETHER. A name in Devanagari, Tamil or Bengali is marked up
 * with `lang` on the public site, and that attribute is what tells a screen reader to switch voice.
 * Without it the reader's English voice attempts the script letter by letter and produces sounds that are
 * not words in either language — so a local name with no language recorded is WORSE than no local name at
 * all. This route therefore refuses one without the other, in both directions.
 *
 * A NEGATIVE `originYear` MEANS BCE and is stored as a plain negative integer, exactly as the schema
 * says. Nothing here rewrites it; the editor's readout is what confirms the convention before it is saved.
 *
 * THE BEFORE-AND-AFTER PAIRING IS MADE BY ORDER AND POSITION IS THEREFORE LOAD-BEARING. `CraftMedia` has
 * no column linking one half of a pair to the other: a "before" pairs with the NEXT "after" below it, and
 * the media list is written with explicit positions taken from the array order. The rule is implemented
 * in two other places as well — the editor's rows and `components/site/BeforeAfterSlider.tsx` — and all
 * three must agree, because the editor's whole value is that it predicts what the page will do.
 *
 * `modelObjectKey` IS A STORAGE KEY, NOT A URL, and it is checked against `isSafeObjectKey` plus the
 * `models` or `media` namespace. A key from a client is the one place a path could escape its prefix.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
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

/**
 * A BCP 47 language tag, loosely.
 *
 * "hi", "ta", "bn", "hi-Deva" — checked for shape rather than against a registry: the registry has
 * thousands of entries and a craft's language is occasionally a regional tag nobody has heard of. The
 * shape is enough to keep the value usable as a `lang` attribute, which is the only thing it is for.
 */
const languageField = z
  .string()
  .trim()
  .max(20)
  .regex(
    /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    "A language tag looks like “hi”, “ta” or “hi-Deva” — the two- or three-letter code for the language."
  )
  .nullable();

const CraftBody = z.object({
  name: z.string().trim().min(1, "The craft needs a name.").max(300).optional(),
  slug: slugField.optional(),
  localName: z.string().trim().max(300).nullable().optional(),
  localNameLang: languageField.optional(),
  summary: z.string().trim().max(3000).nullable().optional(),
  body: richTextField.optional(),
  regionId: idField.nullable().optional(),
  schoolId: idField.nullable().optional(),
  /** Negative is BCE. Bounded so a mistyped year is caught rather than filed under the year 30000. */
  originYear: z.number().int().min(-6000).max(new Date().getUTCFullYear()).nullable().optional(),
  originNote: z.string().trim().max(600).nullable().optional(),
  materials: z.array(z.string().trim().min(1).max(120)).max(MAX_LIST).optional(),
  techniques: z.array(z.string().trim().min(1).max(120)).max(MAX_LIST).optional(),
  latitude: z.number().min(-90, "A latitude is between -90 and 90.").max(90, "A latitude is between -90 and 90.").nullable().optional(),
  longitude: z
    .number()
    .min(-180, "A longitude is between -180 and 180.")
    .max(180, "A longitude is between -180 and 180.")
    .nullable()
    .optional(),
  coverId: idField.nullable().optional(),
  media: z
    .array(
      z.object({
        assetId: idField,
        caption: z.string().trim().max(600).nullable().optional(),
        /** `null` for an ordinary photograph. The renderer compares against these two words exactly. */
        restorationPhase: z.enum(["before", "after"]).nullable().optional()
      })
    )
    .max(MAX_MEDIA, `A craft can hold up to ${MAX_MEDIA} pictures.`)
    .optional(),
  modelObjectKey: z.string().trim().max(1024).nullable().optional(),
  isFeatured: z.boolean().optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  createRedirect: z.boolean().optional()
});

type CraftInput = z.infer<typeof CraftBody>;

/** The columns `searchDocFromCraft` reads, plus the region and school names it folds into the keywords. */
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

/**
 * The local name and its language are refused separately, in both directions, with the reason.
 *
 * See the header: a name in another script with no language recorded is read aloud by the wrong voice,
 * which is a worse outcome than not recording the name at all. And a language with no name is a value
 * that will never be used, which is a sign the editor meant to type something.
 */
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

/** A craft's 3D model lives under `models/` or, historically, `media/`. Anything else could escape its prefix. */
function assertModelKey(key: string | null): void {
  if (!key) return;
  if (!isSafeObjectKey(key) || !/^(models|media)\//.test(key)) {
    throw badRequest("That 3D model address is not one this site issues. Upload the model again.");
  }
}

async function assertCraftReferences(body: CraftInput): Promise<void> {
  if (body.regionId) {
    const region = await prisma.craftRegion.findUnique({
      where: { id: body.regionId },
      select: { id: true }
    });
    if (!region) throw badRequest("The region this craft was filed under no longer exists. Choose another.");
  }

  if (body.schoolId) {
    const school = await prisma.craftSchool.findUnique({
      where: { id: body.schoolId },
      select: { id: true }
    });
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

    // Named rather than counted, and refused rather than dropped: an editor who arranged eight
    // photographs and finds six on the page has been lied to by the save (contract §1.6).
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

/**
 * Replace the picture list, with positions taken from the array order.
 *
 * The position is the PAIRING EVIDENCE for the before-and-after slider, so it is explicit rather than
 * implied, and the whole set is replaced rather than merged: a diff that got one row wrong would pair a
 * "before" with the wrong "after" and the comparison would show two unrelated photographs.
 */
async function replaceCraftMedia(tx: TxClient, craftId: string, body: CraftInput): Promise<void> {
  if (!body.media) return;

  // `@@id([craftId, assetId])` means one row per picture; a duplicated pick keeps its first position.
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
        // `null`, never "": the column is nullable and the renderer compares against the words exactly.
        restorationPhase: entry.restorationPhase ?? null,
        position
      }))
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const boundedInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,6}$/, `${label} has to be a whole number.`)
    .refine((value) => {
      const parsed = Number.parseInt(value, 10);
      return parsed >= min && parsed <= max;
    }, `${label} has to be between ${min} and ${max}.`)
    .optional();

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  region: z.string().trim().max(64).optional(),
  school: z.string().trim().max(64).optional(),
  page: boundedInt("The page number", 1, 100000),
  pageSize: boundedInt("The page size", 1, MAX_PAGE_SIZE)
});

export const GET = route(async (request: Request) => {
  await requireCapability(
    canManageResearch,
    "The craft archive needs researcher access or higher. An administrator can raise yours."
  );

  const raw = parseQuery(request, ListQuery);
  const page = toInt(raw.page, 1);
  const pageSize = toInt(raw.pageSize, DEFAULT_PAGE_SIZE);

  const where: Prisma.CraftWhereInput = { deletedAt: null };
  if (raw.status) where.status = raw.status;
  if (raw.region) where.regionId = raw.region;
  if (raw.school) where.schoolId = raw.school;
  if (raw.q) {
    where.OR = [
      { name: { contains: raw.q, mode: "insensitive" } },
      // The local name is searched AS WRITTEN, in its own script — somebody who types it should find the
      // craft even though the English name is what the row shows.
      { localName: { contains: raw.q, mode: "insensitive" } },
      { summary: { contains: raw.q, mode: "insensitive" } },
      { slug: { contains: raw.q, mode: "insensitive" } }
    ];
  }

  const [items, total] = await Promise.all([
    prisma.craft.findMany({
      where,
      // Featured first, then alphabetical. Total and stable, so the list never reshuffles.
      orderBy: [{ isFeatured: "desc" }, { name: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        slug: true,
        name: true,
        localName: true,
        localNameLang: true,
        summary: true,
        originYear: true,
        coverId: true,
        modelObjectKey: true,
        isFeatured: true,
        status: true,
        publishedAt: true,
        updatedAt: true,
        region: { select: { id: true, name: true } },
        school: { select: { id: true, name: true } },
        _count: { select: { media: true } }
      }
    }),
    prisma.craft.count({ where })
  ]);

  return ok({ items, total, page, pageSize });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Creating a craft needs researcher access or higher. An administrator can raise yours."
  );

  const body = await parseJson(request, CraftBody);

  if (!body.name) throw badRequest("The craft needs a name before it can be created.");
  if (!body.slug) throw badRequest("The craft needs a web address before it can be created.");

  const status = body.status ?? "DRAFT";
  if ((status === "PUBLISHED" || status === "SCHEDULED") && !canPublish(user)) {
    throw forbidden(
      "Publishing needs editor access, or permission to publish granted by an administrator. " +
        "Save it as a draft and ask an editor to publish it."
    );
  }

  assertLocalNamePair(body.localName?.trim() || null, body.localNameLang ?? null);
  assertModelKey(body.modelObjectKey?.trim() || null);

  const taken = await prisma.craft.findUnique({
    where: { slug: body.slug },
    select: { id: true, name: true, deletedAt: true }
  });
  if (taken) {
    throw conflict(
      taken.deletedAt
        ? `The address /craft-explorer/${body.slug} belongs to “${taken.name}”, which is in the recycle bin. Restore it, or choose a different address.`
        : `The address /craft-explorer/${body.slug} is already used by “${taken.name}”. Choose a different one.`
    );
  }

  await assertCraftReferences(body);

  const name = body.name;
  const slug = body.slug;

  const created = await mutateWithHistory<Prisma.CraftGetPayload<{ select: typeof INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    { action: "CREATE", entityType: "Craft", entityLabel: name, summary: "Created" },
    async (tx) => {
      const craft = await tx.craft.create({
        data: {
          name,
          slug,
          localName: body.localName?.trim() || null,
          localNameLang: body.localNameLang ?? null,
          summary: body.summary?.trim() || null,
          body: jsonColumn(body.body),
          regionId: body.regionId ?? null,
          schoolId: body.schoolId ?? null,
          originYear: body.originYear ?? null,
          originNote: body.originNote?.trim() || null,
          materials: unique((body.materials ?? []).map((entry) => entry.trim()).filter(Boolean)),
          techniques: unique((body.techniques ?? []).map((entry) => entry.trim()).filter(Boolean)),
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          coverId: body.coverId ?? null,
          modelObjectKey: body.modelObjectKey?.trim() || null,
          isFeatured: body.isFeatured ?? false,
          status,
          publishedAt: status === "PUBLISHED" ? new Date() : null
        },
        select: { id: true }
      });

      await replaceCraftMedia(tx, craft.id, body);

      const row = await tx.craft.findUniqueOrThrow({ where: { id: craft.id }, select: INDEX_SELECT });
      await indexDocument(tx, searchDocFromCraft(row));
      return row;
    }
  );

  return ok(created, { status: 201 });
});
