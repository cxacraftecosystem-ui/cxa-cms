import { z } from "zod";
import { Prisma } from "@prisma/client";

import { assertSameOrigin, forbidden, noContent, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canAccessStudio, canAuthor, canEditOthersContent, canPublish } from "@/lib/permissions";
import { isEmptyRichText, parseRichText, richTextToPlainText } from "@/lib/richtext";
import { plainTextFromMdx } from "@/lib/search/index";
import {
  assertCanEdit,
  assertMediaAvailable,
  assertSlugAvailable,
  buildAuditContext,
  dropSearchDocument,
  fieldProblem,
  found,
  isUniqueViolation,
  optionalDateTime,
  optionalId,
  optionalText,
  parseStudioJson,
  publishTransition,
  requiredText,
  resolveTagIds,
  slugSchema,
  statusSchema,
  syncSearchDocument
} from "@/lib/studio/crud";
import { readingMinutes } from "@/lib/utils";

/**
 * One news article: read it, save it, put it in the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * OWN WORK ALWAYS; SOMEBODY ELSE'S NEEDS AN EDITOR. `assertCanEdit()` is the boundary, and it treats an
 * article with NO author recorded as somebody else's — the safe direction for imported content.
 *
 * ⚠ THE PERMISSION CHECK IS NOT THE PUBLISH CHECK. An author may keep editing their own article after an
 * editor has published it; what they may not do is change its publication state. That split lives in
 * `publishTransition()`, which is why this handler can allow the save and refuse the status in one request.
 * DELETE carries the same rule by hand: putting a LIVE article in the recycle bin takes it off the public
 * site, so it needs publishing rights even from the author who wrote it. Without that, the delete verb would
 * be the way around the status check.
 *
 * THE TAG AND "READ NEXT" LISTS ARE REPLACED WHOLE, and only when the request mentions them. The editor
 * sends the complete list every time it saves, so a diff would be inventing an intention: the list on
 * screen IS the intention. An absent key means "leave them alone", which is what a status-only PATCH from
 * a table row sends.
 *
 * ⚠ The body schema is a twin of the one in `../route.ts` — a `route.ts` may not export anything but its
 * handlers, so the two are kept in step by hand.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const TAG_LIMIT = 12;
const RELATED_LIMIT = 6;

const articleBodySchema = z.object({
  title: requiredText(
    200,
    "An article needs a title. It is what appears in every list and in the search results."
  ),
  slug: z.union([z.literal(""), slugSchema()]),
  subtitle: optionalText(240),
  excerpt: optionalText(600),
  body: z.unknown().optional(),
  mdx: optionalText(200_000),
  coverId: optionalId(),
  authorId: optionalId(),
  categoryId: optionalId(),
  tags: z
    .array(z.string().trim().max(40))
    .max(TAG_LIMIT, `Use at most ${TAG_LIMIT} tags. A longer list is a filing system nobody maintains.`),
  relatedIds: z
    .array(z.string().trim().max(40))
    .max(
      RELATED_LIMIT,
      `Choose at most ${RELATED_LIMIT} articles to read next. More than that and it stops being a recommendation.`
    ),
  isFeatured: z.boolean(),
  status: statusSchema,
  publishAt: optionalDateTime("The date it goes public"),
  unpublishAt: optionalDateTime("The date it comes off the site"),
  seoTitle: optionalText(90),
  seoDescription: optionalText(220),
  seoNoIndex: z.boolean()
});

const POST_SELECT = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  excerpt: true,
  body: true,
  mdx: true,
  coverId: true,
  authorId: true,
  categoryId: true,
  isFeatured: true,
  status: true,
  publishedAt: true,
  publishAt: true,
  unpublishAt: true,
  seoTitle: true,
  seoDescription: true,
  seoNoIndex: true,
  readingMinutes: true,
  viewCount: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true
} as const;

type PostRow = Prisma.PostGetPayload<{ select: typeof POST_SELECT }>;

/** The words in whichever body the article has, as one plain string. */
function articleText(body: unknown, mdx: string | null): string {
  return mdx && mdx.trim().length > 0
    ? plainTextFromMdx(mdx)
    : richTextToPlainText(parseRichText(body ?? null));
}

function readingMinutesFor(body: unknown, mdx: string | null): number | null {
  const trimmed = articleText(body, mdx).trim();
  return trimmed.length === 0 ? null : readingMinutes(trimmed);
}

/**
 * The "read next" picks that still exist, minus this article itself.
 *
 * A missing id is DROPPED rather than refused: the commonest cause is another editor putting that article in
 * the recycle bin while this one was open, and failing the whole save over a stale recommendation would be
 * out of all proportion to it.
 */
async function liveRelatedIds(ids: readonly string[], selfId: string): Promise<string[]> {
  const wanted = ids.filter((candidate) => candidate.length > 0 && candidate !== selfId);
  if (wanted.length === 0) return [];

  const rows = await prisma.post.findMany({
    where: { id: { in: wanted }, deletedAt: null },
    select: { id: true }
  });
  const live = new Set(rows.map((row) => row.id));
  return wanted.filter((candidate) => live.has(candidate));
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = route(async (request: Request, context: RouteContext) => {
  await requireCapability(canAccessStudio);
  const { id } = await context.params;

  const post = found(
    await prisma.post.findUnique({
      where: { id },
      select: {
        ...POST_SELECT,
        author: { select: { id: true, name: true, email: true } },
        category: { select: { id: true, name: true, slug: true } },
        cover: { select: MEDIA_IMAGE_SELECT_WITH_ID },
        tags: { select: { tag: { select: { id: true, name: true, slug: true } } } },
        relatedTo: { select: { id: true, title: true, slug: true } }
      }
    }),
    "That article"
  );

  const { tags, ...row } = post;
  return ok({ post: { ...row, tags: tags.map((link) => link.tag) } });
});

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canAuthor,
    "Editing an article needs author access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, articleBodySchema.partial());

  const existing = found(
    await prisma.post.findFirst({ where: { id, deletedAt: null }, select: POST_SELECT }),
    "That article"
  );

  assertCanEdit(user, existing, "this article");

  // An empty address arrives when somebody clears the field. Read as "leave it alone": an article cannot
  // have an empty address, and refusing the whole save mid-edit would block the autosave.
  const slug = body.slug && body.slug.length > 0 ? body.slug : existing.slug;
  if (slug !== existing.slug) await assertSlugAvailable("post", slug, id);

  if (body.coverId !== undefined) {
    await assertMediaAvailable(prisma, body.coverId, { field: "coverId", what: "cover picture" });
  }

  // The by-line may only be handed to somebody else by an editor. Note that handing it away can take the
  // article out of your own reach — which is correct, and is why it is not something an author may do.
  if (body.authorId !== undefined && body.authorId !== existing.authorId && !canEditOthersContent(user)) {
    throw forbidden(
      "Changing who an article is filed under needs editor access. Ask an editor to move the by-line."
    );
  }

  if (body.categoryId) {
    found(
      await prisma.category.findUnique({ where: { id: body.categoryId }, select: { id: true } }),
      "That category"
    );
  }

  // Merged with what is stored, because a PATCH may mention one body and not the other.
  const nextBody = body.body !== undefined ? body.body : existing.body;
  const nextMdx = body.mdx !== undefined ? body.mdx : existing.mdx;
  const doc = parseRichText(nextBody ?? null);
  if (doc !== null && !isEmptyRichText(doc) && nextMdx && nextMdx.trim().length > 0) {
    throw fieldProblem(
      "mdx",
      "This article would have text in the formatted editor and MDX source as well, and it can only have one. Choose a writing mode in the editor — it will tell you which text is about to be cleared."
    );
  }

  const publishAt = body.publishAt !== undefined ? body.publishAt : existing.publishAt;
  const unpublishAt = body.unpublishAt !== undefined ? body.unpublishAt : existing.unpublishAt;
  if (publishAt && unpublishAt && unpublishAt <= publishAt) {
    throw fieldProblem(
      "unpublishAt",
      "The date it comes off the site must be after the date it goes on."
    );
  }

  const transition = publishTransition(existing, { status: body.status, publishAt: body.publishAt }, user, {
    schedulable: true
  });

  // A "read next" list is only touched when the request carries one. Missing ids are dropped rather than
  // refused — see `liveRelatedIds`.
  const requestedRelated = body.relatedIds;
  const relatedIds = requestedRelated === undefined ? null : await liveRelatedIds(requestedRelated, id);

  try {
    const updated = await mutateWithHistory<PostRow>(
      buildAuditContext(request, user),
      {
        action: transition.action,
        entityType: "Post",
        entityLabel: body.title ?? existing.title,
        before: existing,
        summary: slug !== existing.slug ? `Address changed from /${existing.slug}` : null
      },
      async (tx) => {
        const row = await tx.post.update({
          where: { id },
          data: {
            ...(body.title !== undefined ? { title: body.title } : {}),
            ...(body.subtitle !== undefined ? { subtitle: body.subtitle } : {}),
            ...(body.excerpt !== undefined ? { excerpt: body.excerpt } : {}),
            ...(body.coverId !== undefined ? { coverId: body.coverId } : {}),
            ...(body.authorId !== undefined ? { authorId: body.authorId } : {}),
            ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
            ...(body.isFeatured !== undefined ? { isFeatured: body.isFeatured } : {}),
            ...(body.seoTitle !== undefined ? { seoTitle: body.seoTitle } : {}),
            ...(body.seoDescription !== undefined ? { seoDescription: body.seoDescription } : {}),
            ...(body.seoNoIndex !== undefined ? { seoNoIndex: body.seoNoIndex } : {}),
            ...(body.publishAt !== undefined ? { publishAt: body.publishAt } : {}),
            ...(body.unpublishAt !== undefined ? { unpublishAt: body.unpublishAt } : {}),
            // Both bodies are written whenever either was mentioned, so switching writing mode genuinely
            // clears the one being left behind rather than leaving both in the row.
            ...(body.body !== undefined || body.mdx !== undefined
              ? {
                  body: doc === null ? Prisma.JsonNull : (doc as unknown as Prisma.InputJsonValue),
                  mdx: nextMdx,
                  readingMinutes: readingMinutesFor(doc, nextMdx)
                }
              : {}),
            ...(relatedIds !== null
              ? { relatedTo: { set: relatedIds.map((candidate) => ({ id: candidate })) } }
              : {}),
            slug,
            status: transition.status,
            ...(transition.publishedAt ? { publishedAt: transition.publishedAt } : {}),
            ...(transition.publishAt === null ? { publishAt: null } : {})
          },
          select: POST_SELECT
        });

        if (body.tags !== undefined) {
          const tagIds = await resolveTagIds(tx, body.tags);
          // Replaced whole, in two statements rather than one nested write, so the order is guaranteed:
          // clearing after creating would leave the article with no tags at all.
          await tx.postTag.deleteMany({ where: { postId: id } });
          if (tagIds.length > 0) {
            await tx.postTag.createMany({
              data: tagIds.map((tagId) => ({ postId: id, tagId })),
              skipDuplicates: true
            });
          }
        }

        const indexable = await tx.post.findUnique({
          where: { id },
          select: {
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
          }
        });
        if (indexable) await syncSearchDocument(tx, "post", indexable);

        return row;
      }
    );

    return ok({ post: updated });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("post", slug, id);
    throw error;
  }
});

export const DELETE = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canAuthor,
    "Deleting an article needs author access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const existing = found(
    await prisma.post.findUnique({
      where: { id },
      // The four publication columns, not `status` alone: `isLive` below has to see what the public read path
      // sees, and a SCHEDULED article whose `publishAt` has passed is on the site however the column reads.
      select: {
        id: true,
        title: true,
        slug: true,
        authorId: true,
        status: true,
        publishedAt: true,
        publishAt: true,
        unpublishAt: true,
        deletedAt: true
      }
    }),
    "That article"
  );

  assertCanEdit(user, existing, "this article");

  // Already in the recycle bin: the reader asked for it to be gone and it is gone. A second click on a slow
  // connection must not produce an error.
  if (existing.deletedAt) return noContent();

  // ⚠ DELETING A LIVE ARTICLE IS A PUBLISHING ACT, so it needs the publishing right that PATCHing it back to
  // DRAFT needs — `publishTransition()` refuses that, and refusing the smaller effect while allowing the
  // larger one would make the delete button the way around the rule. Owning the article is not enough: the
  // author wrote it, but an editor decided it should be on the site. The newsroom table applies exactly this
  // condition to its Delete item, and a client-side condition with no server counterpart is not a guard.
  if (isLive(existing) && !canPublish(user)) {
    throw forbidden(
      "Taking a published article off the site needs publishing rights, and deleting it does exactly that — " +
        "it disappears from the news pages and from search. Ask an editor to unpublish it first, or to delete it for you."
    );
  }

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "Post",
      entityLabel: existing.title,
      before: existing,
      revise: false
    },
    async (tx) => {
      const row = await tx.post.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true, title: true, deletedAt: true }
      });

      await dropSearchDocument(tx, "post", id);
      await tx.contentLock.deleteMany({ where: { entityType: "Post", entityId: id } });

      return row;
    }
  );

  return noContent();
});
