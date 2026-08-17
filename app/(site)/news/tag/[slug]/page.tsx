/**
 * /news/tag/[slug] — one topic's archive.
 *
 * The same argument as the category archive next door: this is a PAGE and not a query-string view,
 * because it is the address an article's tag chip points at and the one anybody else links to. It
 * therefore carries its own title, its own description and its own canonical URL, and /news
 * canonicalises a single-tag view here (see app/(site)/news/page.tsx).
 *
 * ⚠ `Tag` IS SHARED WITH EVENTS. One tag row can be attached to posts and to events (prisma.schema:
 * `Tag.posts` / `Tag.events`), so a topic can legitimately have articles here and events at
 * /events?tag=… . This page counts and lists ARTICLES only, and says so in its own words rather than
 * implying the tag holds nothing when the newsroom happens not to have used it.
 *
 * A tag that does not exist is a 404. A tag that exists with no live articles is a page with an empty
 * state — the first is a wrong address, the second is a true statement about a real topic.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Newspaper, SearchX } from "lucide-react";

import { Reveal } from "@/components/motion";
import {
  ARTICLE_LIST_ORDER,
  ArticleCard,
  articleCardAssets,
  articleCardSelect
} from "@/components/site/ArticleMeta";
import { CardGrid } from "@/components/site/CardGrid";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pagination } from "@/components/ui/Pagination";
import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
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

export async function generateMetadata({
  params,
  searchParams
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const page = pageFrom(query.page);

  const tag = await prisma.tag.findUnique({ where: { slug }, select: { name: true } });
  if (!tag) {
    return pageMetadata({ title: "Topic not found", path: `/news/tag/${slug}`, noIndex: true });
  }

  return pageMetadata({
    title: page > 1 ? `${tag.name} — page ${page}` : `${tag.name} — news`,
    description: `Articles from the Centre tagged ${tag.name}, newest first.`,
    path: page > 1 ? `/news/tag/${slug}?page=${page}` : `/news/tag/${slug}`,
    keywords: [tag.name]
  });
}

export default async function NewsTagPage({
  params,
  searchParams
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const page = pageFrom(query.page);

  const tag = await prisma.tag.findUnique({ where: { slug }, select: { slug: true, name: true } });
  if (!tag) notFound();

  // ONE `now`, so the count and the rows cannot answer to two different instants.
  const now = new Date();
  // Composed with `AND`: `livePublishableWhere()` owns a top-level `OR`, and spreading a second filter
  // beside it would replace the publication test outright.
  const where = { AND: [livePublishableWhere(now), { tags: { some: { tag: { slug } } } }] };

  const [total, rows, eventCount] = await Promise.all([
    prisma.post.count({ where }),
    prisma.post.findMany({
      where,
      orderBy: ARTICLE_LIST_ORDER,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: articleCardSelect
    }),
    // The same tag can carry events. Counted so this page can point at them instead of implying the
    // topic is empty when it is only empty of articles.
    prisma.coeEvent.count({ where: { ...liveStatusWhere(), tags: { some: { tag: { slug } } } } })
  ]);

  // The photographs this page's covers need to be framed, in one query. No query at all when nothing
  // here is framed, which is why it is unguarded — see `articleCardAssets`.
  const cardAssets = await articleCardAssets(rows);

  const pastTheEnd = total > 0 && rows.length === 0;
  const base = `/news/tag/${tag.slug}`;

  const eventsLink =
    eventCount > 0 ? (
      <LinkButton href={`/events?tag=${encodeURIComponent(tag.slug)}`} variant="secondary" icon={CalendarDays}>
        {eventCount === 1 ? "1 event on this topic" : `${eventCount} events on this topic`}
      </LinkButton>
    ) : null;

  return (
    <>
      <PageHero
        eyebrow="Newsroom topic"
        title={tag.name}
        description={`Articles from the Centre tagged ${tag.name}, newest first.`}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "News", href: "/news" },
          { name: tag.name, href: base }
        ]}
        actions={
          <>
            <LinkButton href="/news" variant="secondary" icon={ArrowLeft}>
              All news
            </LinkButton>
            {eventsLink}
          </>
        }
      />

      <div className="shell pb-24">
        {pastTheEnd ? (
          <EmptyState
            headingLevel={2}
            icon={SearchX}
            title="That page is past the end of this archive"
            description={`${tag.name} holds ${total} ${total === 1 ? NOUN.singular : NOUN.plural}, which is fewer than page ${page} would need.`}
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
            title={`No articles are tagged ${tag.name}`}
            description={
              eventCount > 0
                ? "The topic is in use elsewhere on the site — the events tagged with it are linked above."
                : "The topic exists and is ready to be used; articles appear here as soon as one carries it."
            }
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
              title={`Articles tagged ${tag.name}`}
              // The `<h1>` already names the topic; this heading exists so the grid sits under something
              // in the document outline rather than beside the hero.
              titleClassName="sr-only"
            />

            <CardGrid columns={3} stagger>
              {rows.map((post) => (
                <ArticleCard key={post.id} post={post} assets={cardAssets} headingLevel={3} />
              ))}
            </CardGrid>

            {/* Pagination owns the range sentence, inside its own `role="status"`. Nothing is capped:
                every article carrying this tag is reachable by walking the pages. */}
            <Reveal as="div" className="mt-14">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={total}
                baseHref={base}
                label={`${tag.name} articles`}
                itemNoun={NOUN}
              />
            </Reveal>
          </>
        )}
      </div>
    </>
  );
}
