/**
 * /news/category/[slug] — one category's archive.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS A PAGE, NOT A QUERY-STRING VIEW, BECAUSE IT IS WHAT GETS LINKED TO.
 *
 * `/news?category=research` and `/news/category/research` would show the same rows, but only one of
 * them is a destination: it is the address on an article's byline, in a newsletter, in another site's
 * link to "the Centre's research news". So it has its own title, its own description and its own
 * canonical URL — and /news canonicalises a single-category view HERE rather than competing with it
 * (see app/(site)/news/page.tsx).
 *
 * A CATEGORY THAT DOES NOT EXIST IS A 404. A category that exists and holds nothing is a page with an
 * empty state: the first is a wrong address, the second is a true statement about a real category, and
 * collapsing them would 404 a link that was correct the day it was written.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The page reads `searchParams` for `?page=`, which opts it out of static rendering. That is the right
 * trade for an archive: it is rendered from the database on request, so a piece published a minute ago
 * is in it, and the rows are what a crawler receives in the HTML.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, Newspaper, SearchX } from "lucide-react";

import { Reveal } from "@/components/motion";
import {
  ARTICLE_LIST_ORDER,
  ArticleCard,
  articleCardSelect
} from "@/components/site/ArticleMeta";
import { CardGrid } from "@/components/site/CardGrid";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { livePublishableWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { pageMetadata } from "@/lib/seo";

const PAGE_SIZE = 12;
const NOUN = { singular: "article", plural: "articles" } as const;

type SearchParams = Record<string, string | string[] | undefined>;

/** 1-based, never below 1. A junk `?page=abc` is page one rather than an error page. */
function pageFrom(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 1 ? Math.floor(parsed) : 1;
}

function describe(category: { name: string; description: string | null }): string {
  return (
    category.description?.trim() ||
    `Everything the Centre has published under ${category.name}, newest first.`
  );
}

export async function generateMetadata({
  params,
  searchParams
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const page = pageFrom(query.page);

  const category = await prisma.category.findUnique({
    where: { slug },
    select: { name: true, description: true }
  });

  if (!category) {
    return pageMetadata({ title: "Category not found", path: `/news/category/${slug}`, noIndex: true });
  }

  return pageMetadata({
    title: page > 1 ? `${category.name} — page ${page}` : `${category.name} news`,
    description: describe(category),
    // Page 2 is a different document from page 1; collapsing them would tell a crawler that the
    // articles on it do not exist.
    path: page > 1 ? `/news/category/${slug}?page=${page}` : `/news/category/${slug}`
  });
}

export default async function NewsCategoryPage({
  params,
  searchParams
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const page = pageFrom(query.page);

  const category = await prisma.category.findUnique({
    where: { slug },
    select: { slug: true, name: true, description: true }
  });

  if (!category) notFound();

  // ONE `now`, so the count and the rows cannot answer to two different instants.
  const now = new Date();
  // Composed with `AND`: `livePublishableWhere()` owns a top-level `OR` and spreading a second filter
  // beside it would replace the publication test outright.
  const where = { AND: [livePublishableWhere(now), { category: { slug } }] };

  const [total, rows] = await Promise.all([
    prisma.post.count({ where }),
    prisma.post.findMany({
      where,
      orderBy: ARTICLE_LIST_ORDER,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: articleCardSelect
    })
  ]);

  // A stale `?page=` past the end of the archive. Its remedy is page one, which is not the remedy for
  // an archive that is genuinely empty — so the two say different things.
  const pastTheEnd = total > 0 && rows.length === 0;
  const base = `/news/category/${category.slug}`;

  return (
    <>
      <PageHero
        eyebrow="Newsroom category"
        title={category.name}
        description={describe(category)}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "News", href: "/news" },
          { name: category.name, href: base }
        ]}
        actions={
          <LinkButton href="/news" variant="secondary" icon={ArrowLeft}>
            All news
          </LinkButton>
        }
      />

      <div className="shell pb-24">
        {pastTheEnd ? (
          <EmptyState
            headingLevel={2}
            icon={SearchX}
            title="That page is past the end of this archive"
            description={`${category.name} holds ${total} ${total === 1 ? NOUN.singular : NOUN.plural}, which is fewer than page ${page} would need.`}
            action={
              <LinkButton href={base} variant="secondary">
                Back to the first page
              </LinkButton>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            headingLevel={2}
            icon={Newspaper}
            title={`Nothing has been published under ${category.name} yet`}
            description="The category exists and is ready to be used; pieces appear here as soon as one is filed under it."
            action={
              <LinkButton href="/news" variant="secondary">
                Read the rest of the newsroom
              </LinkButton>
            }
          />
        ) : (
          <>
            <SectionHeading
              level={2}
              title={`${category.name} articles`}
              // The page's `<h1>` already says the category; this heading is here so the grid sits under
              // something in the document outline rather than being a sibling of the hero.
              titleClassName="sr-only"
            />

            <CardGrid columns={3} stagger>
              {rows.map((post) => (
                <ArticleCard key={post.id} post={post} headingLevel={3} />
              ))}
            </CardGrid>

            {/* Pagination owns the range sentence, inside its own `role="status"`. Nothing is capped:
                every article filed under this category is reachable by walking the pages. */}
            <Reveal as="div" className="mt-14">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={total}
                baseHref={base}
                label={`${category.name} news`}
                itemNoun={NOUN}
              />
            </Reveal>
          </>
        )}
      </div>
    </>
  );
}
