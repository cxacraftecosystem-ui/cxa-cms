import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import {
  assertSlugAvailable,
  buildAuditContext,
  found,
  isUniqueViolation,
  optionalText,
  parseStudioJson,
  requiredText,
  slugSchema,
  syncSearchDocument
} from "@/lib/studio/crud";

/**
 * One news category: rename it, or remove it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A RENAME CHANGES WHAT THE SITE'S OWN SEARCH MATCHES, so the articles are re-indexed here.
 *
 * `searchDocFromPost()` in lib/search/index.ts folds `category.name` into a post's `keywords`, and
 * `indexDocument()` concatenates the keywords into the indexed text. So the words an article matches depend
 * on the name of the category it is filed under, and renaming "Textiles" to "Textile craft" leaves every
 * article in it findable under a name that no longer exists — and NOT findable under the new one. The
 * re-index therefore happens in the SAME transaction as the rename (contract §9), so a rolled-back rename
 * cannot leave the index describing a name nobody chose.
 *
 * A change of ADDRESS does not touch the index: a post's indexed URL is built from the POST's own slug, and
 * the category's slug appears nowhere in its search document.
 *
 * ⚠ RENAMING DOES NOT CHANGE THE ADDRESS, AND THE SCREEN PROMISES THAT. `TaxonomyManager` sends only a name
 * and tells the reader "the web address is still /…, so existing links keep working". A `slug` is accepted
 * here for an import or a deliberate correction, and when one is given the response reports HOW MANY
 * ARTICLES sit at the old address so a caller can warn before committing — `/news/category/textiles` is a
 * link somebody may have printed.
 *
 * A CATEGORY IN USE IS NOT DELETED. Deleting one sets `Post.categoryId` to NULL (the relation is
 * `onDelete: SetNull` in prisma/schema.prisma), so the delete would succeed and quietly unfile fourteen
 * articles. The refusal therefore carries the count and the way forward, which is what the screen turns into
 * "move its articles, then delete".
 *
 * ⚠ THE REFUSAL COUNTS THE SAME ARTICLES THE SCREEN COUNTS — live ones, drafts included, recycle bin
 * excluded. The screen decides whether to offer "Delete it" or "Move its articles first" from that number,
 * so a server counting a different set would refuse an action the screen had just offered. Articles sitting
 * in the recycle bin under this category are reported separately rather than blocking the delete: restoring
 * one will need a category chosen again, and saying so is better than refusing a delete for a row nobody can
 * see.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ The same caps as `TaxonomyManager.tsx` and `../route.ts`. */
const NAME_MAX = 80;
const DESCRIPTION_MAX = 240;

/**
 * How many articles one rename will re-index inside its transaction.
 *
 * The rename itself is never capped — it is one row. This bounds only the search work, so a category
 * holding thousands of articles cannot hold a write transaction open for the length of a full re-index.
 * When it bites it is REPORTED, with the remedy (contract §1.6): the rest of the index catches up on the
 * next rebuild from Settings, and until then those articles are still findable by their own words.
 */
const REINDEX_LIMIT = 500;

const patchBody = z.object({
  name: requiredText(NAME_MAX, "A category needs a name.").optional(),
  slug: slugSchema().optional(),
  description: optionalText(DESCRIPTION_MAX).optional()
});

const CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  sortOrder: true
} as const satisfies Prisma.CategorySelect;

type CategoryRow = Prisma.CategoryGetPayload<{ select: typeof CATEGORY_SELECT }>;

/**
 * The columns `searchDocFromPost` reads, plus the four that resolve publication state.
 *
 * ⚠ A twin of the select in `news/[id]/route.ts` — a `route.ts` may export nothing but its handlers, so the
 * two are kept in step by hand. A column missing here is not a type error; it is a search document that
 * silently loses a field.
 */
const POST_INDEX_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  excerpt: true,
  body: true,
  mdx: true,
  status: true,
  publishedAt: true,
  publishAt: true,
  unpublishAt: true,
  deletedAt: true,
  category: { select: { name: true } },
  tags: { select: { tag: { select: { name: true } } } }
} as const satisfies Prisma.PostSelect;

/**
 * Re-index articles, inside the caller's transaction.
 *
 * ONE `now` for the whole batch, so a long run cannot resolve publication state against a drifting clock
 * and mark the first half live and the second half not.
 */
async function reindexPosts(tx: TxClient, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx.post.findMany({
    where: { id: { in: [...ids] } },
    select: POST_INDEX_SELECT
  });
  const now = new Date();
  for (const row of rows) await syncSearchDocument(tx, "post", row, now);
  return rows.length;
}

/** "1 article" / "14 articles". Written out because an English plural is not a suffix rule worth guessing. */
function articles(count: number): string {
  return count === 1 ? "1 article" : `${count} articles`;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — rename, re-describe, and (deliberately) re-address
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Renaming a category needs editor access or higher, because it changes what every author sees. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, patchBody);

  const existing = found(
    await prisma.category.findUnique({
      where: { id },
      select: {
        ...CATEGORY_SELECT,
        _count: { select: { posts: { where: { deletedAt: null } } } }
      }
    }),
    "That category"
  );

  const nextName = body.name ?? existing.name;
  const nextSlug = body.slug ?? existing.slug;
  const nameChanged = nextName !== existing.name;
  const slugChanged = nextSlug !== existing.slug;
  // Compared rather than merely "was it sent": the screen sends the description on every save, so treating a
  // sent value as a change would write the row and report a change for a dialog nobody altered.
  const descriptionChanged =
    body.description !== undefined && body.description !== existing.description;
  const affected = existing._count.posts;

  if (nameChanged) {
    // Same reasoning as the create: two categories with one name cannot be told apart in the editor's
    // dropdown. `excludeId` is this row, so saving without changing the name is never a collision.
    const sameName = await prisma.category.findFirst({
      where: { name: { equals: nextName, mode: "insensitive" }, id: { not: id } },
      select: { name: true, slug: true }
    });
    if (sameName) {
      throw conflict(
        `There is already a category called “${sameName.name}”, at /news/category/${sameName.slug}. Two categories with the same name cannot be told apart when an author files an article, so choose a different name — or merge this one into that one.`
      );
    }
  }

  if (slugChanged) await assertSlugAvailable("category", nextSlug, id);

  if (!nameChanged && !slugChanged && !descriptionChanged) {
    // Nothing was different. Answered as success rather than as an error: the screen has already closed its
    // dialog, and a refusal would report a failure for a save that had nothing to do.
    return ok({
      term: {
        id: existing.id,
        name: existing.name,
        slug: existing.slug,
        description: existing.description,
        articleCount: affected
      },
      changed: false,
      renamed: false,
      addressChanged: false,
      affectedArticles: affected,
      reindexed: 0,
      reindexTruncated: false,
      message: "Nothing was different, so nothing has been changed."
    });
  }

  let reindexed = 0;
  let reindexTruncated = false;

  try {
    const updated = await mutateWithHistory<CategoryRow>(
      buildAuditContext(request, user),
      {
        action: "UPDATE",
        entityType: "Category",
        entityLabel: nextName,
        // The three columns only. `_count` is a derived number, not part of the row's state, and putting it
        // in `before` would make a snapshot that cannot be written back.
        before: { name: existing.name, slug: existing.slug, description: existing.description },
        revise: false
      },
      async (tx) => {
        const row = await tx.category.update({
          where: { id },
          data: {
            ...(nameChanged ? { name: nextName } : {}),
            ...(slugChanged ? { slug: nextSlug } : {}),
            ...(descriptionChanged ? { description: body.description ?? null } : {})
          },
          select: CATEGORY_SELECT
        });

        if (nameChanged) {
          // Only the LIVE articles: a soft-deleted one is not in the index at all (lib/search/index.ts), so
          // re-indexing it would put a recycled article into search results.
          const ids = await tx.post.findMany({
            where: { categoryId: id, deletedAt: null },
            select: { id: true },
            take: REINDEX_LIMIT + 1
          });
          reindexTruncated = ids.length > REINDEX_LIMIT;
          reindexed = await reindexPosts(
            tx,
            ids.slice(0, REINDEX_LIMIT).map((post) => post.id)
          );
        }

        return row;
      }
    );

    const parts: string[] = [];
    if (nameChanged) parts.push(`The category is now called “${updated.name}”.`);
    if (descriptionChanged) {
      parts.push(
        updated.description === null
          ? "The description has been cleared, so its page has no introduction now."
          : "The description has been saved."
      );
    }
    if (slugChanged) {
      parts.push(
        affected > 0
          ? `Its page has moved to /news/category/${updated.slug}. ${articles(affected)} ${affected === 1 ? "is" : "are"} filed under it, and any link to the old address /news/category/${existing.slug} will stop working — add a redirect if it was published anywhere.`
          : `Its page has moved to /news/category/${updated.slug}. Nothing is filed under it, so no article's address changes.`
      );
    } else if (nameChanged) {
      parts.push(
        `The web address is still /news/category/${updated.slug}, so links and bookmarks keep working.`
      );
    }
    if (reindexTruncated) {
      parts.push(
        `The site's own search has been brought up to date for ${articles(reindexed)}; there are more than that in this category, and the rest catch up the next time the search index is rebuilt. They are still findable by their own words in the meantime.`
      );
    }

    return ok({
      term: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        description: updated.description,
        articleCount: affected
      },
      changed: true,
      renamed: nameChanged,
      addressChanged: slugChanged,
      /** How many articles a change of address moves. The number a caller warns with before committing. */
      affectedArticles: affected,
      reindexed,
      reindexTruncated,
      message: parts.join(" ")
    });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("category", nextSlug, id);
    throw error;
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — only when nothing is filed under it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Removing a category needs editor access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const existing = found(
    await prisma.category.findUnique({
      where: { id },
      select: {
        ...CATEGORY_SELECT,
        _count: { select: { posts: { where: { deletedAt: null } } } }
      }
    }),
    "That category"
  );

  const inUse = existing._count.posts;
  const recycled = await prisma.post.count({
    where: { categoryId: id, deletedAt: { not: null } }
  });

  if (inUse > 0) {
    /**
     * THE COUNT IS IN THE REFUSAL, and so is the way forward.
     *
     * A 409 saying only "this category is in use" leaves the reader with no idea whether it is one article
     * or two hundred, and no idea what to do next. Both are one sentence away.
     */
    throw conflict(
      `“${existing.name}” cannot be removed while ${articles(inUse)} ${inUse === 1 ? "is" : "are"} filed under it — ${inUse === 1 ? "it" : "they"} would be left unfiled. Move ${inUse === 1 ? "it" : "them"} to another category first, or merge this category into another one, which moves ${inUse === 1 ? "it" : "them"} and removes this category in one step.`
    );
  }

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "Category",
      entityLabel: existing.name,
      // The whole row, because this is the only record of it that survives: a category is HARD-deleted (it
      // has no `deletedAt` column and no recycle bin), so the audit entry is where an administrator reads
      // what was removed.
      before: {
        name: existing.name,
        slug: existing.slug,
        description: existing.description,
        articlesInRecycleBin: recycled
      },
      revise: false
    },
    async (tx) => {
      await tx.category.delete({ where: { id } });
      // Nothing to re-index: no live article was filed under it, and a recycled article is not in the index
      // in the first place.
      return { id };
    }
  );

  return ok({
    deleted: true,
    name: existing.name,
    slug: existing.slug,
    /** Recycled articles that have just lost their filing. Stated because nobody can see them from here. */
    articlesInRecycleBin: recycled,
    message:
      `“${existing.name}” has been removed, and /news/category/${existing.slug} no longer exists.` +
      (recycled > 0
        ? ` ${articles(recycled)} in the recycle bin ${recycled === 1 ? "was" : "were"} filed under it, so restoring ${recycled === 1 ? "it" : "them"} will need a category choosing again.`
        : "")
  });
});
