/**
 * /news/[slug] — one article.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE BODY, ONE RENDERER, AND THE PAGE SAYS WHICH BRANCH IT TOOK.
 *
 * `Post.body` (Tiptap JSON) and `Post.mdx` are MUTUALLY EXCLUSIVE — the studio picks one mode per
 * piece (prisma/schema.prisma). `ProseArticle` takes both and prefers MDX when it is present, because a
 * record only acquires MDX by somebody deliberately switching it. `usesMdx` below is computed with the
 * same test so the rest of this page can agree with the renderer instead of guessing:
 *
 *   • Tiptap branch → the table of contents is built from `richTextHeadings()`, whose ids are the ones
 *     `RichText` puts on the headings. The two read the SAME map, so an anchor in the list is an anchor
 *     that exists.
 *   • MDX branch → NO table of contents. MDX headings are produced by the compiler at request time and
 *     carry no ids this page can enumerate; a contents list of guessed slugs would be a column of links
 *     that scroll nowhere.
 *
 * RELATED ARTICLES ARE TWO DIFFERENT FACTS WITH TWO DIFFERENT LABELS. `Post.relatedTo` is an editorial
 * choice — somebody decided these belong together — and it is labelled "Read next". The same-category
 * fallback is a MACHINE's guess and is labelled with the category ("More in Research") so a reader can
 * tell a recommendation from a filter. Conflating the two would quietly turn an editor's judgement into
 * an algorithm's.
 *
 * THE VIEW COUNT IS INCREMENTED FROM THE BROWSER, NOT HERE. See components/site/EventRegistration.tsx →
 * `ArticleViewBeacon` for the whole argument: a render is not a read, and a write inside a Server
 * Component makes the page uncacheable.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `generateStaticParams` + `revalidate`: the newsroom is prerendered and refreshed on a timer. The cost
 * is bounded staleness — a piece retired by its `unpublishAt` can stay readable for up to the
 * revalidation window, which is why that window is minutes rather than hours.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { ArrowLeft } from "lucide-react";

import { Reveal } from "@/components/motion";
import {
  ARTICLE_LIST_ORDER,
  ARTICLE_MEDIA_SELECT,
  ArticleCard,
  ArticleMeta,
  articleCardSelect,
  articlePublishedOn,
  articleReadingMinutes
} from "@/components/site/ArticleMeta";
import { CardGrid } from "@/components/site/CardGrid";
import { PageHero } from "@/components/site/PageHero";
import { ProseArticle } from "@/components/site/ProseArticle";
import { SectionHeading } from "@/components/site/SectionHeading";
import { ShareRow } from "@/components/site/ShareRow";
import { TableOfContents } from "@/components/site/TableOfContents";
import { TagList } from "@/components/site/TagList";
import { ArticleViewBeacon } from "@/components/site/EventRegistration";
import { LinkButton } from "@/components/ui/Button";
import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { ogImageUrl } from "@/lib/media/url";
import {
  parseRichText,
  richTextExcerpt,
  richTextHeadings,
  tableOfContentsWillRender
} from "@/lib/richtext";
import { absoluteUrl, articleJsonLd, pageMetadata, serializeJsonLd } from "@/lib/seo";
import { getSettingCached } from "@/lib/settings/service";
import { prerenderParams } from "@/lib/prerender";
import { cn } from "@/lib/utils";

/** Five minutes. Short enough that an `unpublishAt` retires a piece promptly; long enough to cache. */
export const revalidate = 300;

/** At most three related pieces are shown. More than that is a second listing, not a suggestion. */
const RELATED_SHOWN = 3;

/**
 * How many articles are prerendered at build time.
 *
 * A BUDGET, NOT A TRUNCATION. `dynamicParams` defaults to true, so an article outside this window is
 * rendered on its first request and cached from then on — nothing is unreachable and there is nothing
 * for a reader to be told. The cap exists so a Centre with 4,000 archived pieces does not spend an hour
 * of every build rendering the ones nobody has asked for.
 */
const PRERENDER_LIMIT = 200;

/**
 * ⚠ A FUNCTION, NOT A CONSTANT, BECAUSE IT CLOSES OVER `now`.
 *
 * `livePublishableWhere()` compares against an instant. Frozen into a module-level object it would be
 * evaluated once when the server started and every "read next" pick would then be filtered against a
 * clock that stopped at boot — a scheduled article would never appear in the rail, and an expired one
 * would never leave it.
 */
function postSelect(now: Date) {
  return {
    id: true,
    slug: true,
    title: true,
    subtitle: true,
    excerpt: true,
    body: true,
    mdx: true,
    readingMinutes: true,
    publishedAt: true,
    publishAt: true,
    updatedAt: true,
    cover: { select: ARTICLE_MEDIA_SELECT },
    author: { select: { name: true, title: true, avatar: { select: ARTICLE_MEDIA_SELECT } } },
    category: { select: { slug: true, name: true } },
    tags: {
      orderBy: { tag: { name: "asc" } },
      select: { tag: { select: { slug: true, name: true } } }
    },
    /**
     * The editor's own "read next" picks, filtered to the ones that are still public.
     *
     * NO `take`: these are hand-chosen and there are never many. Taking the whole list is what lets the
     * footnote below say how many were DROPPED, which a `take` would make indistinguishable from a cap.
     */
    relatedTo: {
      where: livePublishableWhere(now),
      orderBy: ARTICLE_LIST_ORDER,
      select: articleCardSelect
    },
    /** How many were CHOSEN, live or not — the other half of the honest footnote. */
    _count: { select: { relatedTo: true } }
  } satisfies Prisma.PostSelect;
}

export async function generateStaticParams() {
  // Wrapped so an unreachable database at BUILD time does not fail the deploy — see
  // lib/prerender.ts for why an empty list is a complete fallback here and not a swallowed error.
  return prerenderParams("news/[slug]", async () => {
    const posts = await prisma.post.findMany({
      where: livePublishableWhere(),
      orderBy: ARTICLE_LIST_ORDER,
      take: PRERENDER_LIMIT,
      select: { slug: true }
    });
    return posts.map((post) => ({ slug: post.slug }));
  });
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  const post = await prisma.post.findFirst({
    where: { slug, ...livePublishableWhere() },
    select: {
      title: true,
      subtitle: true,
      excerpt: true,
      body: true,
      seoTitle: true,
      seoDescription: true,
      seoNoIndex: true,
      publishedAt: true,
      publishAt: true,
      updatedAt: true,
      cover: { select: ARTICLE_MEDIA_SELECT },
      author: { select: { name: true } }
    }
  });

  // The page itself calls `notFound()`, which replaces this metadata with the 404's. Emitting a
  // `noIndex` title here means the brief window in which a crawler could see anything at all sees the
  // right instruction rather than a page called "undefined".
  if (!post) {
    return pageMetadata({ title: "Article not found", path: `/news/${slug}`, noIndex: true });
  }

  const description =
    post.seoDescription?.trim() ||
    post.excerpt?.trim() ||
    post.subtitle?.trim() ||
    richTextExcerpt(parseRichText(post.body), 200);

  return pageMetadata({
    title: post.seoTitle?.trim() || post.title,
    description,
    path: `/news/${slug}`,
    image: post.cover,
    noIndex: post.seoNoIndex,
    type: "article",
    publishedTime: articlePublishedOn(post),
    modifiedTime: post.updatedAt,
    authors: post.author?.name ? [post.author.name] : undefined
  });
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // ONE `now` for the whole render: the article's own publication test and its related rail must answer
  // to the same instant, or a piece can be live enough to read and not live enough to be linked from.
  const now = new Date();

  const post = await prisma.post.findFirst({
    where: { slug, ...livePublishableWhere(now) },
    select: postSelect(now)
  });

  // A missing row and an unpublished one are the same answer to a reader: this address holds nothing.
  // Distinguishing them would tell an outsider that a draft exists at a URL they guessed.
  if (!post) notFound();

  const branding = await getSettingCached("branding");
  const publishedAt = articlePublishedOn(post);
  const minutes = articleReadingMinutes(post);
  const path = `/news/${post.slug}`;
  const url = absoluteUrl(path);

  /**
   * THE SAME TEST `ProseArticle` USES. See the file header — this is what the rest of the page reads to
   * know which renderer ran, rather than inferring it.
   */
  const usesMdx = typeof post.mdx === "string" && post.mdx.trim().length > 0;
  const doc = usesMdx ? null : parseRichText(post.body);
  const headings = doc ? richTextHeadings(doc) : [];

  // Whether the layout below reserves a second column at all. See the note on the grid.
  const showTableOfContents = tableOfContentsWillRender(headings);

  /**
   * The author's public profile, if there is one.
   *
   * `Post.author` is a `User` — a studio account — and the schema has no relation from one to a
   * `Person`. The only join available is the name, and it is made EXACT (and case-sensitive) on purpose:
   * a fuzzy match would eventually attribute an article to a different researcher who happens to share
   * a surname, and a byline pointing at the wrong person is worse than a byline pointing nowhere. No
   * match means the name renders as plain text.
   */
  const [person, sameCategory] = await Promise.all([
    post.author?.name
      ? prisma.person.findFirst({
          where: { name: post.author.name, isVisible: true, ...liveStatusWhere() },
          select: { slug: true }
        })
      : Promise.resolve(null),
    // The fallback rail. Only fetched when the editor named nothing — an editorial choice always wins
    // over a category match, and querying for both would spend a round trip on a list that is discarded.
    post.relatedTo.length === 0 && post.category
      ? prisma.post.findMany({
          // Composed with `AND` rather than by spreading: `livePublishableWhere()` already owns a
          // top-level `OR`, and a second one beside it would replace the publication filter outright.
          where: {
            AND: [
              livePublishableWhere(now),
              { category: { slug: post.category.slug } },
              { id: { not: post.id } }
            ]
          },
          orderBy: ARTICLE_LIST_ORDER,
          take: RELATED_SHOWN,
          select: articleCardSelect
        })
      : Promise.resolve([])
  ]);

  const editorialPicks = post.relatedTo;
  const related = editorialPicks.length > 0 ? editorialPicks.slice(0, RELATED_SHOWN) : sameCategory;
  const relatedIsEditorial = editorialPicks.length > 0;
  // Two separate facts, and both belong on screen (contract §1.6): picks that no longer resolve, and
  // picks held back because three is the most this rail shows.
  const relatedDropped = relatedIsEditorial
    ? Math.max(0, post._count.relatedTo - editorialPicks.length)
    : 0;
  const relatedHeld = relatedIsEditorial ? Math.max(0, editorialPicks.length - RELATED_SHOWN) : 0;

  const tags = post.tags.map((link) => ({
    label: link.tag.name,
    href: `/news/tag/${link.tag.slug}`
  }));

  const jsonLd = articleJsonLd({
    title: post.title,
    description: post.excerpt?.trim() || post.subtitle?.trim() || null,
    path,
    imageUrl: ogImageUrl(post.cover),
    publishedAt,
    updatedAt: post.updatedAt,
    authorName: post.author?.name ?? null,
    publisherName: branding.siteName
  });

  return (
    <>
      <script
        type="application/ld+json"
        // `serializeJsonLd` escapes `<`, `>` and `&`, so a title containing "</script>" cannot close
        // this element early and have the rest of the article parsed as HTML (lib/seo.ts).
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      {/* Counts one read, from the browser, two seconds in. Renders nothing. */}
      <ArticleViewBeacon entityId={post.id} path={path} />

      <PageHero
        eyebrow={post.category?.name ?? "News"}
        title={post.title}
        description={post.subtitle ?? undefined}
        media={post.cover}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "News", href: "/news" },
          { name: post.title, href: path }
        ]}
        meta={
          <ArticleMeta
            author={
              post.author
                ? {
                    name: post.author.name,
                    title: post.author.title,
                    href: person ? `/people/${person.slug}` : null,
                    photo: post.author.avatar
                  }
                : null
            }
            publishedAt={publishedAt}
            updatedAt={post.updatedAt}
            minutes={minutes}
            category={post.category}
          />
        }
      />

      <div className="shell pb-24">
        {/*
          ⚠ THE SECOND TRACK IS DECLARED ONLY WHEN SOMETHING WILL STAND IN IT. `TableOfContents`
          returns `null` below two entries — but `null` removes the COMPONENT, and the `15rem` track
          is declared here, by this element, so it survived and reserved 240px for nothing. Measured
          on the built site: `grid-template-columns` computed to `976px 240px` with a single child,
          on EIGHTEEN of eighteen news articles, none of which reaches two headings.

          ⚠ It does not change how an article LOOKS today, and the note in lib/richtext.ts says why
          in full: the cover photograph breaks out of this column (1278px either way) and the prose
          is capped by `--measure` (576px either way). This stops a track being declared for content
          that is never there — which starts to matter the moment something in this column is not
          measure-capped.

          `tableOfContentsWillRender` is the component's own filter and threshold, exported so the
          two cannot disagree — the caller cannot recompute it, because `entries` drops headings
          with no id and that is exactly when a list is likeliest to fall short. Below `lg` there is
          one column either way; the component is `hidden lg:block`.
        */}
        <div
          className={cn(
            "grid gap-12 lg:gap-16",
            showTableOfContents ? "lg:grid-cols-[minmax(0,1fr)_15rem]" : "lg:grid-cols-1"
          )}
        >
          <div className="min-w-0">
            {/*
              THE BODY, AND THE DECK THAT INTRODUCES IT — ONE COMPONENT, NOT TWO ELEMENTS.

              `usesMdx` above records which of the two sources this is: with `mdx` set the MDX branch
              compiles it at request time; otherwise the Tiptap document in `body` is rendered by
              `RichText`. They are mutually exclusive by construction and `ProseArticle` never renders
              both.

              ══════════════════════════════════════════════════════════════════════════════════════
              ⚠ THE STANDFIRST IS A PROP RATHER THAN A `<p>` OF THIS PAGE'S OWN, AND THE ARITHMETIC FOR
                WHY IS THE WHOLE NOTE. It used to be drawn here as
                `<p className="prose-measure text-lg leading-relaxed text-ink-700 sm:text-xl">`, with
                the body in a sibling `<div className="mt-10">`. Every one of those classes is a plain
                utility on the element, specificity (0,1,0) — and `sm:` adds none at all, because a
                media query never does. Inside `.prose-typeset` the rule
                `.prose-typeset :is(p, li) { font-size: var(--prose-size) }` is (0,1,1). It was outside
                that box, so it kept its size; but it also kept it INDEPENDENTLY of the house style, so
                an administrator who set the reading size to Feature (21px) got a body larger than the
                deck introducing it. A standfirst smaller than its own article is the same fault as a
                heading smaller than its paragraph, and it was reachable from the Settings screen.

                `ProseArticle` sets the deck as `<p data-lead>` with `leadParagraphClassName()` — the
                same paragraph `components/RichText.tsx` draws for a `leadParagraph` node an editor
                inserted from the Style menu — and the recipe's own
                `[&_[data-lead]]:text-[max(1.125rem,calc(var(--prose-size)*1.18))]` reaches it at
                (0,2,0), which beats the (0,1,1) reading-size rule. So the deck is now a step ABOVE the
                body at every house size instead of a fixed 18–20px beside it, and a deck typed into the
                body and a deck typed into the Excerpt field are finally the same piece of type.

              ⚠ THE `mt-10` WRAPPER IS GONE AND ITS SPACING IS NOT LOST. `STANDFIRST_GAP.article` in
                ProseArticle is the same `mt-10`, passed into `RichText`'s own root className rather
                than wrapped around it — one more element between the recipe and the document's first
                paragraph and `.ts-dropcap > * > p:first-of-type` matches nothing. So the words sit
                exactly where they sat, and a house drop cap now lands on the right letter.

              ⚠ AND THE EMPTY CASE NEEDS NO TEST HERE. `standfirst` treats empty or whitespace-only as
                absent (its own prop doc says so), so `post.excerpt` — a nullable `String?` column — is
                passed straight through. The `?.trim()` guard this page used to repeat three times for
                one value is down to the two places that genuinely need it below.
              ══════════════════════════════════════════════════════════════════════════════════════
            */}
            <ProseArticle
              value={post.body}
              mdx={post.mdx}
              standfirst={post.excerpt}
              fallback={
                <p className="text-base leading-relaxed text-ink-500">
                  There is no article text for this piece yet — everything published so far is above.
                </p>
              }
            />

            {tags.length > 0 ? (
              <div className="prose-measure mt-12 border-t border-line-200 pt-6">
                <p className="field-label">Tagged</p>
                <TagList tags={tags} label="Tags" className="mt-2.5" />
              </div>
            ) : null}

            <div className="prose-measure mt-10">
              <ShareRow
                url={url}
                title={post.title}
                text={post.excerpt?.trim() || post.subtitle?.trim() || undefined}
                label="Share this article"
              />
            </div>
          </div>

          {/*
            Second in the DOM and second in the grid, so the reading order is the article first. It is
            `hidden lg:block` inside, which takes it out of the tab order rather than merely off screen,
            and it renders nothing at all for the MDX branch (see the header) or for an article with
            fewer than two headings.
          */}
          <TableOfContents headings={headings} title="In this article" />
        </div>

        {related.length > 0 ? (
          <Reveal as="section" className="mt-20 border-t border-line-200 pt-14">
            <SectionHeading
              level={2}
              title={
                relatedIsEditorial
                  ? "Read next"
                  : `More in ${post.category?.name ?? "the newsroom"}`
              }
              description={
                relatedIsEditorial
                  ? "Chosen by the editors as the pieces that follow on from this one."
                  : "Other articles filed under the same category, newest first."
              }
              link={
                !relatedIsEditorial && post.category
                  ? {
                      href: `/news/category/${post.category.slug}`,
                      label: `All of ${post.category.name}`
                    }
                  : undefined
              }
            />

            <div className="mt-8">
              <CardGrid columns={3} stagger>
                {related.map((entry) => (
                  <ArticleCard key={entry.id} post={entry} headingLevel={3} />
                ))}
              </CardGrid>
            </div>

            {relatedDropped > 0 || relatedHeld > 0 ? (
              <p className="mt-6 text-sm text-ink-500">
                {relatedHeld > 0
                  ? `Showing ${related.length} of the ${editorialPicks.length} articles chosen for this rail. `
                  : null}
                {relatedDropped > 0
                  ? `${relatedDropped} chosen ${relatedDropped === 1 ? "article is" : "articles are"} no longer published and ${relatedDropped === 1 ? "is" : "are"} not shown.`
                  : null}
              </p>
            ) : null}
          </Reveal>
        ) : null}

        <div className="mt-16">
          <LinkButton href="/news" variant="secondary" icon={ArrowLeft}>
            All news
          </LinkButton>
        </div>
      </div>
    </>
  );
}
