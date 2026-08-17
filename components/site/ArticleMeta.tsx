/**
 * ArticleMeta — the newsroom's byline row, the card that carries the same facts in miniature, and the
 * ONE reading-time rule both of them use.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY A QUERY SELECT LIVES IN A COMPONENT FILE.
 *
 * Four routes render a list of articles — /news, /news/category/[slug], /news/tag/[slug] and the
 * "read next" rail on an article. Each one needs the same columns, in the same shape, with the same
 * fallbacks. `articleCardSelect` and `ArticleCard` are therefore defined together, so the card cannot
 * start reading a column the query stopped selecting: a card is only as honest as its `select`, and
 * four hand-copied selects drift the first time one of them gains a field.
 *
 * ⚠ THE SELECT PULLS `body` AND `mdx` INTO A LIST QUERY, WHICH IS NOT FREE — a page of twelve cards
 * carries twelve Tiptap documents it never renders. It is deliberate: `Post.readingMinutes` is a
 * nullable column the studio stamps at write time, and the rows that predate it (or that were
 * imported) have nothing in it. The alternatives are a card that silently omits the reading time for
 * some articles and not others, or a number invented from the excerpt. Loading the body and measuring
 * it is the only one of the three that is true. When every row is stamped this can be trimmed to
 * `readingMinutes` alone.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE AUTHOR IS ONLY A LINK WHEN THE PAGE HANDS ONE OVER. `Post.author` is a `User` — a studio
 * account — and a studio account has no public page. The article page resolves a link by looking for a
 * published `Person` with exactly that name (see app/(site)/news/[slug]/page.tsx, which explains why
 * the match has to be exact) and passes `href` only when it finds one. No match means a name in plain
 * text, which is right: a byline that links to the wrong researcher is worse than one that links
 * nowhere.
 *
 * DATES ARE FORMATTED ON THE SERVER, IN ONE FIXED ZONE, FOR EVERY READER. A publication date is a
 * calendar date derived from an instant; rendering it in the reader's own zone would make the same
 * article a day older in Delhi than in London. UTC matches
 * `components/sections/NewsShowcaseSection.tsx`, so a piece is never dated one day on the homepage and
 * another in the newsroom. (Event TIMES are a different problem and are rendered in the Centre's zone
 * — see components/site/EventDateBlock.tsx.)
 *
 * A Server Component, and it must stay one: `ArticleCard` renders `MediaImage`, and a client version
 * would push `next/image` and every card's layout into the browser bundle of four listing pages. It also
 * READS now — `articleCardAssets` fetches the photographs a per-screen framing names — so the transitively
 * `server-only` import below turns a `"use client"` here into a build error rather than a runtime one.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { Clock } from "lucide-react";

import { EntityCard } from "@/components/site/EntityCard";
import { MediaImage } from "@/components/ui/MediaImage";
import { framingAssets, withBaseAsset } from "@/lib/media/framing";
import { pictureFromMap, type ScreenFraming } from "@/lib/media/screens";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import type { MediaLike } from "@/lib/media/url";
import { parseRichText, richTextToPlainText } from "@/lib/richtext";
import { cn, readingMinutes, truncateWords } from "@/lib/utils";

/**
 * Everything `<MediaImage>` needs and nothing else — structurally identical to `MediaLike`.
 *
 * `variants` is not optional: without it `pickVariant` has nothing to choose from and every cover on
 * the page falls back to the full-size ORIGINAL, i.e. a 6 MB photograph inside a 400px card. The list
 * now comes from lib/media/select.ts, which is also where the crop columns arrive from — the
 * hand-written copy this replaced omitted them, so every article cover rendered uncropped. The name is
 * kept because four routes import it.
 */
export const ARTICLE_MEDIA_SELECT = MEDIA_IMAGE_SELECT;

/** The columns an article card renders, plus the two the reading-time fallback measures. */
export const articleCardSelect = {
  id: true,
  slug: true,
  title: true,
  subtitle: true,
  excerpt: true,
  publishedAt: true,
  publishAt: true,
  readingMinutes: true,
  body: true,
  mdx: true,
  /**
   * The cover, its per-screen framing, and its ID — and the id is the part that looks redundant.
   *
   * `pictureFromMap` resolves the BASE photograph out of the media map by id, exactly like a bucket that
   * names an alternate (lib/media/screens.ts), so a row carrying the relation but not the id could not be
   * framed at all. Selecting the framing beside the picture it belongs to is the whole rule the header of
   * scripts/media-select-check.ts exists to state.
   */
  coverId: true,
  coverScreens: true,
  cover: { select: ARTICLE_MEDIA_SELECT },
  category: { select: { slug: true, name: true } }
} satisfies Prisma.PostSelect;

export type ArticleCardPost = Prisma.PostGetPayload<{ select: typeof articleCardSelect }>;

/**
 * The stored framing, typed.
 *
 * Prisma answers a JSONB column as `JsonValue` and the shape belongs to lib/media/screens.ts, so the cast
 * is where the two meet. Nothing downstream trusts it: `resolvePicture` reads each bucket defensively and
 * an unusable rectangle degrades to "no crop", so a hand-edited row is a plain photograph rather than a
 * broken frame.
 *
 * Takes the column rather than the card row, because the article page selects a wider shape than the card
 * does and both need this one answer.
 */
export function articleCoverFraming(post: {
  coverScreens: Prisma.JsonValue;
}): ScreenFraming | null {
  return (post.coverScreens ?? null) as unknown as ScreenFraming | null;
}

/**
 * Every photograph a page of these cards needs to draw its covers framed, in ONE query.
 *
 * It lives beside the select for the same reason the select lives beside the card: four routes render this
 * list, and the alternates a framing names are arbitrary ids in a JSONB column that no relation joins — so
 * a route that fetched the covers and not the alternates would silently draw the phone picture at every
 * width. `framingAssets` issues no query at all when nothing on the page is framed (see its header), which
 * is why this is called unconditionally rather than guarded per route.
 *
 * The covers themselves are folded in afterwards because `pictureFromMap` looks the base photograph up by
 * id like any other band.
 */
export async function articleCardAssets(
  posts: readonly ArticleCardPost[]
): Promise<Record<string, MediaLike | undefined>> {
  const alternates = await framingAssets(...posts.map(articleCoverFraming));
  return posts.reduce(
    (into, post) => withBaseAsset(into, post.coverId, post.cover),
    alternates
  );
}

/**
 * Newest first — the order every newsroom listing uses.
 *
 * ⚠ `nulls: "last"` IS LOAD-BEARING. Postgres sorts NULLs FIRST on a descending order, so without it a
 * piece that is live on its `publishAt` but has not been stamped `publishedAt` yet would jump to the
 * top of the newsroom ahead of everything carrying a real date. It lives here, beside the select, so the
 * four routes that render this list cannot each answer the question differently.
 */
export const ARTICLE_LIST_ORDER: Prisma.PostOrderByWithRelationInput[] = [
  { publishedAt: { sort: "desc", nulls: "last" } },
  { publishAt: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" }
];

const ARTICLE_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});

/**
 * The date a reader should see.
 *
 * `publishedAt` is stamped when a piece goes live. A SCHEDULED piece past its `publishAt` is already
 * public but may not have been stamped yet, because the cron that does it is a convenience and the
 * read-time filter is the mechanism (lib/content.ts). Falling back means a piece that went live an
 * hour ago is dated today rather than not dated at all.
 */
export function articlePublishedOn(post: {
  publishedAt: Date | null;
  publishAt: Date | null;
}): Date | null {
  return post.publishedAt ?? post.publishAt ?? null;
}

/** A publication date in words, or null when there is no usable date. Never "Invalid Date". */
export function formatArticleDate(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return ARTICLE_DATE.format(value);
}

/**
 * MDX reduced to something countable.
 *
 * APPROXIMATE ON PURPOSE, and only ever used to produce a reading time. Fenced code is dropped (a
 * reader skims a listing rather than reading it aloud), then JSX/HTML tags, then the punctuation that
 * carries markdown structure. What is left is close enough that the number is right to the minute,
 * which is the only precision the label claims.
 */
function mdxToPlainText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_>#|~\-[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How long this article takes to read, in whole minutes — or null when there is nothing to measure.
 *
 * The stored column wins when it holds a real number, because the studio computed it from the body at
 * write time with this same `readingMinutes()` and reading it back is free. Otherwise the body is
 * measured here.
 *
 * ⚠ NULL, NOT 1, FOR AN EMPTY BODY. `readingMinutes("")` floors at 1 (lib/utils.ts, deliberately — "0
 * min read" reads as a bug), so an article with no body yet would claim a minute of reading. A missing
 * reading time renders as nothing at all, which is the truth.
 */
export function articleReadingMinutes(post: {
  readingMinutes?: number | null;
  body?: unknown;
  mdx?: string | null;
}): number | null {
  if (typeof post.readingMinutes === "number" && post.readingMinutes > 0) return post.readingMinutes;

  const mdx = typeof post.mdx === "string" ? post.mdx.trim() : "";
  const text = mdx.length > 0 ? mdxToPlainText(mdx) : richTextToPlainText(parseRichText(post.body));
  if (text.trim().length === 0) return null;
  return readingMinutes(text);
}

export interface ArticleAuthor {
  name: string;
  /** Their role as the studio records it — "Research Fellow". Rendered under the name. */
  title?: string | null;
  /** A public profile path. Null or omitted renders plain text — see the file header. */
  href?: string | null;
  photo?: MediaLike | null;
}

export interface ArticleMetaProps {
  author?: ArticleAuthor | null;
  publishedAt?: Date | null;
  /** Rendered as a second line only when it is a different DAY from the publication date. */
  updatedAt?: Date | null;
  minutes?: number | null;
  category?: { slug: string; name: string } | null;
  /** Anything else that belongs on the row — a mode badge, a series name. */
  children?: ReactNode;
  className?: string;
}

/**
 * The byline row under an article's title: the author with their portrait, the date, the reading time
 * and the category.
 *
 * THE PORTRAIT IS DECORATIVE HERE — `alt=""`. The author's name is spelled out immediately beside it,
 * and "photograph of Anita Rao, Anita Rao" is one announcement too many. `alt=""` is meaningful HTML:
 * it tells a screen reader to skip the image rather than read its filename.
 *
 * The facts after the author are a plain wrapping row rather than a `<dl>`: they are read as a
 * sentence, and a definition list would announce four terms before any of their values.
 */
export function ArticleMeta({
  author,
  publishedAt,
  updatedAt,
  minutes,
  category,
  children,
  className
}: ArticleMetaProps) {
  const published = formatArticleDate(publishedAt);
  const updated = formatArticleDate(updatedAt);
  // Only worth saying when it is a different day. "Updated" on the day of publication describes the
  // editing that produced the piece, not a revision a returning reader should know about.
  const showUpdated = updated !== null && updated !== published;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-5 gap-y-4", className)}>
      {author ? (
        <div className="flex items-center gap-3">
          {author.photo ? (
            <MediaImage
              media={author.photo}
              alt=""
              aspect={1}
              rounded="full"
              sizes="48px"
              targetWidth={320}
              className="h-11 w-11 shrink-0 border border-line-200"
            />
          ) : null}

          <div className="min-w-0">
            <p className="text-sm font-medium leading-snug text-ink-900">
              {author.href ? (
                <Link
                  href={author.href}
                  className="rounded transition-colors hover:text-purple-700"
                >
                  {author.name}
                </Link>
              ) : (
                author.name
              )}
            </p>
            {author.title ? (
              <p className="mt-0.5 text-xs leading-snug text-ink-500">{author.title}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-500">
        {published && publishedAt ? (
          // A machine-readable date beside the human one, so a reader's tooling and a search engine
          // read the same day the page shows.
          <time dateTime={publishedAt.toISOString()}>{published}</time>
        ) : null}

        {showUpdated && updatedAt ? (
          <span>
            Updated <time dateTime={updatedAt.toISOString()}>{updated}</time>
          </span>
        ) : null}

        {typeof minutes === "number" ? (
          <span className="inline-flex items-center gap-1.5">
            <Clock aria-hidden="true" className="h-3.5 w-3.5" />
            {minutes} min read
          </span>
        ) : null}

        {category ? (
          <Link
            href={`/news/category/${category.slug}`}
            className="rounded font-medium text-purple-700 transition-colors hover:text-purple-800"
          >
            {category.name}
          </Link>
        ) : null}

        {children}
      </div>
    </div>
  );
}

export type ArticleCardVariant = "lead" | "grid" | "compact";

export interface ArticleCardProps {
  post: ArticleCardPost;
  /**
   * The page's one batched read from `articleCardAssets` — the covers plus every alternate a framing
   * names. Omitted, the cover draws exactly as it did before per-screen framing existed.
   */
  assets?: Record<string, MediaLike | undefined>;
  /** `lead` is the wide opening card; `grid` the standard one; `compact` a thumbnail row. */
  variant?: ArticleCardVariant;
  /** Default 3 — a card under a section's `<h2>`. Levels never skip (contract §11). */
  headingLevel?: 2 | 3 | 4;
  /** Only for a card above the fold. More than one or two per page and none of them is a priority. */
  priority?: boolean;
}

/** How much of the excerpt each shape can carry before it stops being a summary. */
const EXCERPT_CHARS: Record<ArticleCardVariant, number> = {
  lead: 260,
  grid: 170,
  compact: 0
};

/**
 * One article, as a card.
 *
 * Truncation happens HERE, on the server, with `truncateWords` — never with a CSS line clamp, which
 * hides text from sighted readers while leaving all of it in the accessibility tree, so the two
 * disagree about what the card says (components/site/EntityCard.tsx).
 */
export function ArticleCard({
  post,
  assets,
  variant = "grid",
  headingLevel = 3,
  priority = false
}: ArticleCardProps) {
  const date = articlePublishedOn(post);
  const formatted = formatArticleDate(date);
  const minutes = articleReadingMinutes(post);

  const limit = EXCERPT_CHARS[variant];
  const summary = post.excerpt?.trim();
  const description =
    limit > 0
      ? summary
        ? truncateWords(summary, limit)
        : (post.subtitle?.trim() ?? undefined)
      : undefined;

  // A single band when nobody has framed this cover, which `MediaImage` ignores — so an unframed card is
  // the markup it always was.
  const picture = pictureFromMap(post.coverId, articleCoverFraming(post), assets);

  return (
    <EntityCard
      href={`/news/${post.slug}`}
      media={post.cover}
      picture={picture}
      variant={variant === "compact" ? "compact" : "cover"}
      aspect={variant === "lead" ? "16 / 9" : undefined}
      sizes={
        variant === "lead"
          ? "(min-width: 1024px) 62rem, 100vw"
          : undefined
      }
      priority={priority}
      headingLevel={headingLevel}
      eyebrow={post.category?.name ?? undefined}
      title={post.title}
      description={description}
      meta={
        <>
          {formatted && date ? <time dateTime={date.toISOString()}>{formatted}</time> : null}
          {minutes !== null ? <span>{minutes} min read</span> : null}
        </>
      }
    />
  );
}
