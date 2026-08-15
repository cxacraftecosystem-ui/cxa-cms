import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok, parseQuery, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageMedia } from "@/lib/permissions";

/**
 * The media library's list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE ANSWER SHAPE IS `MediaListResponse` from components/studio/media/MediaGrid.tsx, and the query
 * string it reads is built by `buildMediaListPath` in the same file. Both the library and the picker
 * call it. The seeded first page in `app/studio/media/page.tsx` builds the identical shape from Prisma
 * directly, so a field added here has to be added there too or the first paint and every paint after
 * it will disagree.
 *
 * TWO FILTERS CANNOT BE DONE ANYWHERE BUT HERE, and that is why they exist as query parameters rather
 * than as something the grid works out:
 *
 *   • `alt` — "needs a description" is `altText IS NULL`, and "decorative" is `altText = ''`. They are
 *     SEPARATE QUERIES because they are separate facts: nobody has written one, versus somebody decided
 *     the picture is decorative and screen readers should skip it. Collapsing them into one number is
 *     what makes an accessibility backlog impossible to clear.
 *   • `unused` — "referenced by nothing" needs a check across every relation that can point at an
 *     asset. A browser holding one page of 48 rows cannot know whether the other four thousand use a
 *     file.
 *
 * ⚠ WHAT `unused` CANNOT SEE, and it is worth knowing before anybody deletes on the strength of it.
 * The check covers every RELATION (covers, galleries, profiles, page SEO images, craft photographs,
 * avatars, partner logos, collections). It cannot cover the two places an asset is referenced by a
 * value rather than by a foreign key: an id embedded in a rich-text document or in a `PageSection.data`
 * payload, and `Craft.modelObjectKey`, which stores a storage key rather than an asset id. So "not used
 * anywhere" means "no record points at it", not "no page mentions it". Deletion is a SOFT delete with a
 * recovery window, which is what makes that residual risk survivable.
 *
 * `altBacklog` IS DELIBERATELY UNFILTERED. It counts the whole library on every page of results,
 * because the banner it feeds is a backlog for the institution rather than a fact about the current
 * search — a count that shrank when somebody typed in the search box would be useless.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 48;

/**
 * Where the count for the `unused` filter stops.
 *
 * That filter is a dozen `NOT EXISTS` subqueries, and counting every matching row across a large
 * library is the one query on this screen that can genuinely be slow. Past the cap the answer carries
 * `totalIsLowerBound`, and `Pagination` renders "of at least N" — a capped count that says so is
 * honest; one that does not is a lie the reader cannot detect (contract §1.6).
 */
const UNUSED_COUNT_CAP = 500;

const MEDIA_KINDS = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "MODEL_3D", "PANORAMA"] as const;

/** The reserved word for "filed in no folder at all" — `buildQuery` drops empty strings, so `folder=` cannot be sent. */
const NO_FOLDER = "none";

/**
 * A bounded whole number from a query string, VALIDATED AS A STRING and converted at the call site.
 *
 * The house pattern, for the reason app/api/public/search/route.ts sets out: `parseQuery` takes a
 * `ZodSchema<T>`, whose input and output are the same `T`, so a `.transform()` or a `.default()` makes
 * the two differ and the call stops type-checking. `.refine()` does not. It also gives a better message
 * than coercion, which answers "?page=abc" with "Expected number, received nan" — a sentence about
 * JavaScript, shown to somebody who edited a URL.
 */
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

/** The paired conversion. Safe because `boundedInt` has already proved the shape and the range. */
function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(MEDIA_KINDS).optional(),
  folder: z.string().trim().max(64).optional(),
  tag: z.string().trim().max(80).optional(),
  alt: z.enum(["missing", "decorative", "described"]).optional(),
  /** Sent as "1" by the toolbar; anything truthy counts. */
  unused: z.enum(["1", "true", "yes"]).optional(),
  sort: z.enum(["created", "name", "size"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: boundedInt("The page number", 1, 100000),
  pageSize: boundedInt("The page size", 1, MAX_PAGE_SIZE)
});

/** The query with its defaults settled, so nothing downstream repeats a `?? "created"`. */
interface MediaListFilters {
  q: string | undefined;
  kind: (typeof MEDIA_KINDS)[number] | undefined;
  folder: string | undefined;
  tag: string | undefined;
  alt: "missing" | "decorative" | "described" | undefined;
  unused: boolean;
  sort: "created" | "name" | "size";
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
}

function readFilters(request: Request): MediaListFilters {
  const raw = parseQuery(request, ListQuery);
  return {
    q: raw.q && raw.q.length > 0 ? raw.q : undefined,
    kind: raw.kind,
    folder: raw.folder,
    tag: raw.tag,
    alt: raw.alt,
    unused: raw.unused !== undefined,
    sort: raw.sort ?? "created",
    dir: raw.dir ?? "desc",
    page: toInt(raw.page, 1),
    pageSize: toInt(raw.pageSize, DEFAULT_PAGE_SIZE)
  };
}

/** Every relation that can point at an asset. `{ none: {} }` on all of them is "referenced by nothing". */
const UNREFERENCED: Prisma.MediaAssetWhereInput = {
  userAvatars: { none: {} },
  pageSeoImages: { none: {} },
  personPhotos: { none: {} },
  projectCovers: { none: {} },
  projectGallery: { none: {} },
  postCovers: { none: {} },
  eventCovers: { none: {} },
  eventGallery: { none: {} },
  partnerLogos: { none: {} },
  craftImages: { none: {} },
  craftCovers: { none: {} },
  albumCovers: { none: {} },
  albumItems: { none: {} },
  researchAreaCovers: { none: {} },
  collections: { none: {} }
};

const VARIANT_SELECT = {
  select: { label: true, format: true, objectKey: true, width: true },
  orderBy: { width: "asc" as const }
};

function buildWhere(query: MediaListFilters): Prisma.MediaAssetWhereInput {
  // The recycle bin is filtered out everywhere. A soft-deleted asset belongs to /studio/recycle-bin,
  // and a library that offered it would be offering a file that no longer appears on the site.
  const where: Prisma.MediaAssetWhereInput = { deletedAt: null };
  const and: Prisma.MediaAssetWhereInput[] = [];

  if (query.kind) where.kind = query.kind;

  if (query.folder === NO_FOLDER) where.folderId = null;
  else if (query.folder) where.folderId = query.folder;

  if (query.tag) where.tags = { has: query.tag };

  if (query.q && query.q.length > 0) {
    // The filename first, because that is what somebody who uploaded it remembers. The description and
    // caption are searched too — an editor looking for "the indigo dyeing photograph" typed the
    // description, not "IMG_0421.jpg".
    and.push({
      OR: [
        { fileName: { contains: query.q, mode: "insensitive" } },
        { altText: { contains: query.q, mode: "insensitive" } },
        { caption: { contains: query.q, mode: "insensitive" } },
        { credit: { contains: query.q, mode: "insensitive" } },
        { tags: { has: query.q } }
      ]
    });
  }

  if (query.alt === "missing") {
    where.altText = null;
  } else if (query.alt === "decorative") {
    where.altText = "";
  } else if (query.alt === "described") {
    // Spelled out as two conditions rather than one `not`. On a nullable column a single `<> ''`
    // comparison is NULL-unsafe, and which way it falls is a fact about the driver rather than about
    // the intent — so the intent is written down.
    and.push({ altText: { not: null } }, { altText: { not: "" } });
  }

  if (query.unused) Object.assign(where, UNREFERENCED);

  if (and.length > 0) where.AND = and;
  return where;
}

export const GET = route(async (request: Request) => {
  // A read, so no same-origin assertion — but the answer names unpublished work and files that are not
  // public, which is not public information. The capability is the same one the media screen calls.
  await requireCapability(
    canManageMedia,
    "The media library needs media manager access or higher. An administrator can raise yours."
  );

  const query = readFilters(request);
  const where = buildWhere(query);

  const orderBy: Prisma.MediaAssetOrderByWithRelationInput[] =
    query.sort === "name"
      ? [{ fileName: query.dir }, { id: "asc" }]
      : query.sort === "size"
        ? [{ byteSize: query.dir }, { id: "asc" }]
        : [{ createdAt: query.dir }, { id: "asc" }];

  const items = await prisma.mediaAsset.findMany({
    where,
    orderBy,
    skip: (query.page - 1) * query.pageSize,
    take: query.pageSize,
    include: { variants: VARIANT_SELECT }
  });

  // The count. For the ordinary filters a plain `count` is cheap; for `unused` it is a dozen subqueries
  // over the whole table, so it is bounded and the bound is declared.
  let total: number;
  let totalIsLowerBound = false;
  if (query.unused) {
    const ids = await prisma.mediaAsset.findMany({
      where,
      select: { id: true },
      take: UNUSED_COUNT_CAP + 1
    });
    totalIsLowerBound = ids.length > UNUSED_COUNT_CAP;
    total = totalIsLowerBound ? UNUSED_COUNT_CAP : ids.length;
  } else {
    total = await prisma.mediaAsset.count({ where });
  }

  // Two counts, not one. See the header.
  const backlogWhere = {
    deletedAt: null,
    kind: { in: ["IMAGE", "PANORAMA"] as const }
  } satisfies Prisma.MediaAssetWhereInput;

  const [missing, decorative] = await Promise.all([
    prisma.mediaAsset.count({ where: { ...backlogWhere, altText: null } }),
    prisma.mediaAsset.count({ where: { ...backlogWhere, altText: "" } })
  ]);

  return ok({
    items,
    total,
    totalIsLowerBound,
    page: query.page,
    pageSize: query.pageSize,
    altBacklog: { missing, decorative }
  });
});
