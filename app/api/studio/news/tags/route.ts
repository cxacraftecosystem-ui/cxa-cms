import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canAccessStudio, canManageContent } from "@/lib/permissions";
import {
  assertSlugAvailable,
  buildAuditContext,
  fieldProblem,
  isUniqueViolation,
  parseStudioJson,
  parseStudioQuery,
  requiredText,
  slugSchema
} from "@/lib/studio/crud";
import { slugify } from "@/lib/utils";

/**
 * Tags: the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE DELIBERATE TWIN OF `../categories/route.ts`. A `route.ts` may export nothing but its HTTP handlers
 * and Next's own config fields — the generated check in `.next/types/**` fails the build on anything else —
 * so a shared helper cannot live in either file and be imported by the other. The two are kept in step by
 * hand, exactly as `news/[id]/route.ts` records for its own twin. Read that file's header for the shadowing
 * problem these files fix.
 *
 * ⚠ A TAG IS NOT ONLY A NEWSROOM THING. `Tag` is joined to articles through `PostTag` AND to events through
 * `EventTag` (prisma/schema.prisma), so every count here reports both. The taxonomy screen shows only the
 * article count because it is the newsroom's screen; a tag carrying no articles but three events is NOT
 * unused, and treating it as unused is how an event silently loses its labels.
 *
 * TAGS ARE USUALLY CREATED WHILE WRITING, NOT HERE. `resolveTagIds()` in lib/studio/crud.ts upserts a tag by
 * slug from whatever an author types into an article's tag field, and keeps the first spelling anybody used.
 * This endpoint is the deliberate path — for naming one properly before it is used, and for correcting one.
 *
 * MOST-USED FIRST. Same order as `app/studio/news/taxonomy/page.tsx`: the tags worth tidying are the ones
 * that are actually in use, and a busy newsroom accumulates hundreds. The list is capped and says so.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ The same cap as `NAME_MAX` in `app/studio/news/taxonomy/TaxonomyManager.tsx`. */
const NAME_MAX = 80;

/**
 * How many tags one list answers with. ⚠ The same number as `TAG_LIMIT` in the taxonomy screen, so both
 * halves cap at the same place — and it is REPORTED either way (contract §1.6).
 */
const LIST_LIMIT = 200;

const listQuery = z.object({
  q: z.string().trim().max(NAME_MAX, "That search is too long. Try fewer words.").optional()
});

const createBody = z.object({
  name: requiredText(NAME_MAX, "A tag needs a name. It is what readers see on the tag's own page."),
  /** Optional, and the screen never sends one: the address is derived from the name. See `../categories/route.ts`. */
  slug: z.union([z.literal(""), slugSchema()]).optional()
});

const TAG_SELECT = { id: true, name: true, slug: true } as const satisfies Prisma.TagSelect;

type TagRow = Prisma.TagGetPayload<{ select: typeof TAG_SELECT }>;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET — every tag, with what uses it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async (request: Request) => {
  await requireCapability(canAccessStudio);

  const query = parseStudioQuery(request, listQuery);
  const term = query.q ?? "";

  const where: Prisma.TagWhereInput =
    term.length > 0
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { slug: { contains: term, mode: "insensitive" } }
          ]
        }
      : {};

  const [rows, total] = await prisma.$transaction([
    prisma.tag.findMany({
      where,
      // Most used first, then the name so the order is total and stable between requests.
      orderBy: [{ posts: { _count: "desc" } }, { name: "asc" }],
      take: LIST_LIMIT,
      select: {
        ...TAG_SELECT,
        // `posts` and `events` are the JOIN tables, so each filter reaches through to the record itself.
        // Drafts counted, recycled records not: this is the number a merge's promise is built from.
        _count: {
          select: {
            posts: { where: { post: { deletedAt: null } } },
            events: { where: { event: { deletedAt: null } } }
          }
        }
      }
    }),
    prisma.tag.count({ where })
  ]);

  const items = rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    /** Tags have no description column. `null` so a caller can share one shape with categories. */
    description: null,
    articleCount: row._count.posts,
    /** Events carrying this tag. Not shown on the taxonomy screen, but it is what makes a delete refusable. */
    eventCount: row._count.events
  }));

  return ok({
    items,
    total,
    truncated: total > items.length,
    limit: LIST_LIMIT
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST — add a tag
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Adding a tag from this screen needs editor access or higher. An author can still create one while writing an article. An administrator can raise your access."
  );

  const body = await parseStudioJson(request, createBody);

  const slug = body.slug && body.slug.length > 0 ? body.slug : slugify(body.name);
  if (slug.length === 0) {
    throw fieldProblem(
      "name",
      "That name has no letters or numbers in it, so no web address can be made from it. Include at least one letter or number."
    );
  }

  /**
   * A clash of NAMES as well as of addresses.
   *
   * The address is derived from the name, so this only ever fires for a deliberately-supplied address — but
   * two tags reading "Handloom" in an author's suggestion list is a filing system nobody can use.
   */
  const sameName = await prisma.tag.findFirst({
    where: { name: { equals: body.name, mode: "insensitive" } },
    select: { name: true, slug: true }
  });
  if (sameName) {
    throw conflict(
      `There is already a tag called “${sameName.name}”, at /news/tag/${sameName.slug}. Two tags with the same name cannot be told apart when an author is writing, so use that one or choose a different name.`
    );
  }

  await assertSlugAvailable("tag", slug);

  try {
    const created = await mutateWithHistory<TagRow>(
      buildAuditContext(request, user),
      {
        action: "CREATE",
        entityType: "Tag",
        entityLabel: body.name,
        /**
         * NO REVISION. A tag is two columns, it is hard-deleted rather than kept in the recycle bin, and
         * nothing in the studio shows its history. The audit entry carries the whole row in `after`.
         */
        revise: false
      },
      async (tx) => tx.tag.create({ data: { name: body.name, slug }, select: TAG_SELECT })
    );

    return ok(
      {
        term: {
          id: created.id,
          name: created.name,
          slug: created.slug,
          description: null,
          articleCount: 0,
          eventCount: 0
        },
        message: `“${created.name}” has been added. Its page on the site is /news/tag/${created.slug}, and it will be empty until something carries it.`
      },
      { status: 201 }
    );
  } catch (error) {
    // Two editors added the same tag in the same instant, or an author's article save created it a moment
    // ago through `resolveTagIds`. Either way the unique index refused this one and the honest answer names
    // the row that won.
    if (isUniqueViolation(error)) await assertSlugAvailable("tag", slug);
    throw error;
  }
});
