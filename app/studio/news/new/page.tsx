import type { Metadata } from "next";
import type { Role } from "@prisma/client";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { siteUrl, storageConfigured } from "@/lib/env";
import { ROLES_DESCENDING, canAuthor, hasRank } from "@/lib/permissions";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { ArticleEditor, type ArticleValue } from "../[id]/ArticleEditor";

/**
 * The new-article screen.
 *
 * It renders the SAME editor as the screen next door, in `create` mode. Two forms for one set of fields
 * is two places to add the next field to, and the one that gets forgotten is always the one somebody is
 * using.
 *
 * THE AUTHOR DEFAULTS TO WHOEVER IS WRITING. An article with no author is treated as somebody else's by
 * `canEditRecord`, so a draft created without one would need an editor to reopen it — which is exactly
 * backwards for the person who has just written it.
 *
 * ⚠ A STATIC SEGMENT ALONGSIDE `[id]`, and Next matches static segments first, so `/studio/news/new` can
 * never be read as an article whose id is the word "new".
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "New article"
};

const TAG_SUGGESTION_LIMIT = 60;

export default async function StudioNewArticlePage() {
  const user = await requireStudioCapability(
    canAuthor,
    "Writing a news article needs author access or higher. An administrator can raise yours."
  );

  /** Roles that may be named as an author, derived through the one rank comparison in the codebase. */
  const authoringRoles: Role[] = ROLES_DESCENDING.filter((role) =>
    hasRank({ id: "role-probe", role }, "AUTHOR")
  );

  const [categories, tagRows, authorRows] = await prisma.$transaction([
    prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true }
    }),
    prisma.tag.findMany({
      orderBy: [{ posts: { _count: "desc" } }, { name: "asc" }],
      take: TAG_SUGGESTION_LIMIT + 1,
      select: { name: true }
    }),
    prisma.user.findMany({
      where: { deletedAt: null, isActive: true, role: { in: authoringRoles } },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    })
  ]);

  const blank: ArticleValue = {
    title: "",
    slug: "",
    subtitle: "",
    excerpt: "",
    // `null`, not an empty document: the editor decides which of the two writing modes a new article
    // starts in, and an empty Tiptap document would be indistinguishable from one somebody had cleared.
    body: null,
    mdx: "",
    coverId: null,
    authorId: user.id,
    categoryId: null,
    tags: [],
    relatedIds: [],
    isFeatured: false,
    status: "DRAFT",
    publishedAt: null,
    publishAt: null,
    unpublishAt: null,
    seoTitle: "",
    seoDescription: "",
    seoNoIndex: false,
    readingMinutes: 0
  };

  return (
    <div className="mx-auto w-full max-w-[96rem] space-y-6">
      <StudioPageHeader
        title="New article"
        back={{ href: "/studio/news", label: "News" }}
        breadcrumb={[{ label: "News", href: "/studio/news" }, { label: "New article" }]}
        description="Write the headline first — the web address follows it until you change it yourself."
      />

      <HelpText>
        Nothing is created until you choose &ldquo;Create this article&rdquo;. It starts as a draft, so it
        will not appear on the public site until it is published.
      </HelpText>

      <ArticleEditor
        mode="create"
        postId={null}
        initial={blank}
        initialCover={null}
        categories={categories}
        tagSuggestions={tagRows.slice(0, TAG_SUGGESTION_LIMIT).map((tag) => tag.name)}
        tagSuggestionsTruncated={tagRows.length > TAG_SUGGESTION_LIMIT}
        authors={authorRows}
        authorName={user.name}
        user={user}
        storageReady={storageConfigured()}
        siteOrigin={siteUrl().replace(/\/+$/, "")}
      />
    </div>
  );
}
