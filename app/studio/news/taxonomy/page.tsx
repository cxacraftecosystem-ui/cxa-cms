import type { Metadata } from "next";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageContent } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { TaxonomyManager, type TaxonomyTerm } from "./TaxonomyManager";

/**
 * Categories and tags.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageContent)` — the newsroom's taxonomy is an EDITOR's job, which is exactly
 * what `lib/permissions.ts` says the predicate covers. An author files an article under an existing
 * category and creates tags while writing; renaming, merging and removing them changes what every other
 * author sees, so it sits a tier higher. The news list hides the link to this screen with the same
 * predicate, so nobody is offered a screen that then refuses them (contract §1.7).
 *
 * THE COUNTS ARE FILTERED RELATION COUNTS, IN ONE QUERY EACH. "How many articles are filed under each of
 * these" is what makes a merge a decision rather than a gamble, and asking per row would be one round trip
 * per category for one small integer. The filter is what keeps articles in the recycle bin out of a number
 * that is about to be used in a sentence promising what will move.
 *
 * THE TAG LIST IS CAPPED, AND THE CAP IS STATED ON SCREEN. Tags are created freely while writing, so a
 * busy newsroom accumulates hundreds; a screen listing all of them is a screen nobody can use. The
 * `tagTotal` beside the cap is what stops a shortened list reading as the whole set (contract §1.6).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Categories and tags"
};

/** How many tags the screen lists. Past this it is a data-entry screen rather than an editing one. */
const TAG_LIMIT = 200;

export default async function StudioNewsTaxonomyPage() {
  await requireStudioCapability(
    canManageContent,
    "Renaming, merging and removing categories and tags needs editor access, because it changes what every author sees. An administrator can raise yours."
  );

  const [categoryRows, tagRows, tagTotal] = await prisma.$transaction([
    prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        // Drafts included, recycled excluded — this number is a promise about what a merge will move.
        _count: { select: { posts: { where: { deletedAt: null } } } }
      }
    }),
    prisma.tag.findMany({
      // Most used first, so the tags worth tidying are the ones on screen.
      orderBy: [{ posts: { _count: "desc" } }, { name: "asc" }],
      take: TAG_LIMIT,
      select: {
        id: true,
        name: true,
        slug: true,
        // `posts` on a tag is the join table, so the filter reaches through it to the article itself.
        _count: { select: { posts: { where: { post: { deletedAt: null } } } } }
      }
    }),
    prisma.tag.count()
  ]);

  const categories: TaxonomyTerm[] = categoryRows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    articleCount: row._count.posts
  }));

  const tags: TaxonomyTerm[] = tagRows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    // Tags have no description column. `null` rather than `""` so the list renders nothing at all rather
    // than an empty line under every tag.
    description: null,
    articleCount: row._count.posts
  }));

  return (
    <div className="mx-auto w-full max-w-[72rem] space-y-6">
      <StudioPageHeader
        title="Categories and tags"
        back={{ href: "/studio/news", label: "News" }}
        breadcrumb={[{ label: "News", href: "/studio/news" }, { label: "Categories and tags" }]}
        description="How the newsroom is organised. A category is the one place an article is filed; tags are cross-cutting labels an article can carry several of. Both have their own pages on the site."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {categories.length === 1 ? "1 category" : `${categories.length} categories`} ·{" "}
            {tagTotal === 1 ? "1 tag" : `${tagTotal} tags`}
          </span>
        }
      />

      <TaxonomyManager
        categories={categories}
        tags={tags}
        tagsTruncated={tagTotal > tags.length}
        tagTotal={tagTotal}
      />
    </div>
  );
}
