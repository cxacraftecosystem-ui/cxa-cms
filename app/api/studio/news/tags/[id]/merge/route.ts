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
 * Merge one tag into another: move everything that carries it, then remove the tag — in ONE transaction.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠⚠ THE DE-DUPLICATION IS THE WHOLE DIFFICULTY OF THIS FILE. READ THIS BEFORE CHANGING ANY OF IT.
 *
 * `PostTag` has a COMPOSITE PRIMARY KEY — `@@id([postId, tagId])` — and so does `EventTag`. The obvious
 * implementation is one statement:
 *
 *     UPDATE post_tags SET tagId = <target> WHERE tagId = <source>     ← WRONG
 *
 * For any article that already carries BOTH tags, that row would collide with the row it already has for the
 * target tag, the primary key refuses the write, and THE WHOLE MERGE FAILS. Worse, it fails only for the
 * newsrooms where somebody had tagged an article with both — which is exactly the pair of tags an editor
 * wants to merge — so it reads as "merging sometimes fails" and is impossible to reproduce on clean data.
 *
 * So the order is: find the records carrying both, DELETE their link to the source tag (they already carry
 * the target, so nothing is lost), and only then move what is left. After that step no surviving source row
 * can collide, and the move is one statement.
 *
 * THE SAME APPLIES TO EVENTS. `Tag` is joined to articles through `PostTag` and to events through `EventTag`
 * (prisma/schema.prisma), so a tag merge is TWO join tables and both need the same treatment. Moving only the
 * articles would leave the source tag's `EventTag` rows behind, and deleting the tag afterwards would cascade
 * them away — silently stripping labels off events nobody was looking at.
 *
 * MERGING A TAG INTO ITSELF IS REFUSED. It looks like a harmless no-op: every link would be "moved" to the
 * tag that is about to be deleted, and the delete would then cascade all of them away — the tag and every use
 * of it, gone.
 *
 * EVERYTHING THAT CARRIED THE SOURCE TAG IS RE-INDEXED, including the records that carried both. Both
 * `searchDocFromPost()` and `searchDocFromEvent()` fold their tag names into `keywords`, and
 * `indexDocument()` concatenates those into the indexed text (lib/search/index.ts) — so a record that had
 * "Textiles" and "Craft" and now has only "Craft" has different search text, whether or not any row moved.
 * The re-index runs inside the same transaction as the move (contract §9).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How much is re-indexed inside the transaction, per kind of record.
 *
 * ⚠ THE MOVE IS NEVER CAPPED — every link is re-pointed, whatever the number. This bounds only the search
 * work, so merging a tag used thousands of times cannot hold one write transaction open for the length of a
 * full re-index. When it bites it is reported with the remedy (contract §1.6).
 */
const REINDEX_LIMIT = 500;

const mergeBody = z.object({
  /** The tag everything ends up on. The screen calls this "Move the articles to". */
  intoId: z
    .string({ invalid_type_error: "Choose which tag the articles should move to." })
    .trim()
    .min(1, "Choose which tag the articles should move to.")
    .max(40, "That does not look like a reference to a tag.")
});

/** ⚠ A twin of the select in `news/[id]/route.ts`. A column missing here loses a field from the index. */
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

/** The columns `searchDocFromEvent` reads. `CoeEvent` has no `publishAt`, so publication state is `status`. */
const EVENT_INDEX_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  summary: true,
  body: true,
  mode: true,
  venue: true,
  address: true,
  status: true,
  publishedAt: true,
  deletedAt: true,
  tags: { select: { tag: { select: { name: true } } } }
} as const satisfies Prisma.CoeEventSelect;

function articles(count: number): string {
  return count === 1 ? "1 article" : `${count} articles`;
}

function events(count: number): string {
  return count === 1 ? "1 event" : `${count} events`;
}

/**
 * Re-index by id, inside the caller's transaction.
 *
 * The caller passes LIVE ids only: a soft-deleted record is not in the index at all (lib/search/index.ts), so
 * re-indexing one would put a recycled article into public search results. One `now` per call, so a batch
 * cannot resolve publication state against a drifting clock.
 */
async function reindex(
  tx: TxClient,
  postIds: readonly string[],
  eventIds: readonly string[]
): Promise<{ posts: number; events: number }> {
  const now = new Date();

  let posts = 0;
  if (postIds.length > 0) {
    const rows = await tx.post.findMany({
      where: { id: { in: [...postIds] } },
      select: POST_INDEX_SELECT
    });
    for (const row of rows) await syncSearchDocument(tx, "post", row, now);
    posts = rows.length;
  }

  let eventCount = 0;
  if (eventIds.length > 0) {
    const rows = await tx.coeEvent.findMany({
      where: { id: { in: [...eventIds] } },
      select: EVENT_INDEX_SELECT
    });
    for (const row of rows) await syncSearchDocument(tx, "event", row, now);
    eventCount = rows.length;
  }

  return { posts, events: eventCount };
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const POST = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Merging tags needs editor access or higher, because it changes other people's articles. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, mergeBody);

  if (body.intoId === id) {
    throw fieldProblem(
      "intoId",
      "A tag cannot be merged into itself. Choose a different tag for the articles to move to — merging it into itself would remove the tag and take it off everything that carries it."
    );
  }

  const source = found(
    await prisma.tag.findUnique({ where: { id }, select: { id: true, name: true, slug: true } }),
    "The tag you are merging"
  );

  const target = found(
    await prisma.tag.findUnique({
      where: { id: body.intoId },
      select: { id: true, name: true, slug: true }
    }),
    "The tag you are merging into"
  );

  /** Live articles whose link was re-pointed, and live articles that already carried the target tag. */
  let movedArticles = 0;
  let alreadyTaggedArticles = 0;
  let movedEvents = 0;
  let alreadyTaggedEvents = 0;
  let recycledLinks = 0;
  let reindexedPosts = 0;
  let reindexedEvents = 0;
  let reindexTruncated = false;

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      /**
       * DELETE is the honest verb: at the end of this the tag does not exist. `after` records where its uses
       * went, so the audit log answers "what happened to Textiles" in one entry.
       */
      action: "DELETE",
      entityType: "Tag",
      entityLabel: source.name,
      before: { name: source.name, slug: source.slug },
      revise: false
    },
    async (tx) => {
      // ── Articles ────────────────────────────────────────────────────────────────────────────────
      // Both link sets are read inside the transaction, so the set cannot shift between the read that decides
      // what to de-duplicate and the write that moves the rest.
      const sourcePostLinks = await tx.postTag.findMany({
        where: { tagId: source.id },
        select: { postId: true, post: { select: { deletedAt: true } } }
      });
      const targetPostLinks = await tx.postTag.findMany({
        where: { tagId: target.id },
        select: { postId: true }
      });

      const postsWithTarget = new Set(targetPostLinks.map((link) => link.postId));
      const postsCarryingBoth = sourcePostLinks.filter((link) => postsWithTarget.has(link.postId));

      movedArticles = sourcePostLinks.filter(
        (link) => link.post.deletedAt === null && !postsWithTarget.has(link.postId)
      ).length;
      alreadyTaggedArticles = postsCarryingBoth.filter((link) => link.post.deletedAt === null).length;

      /**
       * ⚠ STEP 1 — DROP THE DUPLICATES BEFORE MOVING ANYTHING. See the file header: an article carrying both
       * tags would collide on `@@id([postId, tagId])` and take the whole merge down with it. It already
       * carries the target, so removing its link to the source loses nothing.
       */
      if (postsCarryingBoth.length > 0) {
        await tx.postTag.deleteMany({
          where: { tagId: source.id, postId: { in: postsCarryingBoth.map((link) => link.postId) } }
        });
      }

      // ⚠ STEP 2 — now, and only now, the rest can be re-pointed in one statement.
      await tx.postTag.updateMany({ where: { tagId: source.id }, data: { tagId: target.id } });

      // ── Events ──────────────────────────────────────────────────────────────────────────────────
      // Identical treatment, because `EventTag` has the same composite key. See the header.
      const sourceEventLinks = await tx.eventTag.findMany({
        where: { tagId: source.id },
        select: { eventId: true, event: { select: { deletedAt: true } } }
      });
      const targetEventLinks = await tx.eventTag.findMany({
        where: { tagId: target.id },
        select: { eventId: true }
      });

      const eventsWithTarget = new Set(targetEventLinks.map((link) => link.eventId));
      const eventsCarryingBoth = sourceEventLinks.filter((link) => eventsWithTarget.has(link.eventId));

      movedEvents = sourceEventLinks.filter(
        (link) => link.event.deletedAt === null && !eventsWithTarget.has(link.eventId)
      ).length;
      alreadyTaggedEvents = eventsCarryingBoth.filter((link) => link.event.deletedAt === null).length;

      if (eventsCarryingBoth.length > 0) {
        await tx.eventTag.deleteMany({
          where: { tagId: source.id, eventId: { in: eventsCarryingBoth.map((link) => link.eventId) } }
        });
      }
      await tx.eventTag.updateMany({ where: { tagId: source.id }, data: { tagId: target.id } });

      recycledLinks =
        sourcePostLinks.filter((link) => link.post.deletedAt !== null).length +
        sourceEventLinks.filter((link) => link.event.deletedAt !== null).length;

      // Nothing points at the source tag any more, so this deletes a row with no cascade left to do.
      await tx.tag.delete({ where: { id: source.id } });

      /**
       * EVERYTHING that carried the source tag is re-indexed — the moved records AND the de-duplicated ones,
       * because both now have different tag words. Live records only.
       */
      const livePostIds = sourcePostLinks
        .filter((link) => link.post.deletedAt === null)
        .map((link) => link.postId);
      const liveEventIds = sourceEventLinks
        .filter((link) => link.event.deletedAt === null)
        .map((link) => link.eventId);

      reindexTruncated = livePostIds.length > REINDEX_LIMIT || liveEventIds.length > REINDEX_LIMIT;
      const result = await reindex(
        tx,
        livePostIds.slice(0, REINDEX_LIMIT),
        liveEventIds.slice(0, REINDEX_LIMIT)
      );
      reindexedPosts = result.posts;
      reindexedEvents = result.events;

      return {
        id: source.id,
        mergedIntoId: target.id,
        mergedIntoName: target.name,
        articlesMoved: movedArticles,
        articlesAlreadyTagged: alreadyTaggedArticles,
        eventsMoved: movedEvents,
        eventsAlreadyTagged: alreadyTaggedEvents,
        linksInRecycleBin: recycledLinks
      };
    }
  );

  const parts: string[] = [];
  // Three separate sentences rather than one with a count in it: with nothing moved but two articles already
  // carrying both tags, "0 articles now carry Craft" would be true and useless.
  if (movedArticles === 0 && alreadyTaggedArticles === 0) {
    parts.push(`No article carried “${source.name}”, so no article changed.`);
  } else if (movedArticles > 0) {
    parts.push(
      `${articles(movedArticles)} ${movedArticles === 1 ? "now carries" : "now carry"} “${target.name}”.`
    );
  }
  if (alreadyTaggedArticles > 0) {
    parts.push(
      `${articles(alreadyTaggedArticles)} already carried both tags, so ${alreadyTaggedArticles === 1 ? "it simply keeps" : "they simply keep"} “${target.name}” once.`
    );
  }
  if (movedEvents > 0 || alreadyTaggedEvents > 0) {
    parts.push(
      `${events(movedEvents + alreadyTaggedEvents)} also carried this tag and ${movedEvents + alreadyTaggedEvents === 1 ? "has" : "have"} been moved as well.`
    );
  }
  parts.push(`“${source.name}” has been removed, and /news/tag/${source.slug} no longer exists.`);
  if (reindexTruncated) {
    parts.push(
      `The site's own search has been brought up to date for the first ${REINDEX_LIMIT} records; the rest catch up the next time the search index is rebuilt, and are still findable by their own words in the meantime.`
    );
  }

  return ok({
    merged: true,
    into: target,
    removed: { id: source.id, name: source.name, slug: source.slug },
    /** Live articles whose tag was re-pointed. The number the screen's promise is about. */
    moved: movedArticles,
    /** Live articles that already carried the target as well, whose duplicate link was dropped. */
    alreadyTagged: alreadyTaggedArticles,
    movedEvents,
    alreadyTaggedEvents,
    /** Links belonging to records in the recycle bin. Moved too, so a restore keeps its labels. */
    movedFromRecycleBin: recycledLinks,
    reindexed: reindexedPosts + reindexedEvents,
    reindexTruncated,
    message: parts.join(" ")
  });
});
