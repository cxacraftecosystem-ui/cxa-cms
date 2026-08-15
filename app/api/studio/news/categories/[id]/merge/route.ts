import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, ok, route } from "@/lib/api";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import {
  buildAuditContext,
  fieldProblem,
  found,
  parseStudioJson,
  syncSearchDocument
} from "@/lib/studio/crud";

/**
 * Merge one news category into another: move every article, then remove the category — in ONE transaction.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE TRANSACTION IS THE WHOLE POINT. The move and the removal are two statements describing one decision;
 * committed separately, a failure between them leaves either a category nobody can reach holding articles,
 * or articles unfiled with the category still there. Both are worse than the merge not happening.
 *
 * ⚠ MERGING A CATEGORY INTO ITSELF IS REFUSED. It reads as a harmless no-op and is the opposite: every
 * article would be "moved" to the category that is about to be deleted, and the delete would then unfile all
 * of them (`Post.categoryId` is `onDelete: SetNull`). It is refused against the field the reader chose in,
 * so the dialog can say which box is wrong.
 *
 * ARTICLES IN THE RECYCLE BIN MOVE TOO, and they are counted separately.
 *
 * They must move: the source category is about to cease to exist, and a recycled article still pointing at
 * it would be silently unfiled the moment it goes. They are counted separately because the screen's promise
 * — "14 articles move to Craft" — is about the articles a reader can see, and the two numbers answer
 * different questions.
 *
 * THE MOVED ARTICLES ARE RE-INDEXED, because a category's name is part of what its articles match.
 * `searchDocFromPost()` folds `category.name` into each post's keywords (lib/search/index.ts), so after a
 * merge every moved article should match the surviving name and stop matching the removed one. The re-index
 * runs inside the same transaction as the move (contract §9).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many moved articles are re-indexed inside the transaction.
 *
 * ⚠ THE MOVE IS NEVER CAPPED — every article is re-filed, whatever the number. This bounds only the search
 * work, so merging a category holding thousands of articles cannot hold one write transaction open for the
 * length of a full re-index. When it bites it is reported with the remedy (contract §1.6).
 */
const REINDEX_LIMIT = 500;

const mergeBody = z.object({
  /** The category the articles end up in. The screen calls this "Move the articles to". */
  intoId: z
    .string({ invalid_type_error: "Choose which category the articles should move to." })
    .trim()
    .min(1, "Choose which category the articles should move to.")
    .max(40, "That does not look like a reference to a category.")
});

/**
 * ⚠ A twin of the select in `news/[id]/route.ts` and `../route.ts` — a `route.ts` may export nothing but its
 * handlers, so the copies are kept in step by hand. A column missing here is a search document that quietly
 * loses a field rather than a type error.
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

async function reindexPosts(tx: TxClient, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx.post.findMany({
    where: { id: { in: [...ids] } },
    select: POST_INDEX_SELECT
  });
  // One `now` for the batch, so publication state is resolved against a single instant.
  const now = new Date();
  for (const row of rows) await syncSearchDocument(tx, "post", row, now);
  return rows.length;
}

function articles(count: number): string {
  return count === 1 ? "1 article" : `${count} articles`;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const POST = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Merging categories needs editor access or higher, because it moves other people's articles. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, mergeBody);

  if (body.intoId === id) {
    throw fieldProblem(
      "intoId",
      "A category cannot be merged into itself. Choose a different category for the articles to move to — merging it into itself would remove it and leave every article unfiled."
    );
  }

  const source = found(
    await prisma.category.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        _count: { select: { posts: { where: { deletedAt: null } } } }
      }
    }),
    "The category you are merging"
  );

  const target = found(
    await prisma.category.findUnique({
      where: { id: body.intoId },
      select: { id: true, name: true, slug: true }
    }),
    "The category you are merging into"
  );

  let moved = 0;
  let movedFromRecycleBin = 0;
  let reindexed = 0;
  let reindexTruncated = false;

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      /**
       * DELETE is the honest verb: at the end of this the category does not exist. `after` records where its
       * articles went, so the audit log answers "what happened to Textiles" in one entry rather than leaving
       * somebody to correlate a delete with a bulk update.
       */
      action: "DELETE",
      entityType: "Category",
      entityLabel: source.name,
      before: {
        name: source.name,
        slug: source.slug,
        description: source.description,
        articles: source._count.posts
      },
      revise: false
    },
    async (tx) => {
      /**
       * The ids first, because `updateMany` does not answer with them and the search index needs to know
       * which articles changed. Read inside the transaction, so the set cannot shift between the read and
       * the write.
       */
      const affected = await tx.post.findMany({
        where: { categoryId: source.id },
        select: { id: true, deletedAt: true }
      });

      const live = affected.filter((post) => post.deletedAt === null);
      moved = live.length;
      movedFromRecycleBin = affected.length - live.length;

      // One statement for every article, including the recycled ones — see the header.
      await tx.post.updateMany({
        where: { categoryId: source.id },
        data: { categoryId: target.id }
      });

      await tx.category.delete({ where: { id: source.id } });

      // Only the live ones: a soft-deleted article is not in the index at all, so re-indexing it would put a
      // recycled article into public search results.
      reindexTruncated = live.length > REINDEX_LIMIT;
      reindexed = await reindexPosts(
        tx,
        live.slice(0, REINDEX_LIMIT).map((post) => post.id)
      );

      return {
        id: source.id,
        mergedIntoId: target.id,
        mergedIntoName: target.name,
        articlesMoved: moved,
        articlesMovedFromRecycleBin: movedFromRecycleBin
      };
    }
  );

  /**
   * Separate sentences rather than one with a count in it. "Nothing was filed under Textiles" would be a lie
   * if the only articles filed under it were in the recycle bin — and those did move.
   */
  const parts: string[] = [];
  if (moved > 0) {
    parts.push(`${articles(moved)} ${moved === 1 ? "is" : "are"} now filed under “${target.name}”.`);
  } else if (movedFromRecycleBin === 0) {
    parts.push(`Nothing was filed under “${source.name}”, so no article changed.`);
  }
  parts.push(`“${source.name}” has been removed, and /news/category/${source.slug} no longer exists.`);
  if (movedFromRecycleBin > 0) {
    parts.push(
      `${articles(movedFromRecycleBin)} in the recycle bin ${movedFromRecycleBin === 1 ? "was" : "were"} re-filed under “${target.name}”, so restoring ${movedFromRecycleBin === 1 ? "it" : "them"} keeps a category.`
    );
  }
  if (reindexTruncated) {
    parts.push(
      `The site's own search has been brought up to date for the first ${articles(reindexed)}; the rest catch up the next time the search index is rebuilt, and are still findable by their own words in the meantime.`
    );
  }

  return ok({
    merged: true,
    into: target,
    removed: { id: source.id, name: source.name, slug: source.slug },
    moved,
    movedFromRecycleBin,
    reindexed,
    reindexTruncated,
    message: parts.join(" ")
  });
});
