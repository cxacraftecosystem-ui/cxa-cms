import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { cache } from "react";
import { ExternalLink } from "lucide-react";
import type { Role } from "@prisma/client";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteUrl, storageConfigured } from "@/lib/env";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { ROLES_DESCENDING, canAuthor, canEditRecord, hasRank } from "@/lib/permissions";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { ArticleEditor, type ArticleValue } from "./ArticleEditor";

/**
 * The article editor.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO GUARDS, IN ORDER, BECAUSE THE SECOND ONE NEEDS THE ROW.
 *
 * `requireStudioCapability(canAuthor)` refuses anybody who cannot write at all — the floor, and the same
 * predicate the sidebar and the `/api/studio/news/*` handlers use. Then the row is read, and
 * `canEditRecord(user, post.authorId)` decides whether THIS reader may edit THIS article: own content for
 * an author, anyone's for an editor. It throws rather than rendering a read-only shell, because a screen
 * full of controls that will be refused is exactly what contract §1.8 forbids.
 *
 * An UNOWNED article — the author's account has since been removed — is treated as somebody else's and
 * needs an editor. That is the safe direction: it requires a promotion rather than falling open to
 * whoever happens to be signed in (see `canEditRecord`).
 *
 * WHO MAY BE NAMED AS THE AUTHOR IS DERIVED FROM `lib/permissions.ts`, NOT LISTED BY HAND. A second
 * hand-rolled rank test that disagrees with the first is how a rule silently stops matching, so the roles
 * are filtered through `hasRank` — the one comparison in the codebase. The article's CURRENT author is
 * unioned in regardless of their present role, or reassigning would silently drop the name of somebody
 * who has since been demoted.
 *
 * `notFound()` IS CALLED HERE, so no `loading.tsx` may be added to this segment or above it (contract
 * §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** How many tag names the editor offers as suggestions. The cap is stated on screen. */
const TAG_SUGGESTION_LIMIT = 60;

/** `cache()` so `generateMetadata` and the page body cost one query rather than two. */
const loadPost = cache(async (id: string) => {
  return prisma.post.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      title: true,
      slug: true,
      subtitle: true,
      excerpt: true,
      body: true,
      mdx: true,
      coverId: true,
      authorId: true,
      categoryId: true,
      status: true,
      publishedAt: true,
      publishAt: true,
      unpublishAt: true,
      deletedAt: true,
      isFeatured: true,
      seoTitle: true,
      seoDescription: true,
      seoNoIndex: true,
      readingMinutes: true,
      author: { select: { id: true, name: true } },
      cover: { select: MEDIA_IMAGE_SELECT },
      tags: { select: { tag: { select: { name: true } } } },
      // The editorial picks this article makes, not the ones made about it. `relatedFrom` is the other
      // direction and belongs to those articles' own editors.
      relatedTo: { select: { id: true } }
    }
  });
});

export async function generateMetadata({
  params
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const post = await loadPost(id);
  return { title: post ? post.title : "Article not found" };
}

export default async function StudioArticlePage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireStudioCapability(
    canAuthor,
    "Editing a news article needs author access or higher. An administrator can raise yours."
  );

  const { id } = await params;
  const post = await loadPost(id);
  if (!post) notFound();

  if (!canEditRecord(user, post.authorId)) {
    // NEXT'S `forbidden()`, not the `ApiError` helper of the same name from `@/lib/api` (contract §1.9).
    // This is a Server Component: there is no `route()` wrapper to catch a throw, so an `ApiError` here
    // becomes an unhandled server error and the author is shown `app/error.tsx`'s "something went wrong
    // on our side" with a 500 — which is false, and reads as a broken CMS rather than as a refusal.
    // `forbidden()` renders `app/studio/forbidden.tsx` with a real 403.
    forbidden();
  }

  /** Roles that may be named as an author, derived through the one rank comparison. */
  const authoringRoles: Role[] = ROLES_DESCENDING.filter((role) =>
    hasRank({ id: "role-probe", role }, "AUTHOR")
  );

  const [categories, tagRows, authorRows] = await prisma.$transaction([
    prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true }
    }),
    // Most used first, so the suggestions are the tags the newsroom actually files under.
    prisma.tag.findMany({
      orderBy: [{ posts: { _count: "desc" } }, { name: "asc" }],
      take: TAG_SUGGESTION_LIMIT + 1,
      select: { name: true }
    }),
    prisma.user.findMany({
      where: {
        deletedAt: null,
        OR: [
          { isActive: true, role: { in: authoringRoles } },
          // The current author, whatever their role is now — see the header.
          ...(post.authorId ? [{ id: post.authorId }] : [])
        ]
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true }
    })
  ]);

  const initial: ArticleValue = {
    title: post.title,
    slug: post.slug,
    // Nullable columns arrive as `""`: a controlled input handed null switches to uncontrolled and React
    // warns, and the warning is the least of it — the field then stops tracking what is typed into it.
    subtitle: post.subtitle ?? "",
    excerpt: post.excerpt ?? "",
    body: post.body as unknown,
    mdx: post.mdx ?? "",
    coverId: post.coverId,
    authorId: post.authorId,
    categoryId: post.categoryId,
    tags: post.tags.map((entry) => entry.tag.name),
    relatedIds: post.relatedTo.map((related) => related.id),
    isFeatured: post.isFeatured,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    publishAt: post.publishAt?.toISOString() ?? null,
    unpublishAt: post.unpublishAt?.toISOString() ?? null,
    seoTitle: post.seoTitle ?? "",
    seoDescription: post.seoDescription ?? "",
    seoNoIndex: post.seoNoIndex,
    // Recomputed by the editor from what is actually written; this is only the starting value.
    readingMinutes: post.readingMinutes ?? 0
  };

  const origin = siteUrl().replace(/\/+$/, "");
  const live = isLive(post);
  const publicPath = `/news/${post.slug}`;

  return (
    <div className="mx-auto w-full max-w-[96rem] space-y-6">
      <StudioPageHeader
        title={post.title.trim().length > 0 ? post.title : "Untitled article"}
        back={{ href: "/studio/news", label: "News" }}
        breadcrumb={[{ label: "News", href: "/studio/news" }, { label: post.title }]}
        meta={<StatusBadge status={post.status} size="sm" />}
        actions={
          live ? (
            <a
              href={`${origin}${publicPath}`}
              target="_blank"
              rel="noreferrer"
              // Opted out of the unsaved-changes guard: a new tab takes neither the reader nor their
              // typing off this screen.
              data-allow-unsaved=""
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line-200 bg-card px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:border-purple-300 hover:text-purple-700"
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
              Read it on the site
            </a>
          ) : null
        }
      />

      <ArticleEditor
        mode="edit"
        postId={post.id}
        initial={initial}
        initialCover={post.cover}
        categories={categories}
        tagSuggestions={tagRows.slice(0, TAG_SUGGESTION_LIMIT).map((tag) => tag.name)}
        tagSuggestionsTruncated={tagRows.length > TAG_SUGGESTION_LIMIT}
        authors={authorRows}
        authorName={post.author?.name ?? null}
        user={user}
        storageReady={storageConfigured()}
        siteOrigin={origin}
      />
    </div>
  );
}
