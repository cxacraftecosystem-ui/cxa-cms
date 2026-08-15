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
  parseStudioJson,
  requiredText,
  slugSchema,
  syncSearchDocument
} from "@/lib/studio/crud";

/**
 * One tag: rename it, or remove it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THE DELIBERATE TWIN OF `../../categories/[id]/route.ts`, with two differences that matter. A `route.ts`
 * may export nothing but its handlers, so the shared logic cannot be factored out; the twins are kept in step
 * by hand.
 *
 *   1. A tag has NO description column.
 *   2. ⚠ A TAG IS ALSO USED BY EVENTS. `Tag` joins articles through `PostTag` and events through `EventTag`,
 *      so a rename re-indexes both, and a delete is refused if EITHER is using it. A tag with no articles and
 *      three events is not unused; deleting it would cascade `EventTag` away and silently strip three events
 *      of their labels, with nothing on screen to say why.
 *
 * A RENAME CHANGES WHAT THE SITE'S OWN SEARCH MATCHES. `searchDocFromPost()` and `searchDocFromEvent()` both
 * fold their tag names into `keywords`, and `indexDocument()` concatenates the keywords into the indexed text
 * (lib/search/index.ts). So renaming "Textiles" leaves everything carrying it findable under a name that no
 * longer exists and not findable under the new one. The re-index runs in the SAME transaction as the rename
 * (contract §9).
 *
 * A change of ADDRESS does not touch the index: an article's indexed URL comes from the ARTICLE's own slug,
 * and the tag's slug is nowhere in its search document. It does change `/news/tag/…`, which is a public page
 * somebody may have linked, so the response reports how much is filed there.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ The same cap as `NAME_MAX` in `app/studio/news/taxonomy/TaxonomyManager.tsx`. */
const NAME_MAX = 80;

/**
 * How much one rename re-indexes inside its transaction, per kind of record.
 *
 * The rename itself is never capped — it is one row. This bounds only the search work, so a tag on thousands
 * of articles cannot hold a write transaction open for the length of a full re-index. When it bites it is
 * reported with the remedy (contract §1.6).
 */
const REINDEX_LIMIT = 500;

const patchBody = z.object({
  name: requiredText(NAME_MAX, "A tag needs a name.").optional(),
  slug: slugSchema().optional()
});

const TAG_SELECT = { id: true, name: true, slug: true } as const satisfies Prisma.TagSelect;

type TagRow = Prisma.TagGetPayload<{ select: typeof TAG_SELECT }>;

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

/**
 * Re-index everything that carries this tag, inside the caller's transaction.
 *
 * Only LIVE records: a soft-deleted one is not in the index at all (lib/search/index.ts), so re-indexing it
 * would put a recycled article into public search results. One `now` for the whole batch, so a long run
 * cannot resolve publication state against a drifting clock.
 */
async function reindexCarriers(
  tx: TxClient,
  tagId: string
): Promise<{ posts: number; events: number; truncated: boolean }> {
  const postLinks = await tx.postTag.findMany({
    where: { tagId, post: { deletedAt: null } },
    select: { postId: true },
    take: REINDEX_LIMIT + 1
  });
  const eventLinks = await tx.eventTag.findMany({
    where: { tagId, event: { deletedAt: null } },
    select: { eventId: true },
    take: REINDEX_LIMIT + 1
  });

  const truncated = postLinks.length > REINDEX_LIMIT || eventLinks.length > REINDEX_LIMIT;
  const postIds = postLinks.slice(0, REINDEX_LIMIT).map((link) => link.postId);
  const eventIds = eventLinks.slice(0, REINDEX_LIMIT).map((link) => link.eventId);

  const now = new Date();

  let posts = 0;
  if (postIds.length > 0) {
    const rows = await tx.post.findMany({ where: { id: { in: postIds } }, select: POST_INDEX_SELECT });
    for (const row of rows) await syncSearchDocument(tx, "post", row, now);
    posts = rows.length;
  }

  let events = 0;
  if (eventIds.length > 0) {
    const rows = await tx.coeEvent.findMany({
      where: { id: { in: eventIds } },
      select: EVENT_INDEX_SELECT
    });
    for (const row of rows) await syncSearchDocument(tx, "event", row, now);
    events = rows.length;
  }

  return { posts, events, truncated };
}

function articles(count: number): string {
  return count === 1 ? "1 article" : `${count} articles`;
}

function events(count: number): string {
  return count === 1 ? "1 event" : `${count} events`;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — rename, and (deliberately) re-address
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Renaming a tag needs editor access or higher, because it changes what every author sees. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, patchBody);

  const existing = found(
    await prisma.tag.findUnique({
      where: { id },
      select: {
        ...TAG_SELECT,
        _count: {
          select: {
            posts: { where: { post: { deletedAt: null } } },
            events: { where: { event: { deletedAt: null } } }
          }
        }
      }
    }),
    "That tag"
  );

  const nextName = body.name ?? existing.name;
  const nextSlug = body.slug ?? existing.slug;
  const nameChanged = nextName !== existing.name;
  const slugChanged = nextSlug !== existing.slug;
  const affectedArticles = existing._count.posts;
  const affectedEvents = existing._count.events;

  if (nameChanged) {
    const sameName = await prisma.tag.findFirst({
      where: { name: { equals: nextName, mode: "insensitive" }, id: { not: id } },
      select: { name: true, slug: true }
    });
    if (sameName) {
      throw conflict(
        `There is already a tag called “${sameName.name}”, at /news/tag/${sameName.slug}. Two tags with the same name cannot be told apart when an author is writing, so choose a different name — or merge this one into that one.`
      );
    }
  }

  if (slugChanged) await assertSlugAvailable("tag", nextSlug, id);

  if (!nameChanged && !slugChanged) {
    // Nothing was different. Answered as success: the dialog has already closed, and reporting a failure for
    // a save with nothing to do would send somebody looking for a fault.
    return ok({
      term: {
        id: existing.id,
        name: existing.name,
        slug: existing.slug,
        description: null,
        articleCount: affectedArticles,
        eventCount: affectedEvents
      },
      changed: false,
      renamed: false,
      addressChanged: false,
      affectedArticles,
      affectedEvents,
      reindexed: 0,
      reindexTruncated: false,
      message: "Nothing was different, so nothing has been changed."
    });
  }

  let reindexedPosts = 0;
  let reindexedEvents = 0;
  let reindexTruncated = false;

  try {
    const updated = await mutateWithHistory<TagRow>(
      buildAuditContext(request, user),
      {
        action: "UPDATE",
        entityType: "Tag",
        entityLabel: nextName,
        before: { name: existing.name, slug: existing.slug },
        revise: false
      },
      async (tx) => {
        const row = await tx.tag.update({
          where: { id },
          data: {
            ...(nameChanged ? { name: nextName } : {}),
            ...(slugChanged ? { slug: nextSlug } : {})
          },
          select: TAG_SELECT
        });

        if (nameChanged) {
          const result = await reindexCarriers(tx, id);
          reindexedPosts = result.posts;
          reindexedEvents = result.events;
          reindexTruncated = result.truncated;
        }

        return row;
      }
    );

    const parts: string[] = [];
    if (nameChanged) parts.push(`The tag is now called “${updated.name}”.`);
    if (slugChanged) {
      parts.push(
        affectedArticles + affectedEvents > 0
          ? `Its page has moved to /news/tag/${updated.slug}, and any link to the old address /news/tag/${existing.slug} will stop working. ${articles(affectedArticles)} and ${events(affectedEvents)} carry it.`
          : `Its page has moved to /news/tag/${updated.slug}. Nothing carries it, so nothing else changes.`
      );
    } else if (nameChanged) {
      parts.push(`The web address is still /news/tag/${updated.slug}, so links and bookmarks keep working.`);
    }
    if (reindexTruncated) {
      parts.push(
        `The site's own search has been brought up to date for the first ${REINDEX_LIMIT} records; more than that carry this tag, and the rest catch up the next time the search index is rebuilt. They are still findable by their own words in the meantime.`
      );
    }

    return ok({
      term: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        description: null,
        articleCount: affectedArticles,
        eventCount: affectedEvents
      },
      changed: true,
      renamed: nameChanged,
      addressChanged: slugChanged,
      /** How much a change of address affects. The numbers a caller warns with before committing. */
      affectedArticles,
      affectedEvents,
      reindexed: reindexedPosts + reindexedEvents,
      reindexTruncated,
      message: parts.join(" ")
    });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("tag", nextSlug, id);
    throw error;
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — only when nothing carries it
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Removing a tag needs editor access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const existing = found(
    await prisma.tag.findUnique({
      where: { id },
      select: {
        ...TAG_SELECT,
        _count: {
          select: {
            posts: { where: { post: { deletedAt: null } } },
            events: { where: { event: { deletedAt: null } } }
          }
        }
      }
    }),
    "That tag"
  );

  const inUseArticles = existing._count.posts;
  const inUseEvents = existing._count.events;

  /**
   * Records in the recycle bin, counted but not blocking.
   *
   * Deleting the tag cascades its `PostTag` / `EventTag` rows away (prisma/schema.prisma), so a recycled
   * article restored afterwards comes back with one tag fewer. That is worth SAYING and not worth refusing
   * over: the screen decides whether to offer "Delete it" from the live count, and a server refusing over a
   * row nobody can see would refuse an action it had just been offered.
   */
  const [recycledArticles, recycledEvents] = await prisma.$transaction([
    prisma.postTag.count({ where: { tagId: id, post: { deletedAt: { not: null } } } }),
    prisma.eventTag.count({ where: { tagId: id, event: { deletedAt: { not: null } } } })
  ]);

  if (inUseArticles > 0 || inUseEvents > 0) {
    const used = [
      inUseArticles > 0 ? articles(inUseArticles) : null,
      inUseEvents > 0 ? events(inUseEvents) : null
    ]
      .filter((part): part is string => part !== null)
      .join(" and ");

    throw conflict(
      `“${existing.name}” cannot be removed while ${used} carry it — they would lose the label with nothing to say why. Take the tag off them first, or merge this tag into another one, which moves everything and removes this tag in one step.`
    );
  }

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "Tag",
      entityLabel: existing.name,
      // The whole row: a tag is HARD-deleted (no `deletedAt` column, no recycle bin), so this audit entry is
      // the only surviving record of what was removed.
      before: {
        name: existing.name,
        slug: existing.slug,
        articlesInRecycleBin: recycledArticles,
        eventsInRecycleBin: recycledEvents
      },
      revise: false
    },
    async (tx) => {
      await tx.tag.delete({ where: { id } });
      // Nothing live carried it, and a recycled record is not in the search index, so there is nothing to
      // re-index.
      return { id };
    }
  );

  const recycled = recycledArticles + recycledEvents;

  return ok({
    deleted: true,
    name: existing.name,
    slug: existing.slug,
    articlesInRecycleBin: recycledArticles,
    eventsInRecycleBin: recycledEvents,
    message:
      `“${existing.name}” has been removed, and /news/tag/${existing.slug} no longer exists.` +
      (recycled > 0
        ? ` ${recycled === 1 ? "1 record" : `${recycled} records`} in the recycle bin carried it, so restoring ${recycled === 1 ? "it" : "them"} will bring ${recycled === 1 ? "it" : "them"} back with this tag missing.`
        : "")
  });
});
