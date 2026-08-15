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
  optionalText,
  parseStudioJson,
  parseStudioQuery,
  requiredText,
  slugSchema
} from "@/lib/studio/crud";
import { slugify } from "@/lib/utils";

/**
 * News categories: the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS FILE'S EXISTENCE IS THE FIX FOR A 405, NOT A NEW FEATURE.
 *
 * `app/api/studio/news/[id]/route.ts` was already there, so every request the taxonomy screen sent to
 * `/api/studio/news/categories` resolved to it with `id="categories"` — a GET answered "that article could
 * not be found" and a POST answered 405, because that file exports no POST. A STATIC segment always beats a
 * dynamic one (contract §13b), so the mere presence of this file re-points the whole path.
 *
 * Nothing under `news/[id]` can mistake a category id for an article id in the other direction either: every
 * lookup there is `prisma.post.findUnique({ where: { id } })` against the `posts` table, so a `Category` id
 * simply finds nothing and answers 404. There is no lookup by slug or by name anywhere in that file.
 *
 * ⚠ WHY THE CATEGORY AND TAG HANDLERS ARE TWINS RATHER THAN ONE SHARED MODULE.
 *
 * A `route.ts` may export NOTHING but its HTTP handlers and Next's own config fields — the generated type
 * check in `.next/types/**` fails the build on any other export ("is not a valid Route export field"), which
 * is the same constraint `news/[id]/route.ts` records in its own header. So a helper living in this file
 * cannot be imported by `../tags/route.ts`, and the six taxonomy handlers are DELIBERATE TWINS kept in step
 * by hand. Where the two differ, they differ for a reason stated in the file:
 *
 *   • a category has a `description`; a tag does not (there is no column),
 *   • a category belongs to articles only; a TAG IS ALSO USED BY EVENTS, so every count and every move in
 *     the tag handlers covers `EventTag` as well.
 *
 * THE COUNT COMES FROM `_count`, WITH THE RECYCLE BIN FILTERED OUT. It is the number the screen prints in
 * the sentence "14 articles move to Craft", so it must mean exactly what `app/studio/news/taxonomy/page.tsx`
 * means by it — drafts included, deleted articles excluded. Loading the relations to count them would read
 * every article's body to produce one integer.
 *
 * A DUPLICATE IS A 409 THAT NAMES THE TERM THAT ALREADY HAS IT. "That address is taken" leaves an editor
 * guessing which of twenty categories to go and look at.
 *
 * READING IS OPEN TO THE WHOLE STUDIO; CHANGING IS AN EDITOR'S JOB. Category names are public — they are
 * printed on the site — and an author filing an article needs the vocabulary. Renaming, merging and removing
 * change what every other author sees, which is why the screen itself is `canManageContent`
 * (app/studio/news/taxonomy/page.tsx) and so is every mutation here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ The same caps as `NAME_MAX` / `DESCRIPTION_MAX` in `app/studio/news/taxonomy/TaxonomyManager.tsx`. */
const NAME_MAX = 80;
const DESCRIPTION_MAX = 240;

/**
 * How many terms one list answers with.
 *
 * A newsroom has tens of categories, not thousands, so this is a safety bound rather than a page size —
 * but it is still REPORTED (`truncated`), because a list that quietly stops is indistinguishable from a
 * place with no records (contract §1.6).
 */
const LIST_LIMIT = 200;

const listQuery = z.object({
  q: z.string().trim().max(NAME_MAX, "That search is too long. Try fewer words.").optional()
});

const createBody = z.object({
  name: requiredText(
    NAME_MAX,
    "A category needs a name. It is what readers see in the list and at the top of its own page."
  ),
  /**
   * Optional, and the screen never sends one: the address is derived from the name.
   *
   * It is accepted so an import or a correction can set one deliberately. `""` is read as "not given"
   * rather than refused, because that is what an emptied field sends.
   */
  slug: z.union([z.literal(""), slugSchema()]).optional(),
  description: optionalText(DESCRIPTION_MAX)
});

const CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  sortOrder: true
} as const satisfies Prisma.CategorySelect;

type CategoryRow = Prisma.CategoryGetPayload<{ select: typeof CATEGORY_SELECT }>;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET — every category, with the number of articles filed under each
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async (request: Request) => {
  await requireCapability(canAccessStudio);

  const query = parseStudioQuery(request, listQuery);
  const term = query.q ?? "";

  const where: Prisma.CategoryWhereInput =
    term.length > 0
      ? {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { slug: { contains: term, mode: "insensitive" } }
          ]
        }
      : {};

  const [rows, total] = await prisma.$transaction([
    prisma.category.findMany({
      where,
      // The editorial order first, then the name, so the order is TOTAL and the list cannot reshuffle
      // between two requests — an unstable sort reads as data changing. Same order as the studio screen.
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      take: LIST_LIMIT,
      select: {
        ...CATEGORY_SELECT,
        // Drafts counted, recycled articles not: see the header.
        _count: { select: { posts: { where: { deletedAt: null } } } }
      }
    }),
    prisma.category.count({ where })
  ]);

  const items = rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    articleCount: row._count.posts
  }));

  return ok({
    items,
    total,
    /**
     * No `page` or `pageCount` here on purpose. This endpoint answers one bounded list and nothing else;
     * reporting a page count above 1 would promise a second page it cannot serve.
     */
    truncated: total > items.length,
    limit: LIST_LIMIT
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST — add a category
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Adding a category needs editor access or higher, because every author files articles under it. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, createBody);

  const slug = body.slug && body.slug.length > 0 ? body.slug : slugify(body.name);
  if (slug.length === 0) {
    // "🎉" or "———" slugifies to nothing, and an empty address would collide with whatever got there
    // first through the unique index. Refused against the field the reader just typed in.
    throw fieldProblem(
      "name",
      "That name has no letters or numbers in it, so no web address can be made from it. Include at least one letter or number."
    );
  }

  /**
   * A CLASH OF NAMES, not only of addresses.
   *
   * The address check below catches almost every duplicate, because the address is derived from the name.
   * It does NOT catch a deliberately-supplied address: "Research" at `/research-2026` alongside "Research"
   * at `/research` would give the article editor two identical entries in one dropdown and no way to tell
   * which is which.
   */
  const sameName = await prisma.category.findFirst({
    where: { name: { equals: body.name, mode: "insensitive" } },
    select: { id: true, name: true, slug: true }
  });
  if (sameName) {
    throw conflict(
      `There is already a category called “${sameName.name}”, at /news/category/${sameName.slug}. Two categories with the same name cannot be told apart when an author files an article, so use that one or choose a different name.`
    );
  }

  await assertSlugAvailable("category", slug);

  try {
    const created = await mutateWithHistory<CategoryRow>(
      buildAuditContext(request, user),
      {
        action: "CREATE",
        entityType: "Category",
        entityLabel: body.name,
        /**
         * NO REVISION. A category is three short columns, it is hard-deleted rather than kept in the
         * recycle bin, and nothing in the studio shows its history — so a revision would be a copy nobody
         * can reach. The audit entry already carries the whole row in `after`, which is what an
         * administrator reads when they ask where a category came from.
         */
        revise: false
      },
      async (tx) =>
        tx.category.create({
          data: { name: body.name, slug, description: body.description },
          select: CATEGORY_SELECT
        })
    );

    return ok(
      {
        term: {
          id: created.id,
          name: created.name,
          slug: created.slug,
          description: created.description,
          articleCount: 0
        },
        message: `“${created.name}” has been added. Its page on the site is /news/category/${created.slug}, and it will be empty until an article is filed under it.`
      },
      { status: 201 }
    );
  } catch (error) {
    // Two editors added the same category in the same instant. The check above passed for both and the
    // unique index refused the second, which is what it is for; the honest answer is the one that names
    // the row that won.
    if (isUniqueViolation(error)) await assertSlugAvailable("category", slug);
    throw error;
  }
});
