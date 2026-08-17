import { z } from "zod";
import { Prisma } from "@prisma/client";

import { assertSameOrigin, forbidden, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canAccessStudio, canAuthor, canEditOthersContent } from "@/lib/permissions";
import { isEmptyRichText, parseRichText, richTextToPlainText } from "@/lib/richtext";
import { plainTextFromMdx } from "@/lib/search/index";
import {
  assertMediaAvailable,
  assertSlugAvailable,
  binWhere,
  buildAuditContext,
  fieldProblem,
  found,
  isUniqueViolation,
  listQuerySchema,
  optionalDateTime,
  optionalId,
  optionalText,
  pageWindow,
  paginated,
  parseStudioJson,
  parseStudioQuery,
  publishTransition,
  requiredText,
  resolveTagIds,
  resolveSort,
  screenFramingField,
  slugFromTitle,
  slugSchema,
  statusSchema,
  syncSearchDocument,
  textSearchWhere
} from "@/lib/studio/crud";
import { readingMinutes } from "@/lib/utils";

/**
 * The newsroom — the list, and writing a new article.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AN AUTHOR MAY WRITE, AND MAY NOT PUBLISH. That split is the whole permission model here: creating an
 * article needs `canAuthor` (AUTHOR and above), and putting it in front of readers needs `canPublish`,
 * which `publishTransition()` enforces. An author who tries to publish is told who can.
 *
 * AN AUTHOR MAY NOT FILE AN ARTICLE UNDER SOMEBODY ELSE'S NAME. `authorId` defaults to the person making
 * the request, and only `canEditOthersContent` may set it to anybody else. Two reasons, and the second is
 * the serious one: the author is who may edit the row afterwards, so a mis-set author locks the writer out
 * of their own draft — and a by-line is the institution putting words in a named person's mouth.
 *
 * AN ARTICLE HAS ONE BODY, NEVER TWO. `Post.body` (formatted) and `Post.mdx` are mutually exclusive by
 * design, and the editor picks one mode and says which. Storing both would leave the public renderer
 * choosing, and it would choose the same way every time — so half the writing would simply never appear.
 *
 * THE READING TIME IS COMPUTED HERE, from whichever body was stored, and the figure sent by the client is
 * ignored. The public page prints "4 min read" as a fact about the article; a figure computed from a draft
 * the reader has since edited is a small lie that nothing on screen could ever explain.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** Past this many tags nothing is being described any more. Matches `TAG_MAX` in the article editor. */
const TAG_LIMIT = 12;
/** More "read next" picks than this and the strip under an article stops being a pick. */
const RELATED_LIMIT = 6;

const SORTABLE = {
  updatedAt: "updatedAt",
  createdAt: "createdAt",
  publishedAt: "publishedAt",
  title: "title",
  views: "viewCount"
} as const;

const listSchema = listQuerySchema.extend({
  categoryId: z.string().trim().max(40).default(""),
  authorId: z.string().trim().max(40).default(""),
  /** `mine` is what an author's own screen asks for — the newsroom list is otherwise everybody's. */
  scope: z.enum(["", "mine"]).default(""),
  featured: z.enum(["", "true", "false"]).default(""),
  /** A tag SLUG, because that is the stable half of a tag. */
  tag: z.string().trim().max(96).default("")
});

const articleBodySchema = z.object({
  title: requiredText(
    200,
    "An article needs a title. It is what appears in every list and in the search results."
  ),
  /** May arrive empty — the editor trims it — in which case it is taken from the title. */
  slug: z.union([z.literal(""), slugSchema()]).optional(),
  subtitle: optionalText(240),
  excerpt: optionalText(600),
  /** A Tiptap document, or null when the article is written in MDX. */
  body: z.unknown().optional(),
  /** MDX source, or "" when the article uses the formatted editor. */
  mdx: optionalText(200_000),
  coverId: optionalId(),
  /**
   * The cover's per-screen framing. Accepted on creation as well as on the PATCH, because the editor is the
   * same form either way — a route that stripped it here would take a framing an editor set before their
   * first save and drop it without saying so.
   */
  coverScreens: screenFramingField(),
  authorId: optionalId(),
  categoryId: optionalId(),
  tags: z
    .array(z.string().trim().max(40))
    .max(TAG_LIMIT, `Use at most ${TAG_LIMIT} tags. A longer list is a filing system nobody maintains.`)
    .default([]),
  relatedIds: z
    .array(z.string().trim().max(40))
    .max(
      RELATED_LIMIT,
      `Choose at most ${RELATED_LIMIT} articles to read next. More than that and it stops being a recommendation.`
    )
    .default([]),
  isFeatured: z.boolean().default(false),
  status: statusSchema.default("DRAFT"),
  publishAt: optionalDateTime("The date it goes public"),
  unpublishAt: optionalDateTime("The date it comes off the site"),
  seoTitle: optionalText(90),
  seoDescription: optionalText(220),
  seoNoIndex: z.boolean().default(false)
  // `readingMinutes` and `publishedAt` arrive in the payload and are deliberately not declared: both are
  // derived, and `z.object()` strips what it does not know.
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
  // Selected beside the cover it frames, so the created row answers with the framing it was given.
  coverScreens: true,
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

/**
 * The reading time, from whichever body the article actually has.
 *
 * `null` for an article with nothing written yet — `readingMinutes()` floors at one minute, and "1 min
 * read" on an empty draft reads as a bug rather than as "this is quick".
 */
function readingMinutesFor(body: unknown, mdx: string | null): number | null {
  const text =
    mdx && mdx.trim().length > 0
      ? plainTextFromMdx(mdx)
      : richTextToPlainText(parseRichText(body ?? null));
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : readingMinutes(trimmed);
}

/** Refuse an article that has both bodies. See the header. */
function assertOneBody(body: unknown, mdx: string | null): void {
  const doc = parseRichText(body ?? null);
  const hasFormatted = doc !== null && !isEmptyRichText(doc);
  const hasMdx = Boolean(mdx && mdx.trim().length > 0);
  if (hasFormatted && hasMdx) {
    throw fieldProblem(
      "mdx",
      "This article has text in the formatted editor and MDX source as well, and it can only have one. Choose a writing mode in the editor — it will tell you which text is about to be cleared."
    );
  }
}

export const GET = route(async (request: Request) => {
  const user = await requireCapability(canAccessStudio);

  const query = parseStudioQuery(request, listSchema);
  const { page, pageSize, skip, take } = pageWindow(query);

  const where: Record<string, unknown> = {
    ...binWhere(query.bin),
    ...(query.status === "" ? {} : { status: query.status }),
    ...(query.categoryId === "" ? {} : { categoryId: query.categoryId }),
    ...(query.authorId === "" ? {} : { authorId: query.authorId }),
    ...(query.scope === "mine" ? { authorId: user.id } : {}),
    ...(query.featured === "" ? {} : { isFeatured: query.featured === "true" }),
    ...(query.tag === "" ? {} : { tags: { some: { tag: { slug: query.tag } } } }),
    ...textSearchWhere(query.q, ["title", "subtitle", "excerpt"])
  };

  const [rows, total] = await prisma.$transaction([
    prisma.post.findMany({
      where,
      orderBy: resolveSort(query, SORTABLE, "updatedAt"),
      skip,
      take,
      select: {
        id: true,
        slug: true,
        title: true,
        subtitle: true,
        excerpt: true,
        status: true,
        publishedAt: true,
        publishAt: true,
        unpublishAt: true,
        isFeatured: true,
        readingMinutes: true,
        viewCount: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        author: { select: { id: true, name: true, email: true } },
        category: { select: { id: true, name: true, slug: true } },
        // Beside the picture, so a caller of this list can resolve the framing rather than
        // drawing every framed cover unframed. `coverId` is the key `pictureFromMap` resolves by.
        coverId: true,
        coverScreens: true,
        cover: { select: MEDIA_IMAGE_SELECT_WITH_ID },
        tags: { select: { tag: { select: { id: true, name: true, slug: true } } } }
      }
    }),
    prisma.post.count({ where })
  ]);

  return ok(
    paginated(
      rows.map(({ tags, ...row }) => ({ ...row, tags: tags.map((link) => link.tag) })),
      total,
      page,
      pageSize
    )
  );
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canAuthor,
    "Writing an article needs author access. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, articleBodySchema);

  // An empty address is not offered for an article, so a create that arrives without one takes it from the
  // title. A title of nothing but punctuation slugifies to "" and is refused by name rather than saved
  // under an address nobody could reach.
  const slug = body.slug && body.slug.length > 0 ? body.slug : slugFromTitle(body.title);
  if (slug.length === 0) {
    throw fieldProblem(
      "slug",
      "This article needs a web address, and one could not be made from its title. Type one — lower-case letters, numbers and hyphens."
    );
  }

  assertOneBody(body.body, body.mdx);
  await assertSlugAvailable("post", slug);
  await assertMediaAvailable(prisma, body.coverId, { field: "coverId", what: "cover picture" });

  if (body.publishAt && body.unpublishAt && body.unpublishAt <= body.publishAt) {
    throw fieldProblem(
      "unpublishAt",
      "The date it comes off the site must be after the date it goes on."
    );
  }

  // The by-line. See the header for why this is a refusal rather than a silent correction.
  const authorId = body.authorId ?? user.id;
  if (authorId !== user.id && !canEditOthersContent(user)) {
    throw forbidden(
      "An article can only be filed under your own name. An editor can change the by-line afterwards if it belongs to somebody else."
    );
  }

  if (body.categoryId) {
    found(
      await prisma.category.findUnique({ where: { id: body.categoryId }, select: { id: true } }),
      "That category"
    );
  }

  const relatedIds = await readableRelatedIds(body.relatedIds, null);

  const transition = publishTransition(
    { status: "DRAFT", publishedAt: null, publishAt: null },
    { status: body.status, publishAt: body.publishAt },
    user,
    { schedulable: true }
  );

  const doc = parseRichText(body.body ?? null);

  try {
    const created = await mutateWithHistory<PostRow>(
      buildAuditContext(request, user),
      {
        action: transition.action,
        entityType: "Post",
        entityLabel: body.title,
        summary: "Created"
      },
      async (tx) => {
        const row = await tx.post.create({
          data: {
            title: body.title,
            slug,
            subtitle: body.subtitle,
            excerpt: body.excerpt,
            // `Prisma.JsonNull`, never a bare null: Prisma refuses to guess between "the JSON value null"
            // and "SQL NULL" on a nullable Json column.
            body: doc === null ? Prisma.JsonNull : (doc as unknown as Prisma.InputJsonValue),
            mdx: body.mdx,
            coverId: body.coverId,
            /*
             * Absent and cleared are the same answer on a CREATE — there is no stored framing to leave
             * alone — and both mean SQL NULL. `Prisma.JsonNull` rather than a bare `null`, because on a
             * Json column `null` means "ignore this field" (contract §14).
             */
            coverScreens: body.coverScreens
              ? (body.coverScreens as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            authorId,
            categoryId: body.categoryId,
            isFeatured: body.isFeatured,
            status: transition.status,
            publishAt: transition.publishAt === null ? null : body.publishAt,
            unpublishAt: body.unpublishAt,
            seoTitle: body.seoTitle,
            seoDescription: body.seoDescription,
            seoNoIndex: body.seoNoIndex,
            readingMinutes: readingMinutesFor(doc, body.mdx),
            ...(transition.publishedAt ? { publishedAt: transition.publishedAt } : {}),
            ...(relatedIds.length > 0 ? { relatedTo: { connect: relatedIds.map((id) => ({ id })) } } : {})
          },
          select: POST_SELECT
        });

        const tagIds = await resolveTagIds(tx, body.tags);
        if (tagIds.length > 0) {
          await tx.postTag.createMany({
            data: tagIds.map((tagId) => ({ postId: row.id, tagId })),
            skipDuplicates: true
          });
        }

        // The index is written with the tag and category NAMES, so the row is re-read with them attached
        // rather than guessed at. Same transaction, so a rolled-back save cannot leave a search result
        // pointing at an article that does not exist.
        const indexable = await tx.post.findUnique({
          where: { id: row.id },
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

    return ok({ post: created }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("post", slug);
    throw error;
  }
});

/**
 * The "read next" picks that actually exist, minus this article itself.
 *
 * A missing id is DROPPED rather than refused: the commonest cause is an article somebody else put in the
 * recycle bin while this one was open, and failing the whole save over a stale recommendation would be out
 * of all proportion to it. A self-reference is dropped for the same reason — the editor cannot have meant
 * "read this article next".
 */
async function readableRelatedIds(ids: readonly string[], selfId: string | null): Promise<string[]> {
  const wanted = ids.filter((id) => id.length > 0 && id !== selfId);
  if (wanted.length === 0) return [];

  const rows = await prisma.post.findMany({
    where: { id: { in: wanted }, deletedAt: null },
    select: { id: true }
  });
  const live = new Set(rows.map((row) => row.id));
  return wanted.filter((id) => live.has(id));
}
