/**
 * NewsShowcaseSection — recent pieces from the newsroom.
 *
 * THREE LAYOUTS, AND THE FEATURE ONE HAS A CONDITION. "Feature" gives the first piece a large card
 * and the rest small ones, which only reads as a hierarchy when there is something to be at the top
 * OF — with one or two items it is a big card and an orphan, so below three the block falls back to
 * the even grid. That is a presentation fallback, not a truncation: every row is still shown, so
 * there is nothing to declare on screen (contract §1.6 covers rows that disappear, not rows that
 * change shape).
 *
 * DATES ARE FORMATTED ON THE SERVER, in one zone, for every reader. These pages are prerendered, so
 * there is no hydration mismatch to guard against — and a publication date that read differently by
 * the reader's own zone would make the same article look a day older in Delhi than in London.
 *
 * A Server Component. The row lists (feature's side column and the "list" layout) enter and react
 * through `AnimatedList` — a client leaf that takes the server-rendered rows as children, exactly
 * as `Reveal` is used — so the hovered row lifts while its siblings recede as one group.
 */

import Link from "next/link";
import type { PageSection } from "@prisma/client";
import { ArrowRight, Newspaper } from "lucide-react";

import { AnimatedList, AnimatedListItem } from "@/components/motion/AnimatedList";
import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { CardGrid } from "@/components/site/CardGrid";
import { EntityCard } from "@/components/site/EntityCard";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { pickShowcase, type PostRow, type ResolvedSectionData } from "@/lib/sections/resolve";
import type { NewsShowcaseSectionData } from "@/lib/sections/schema";
import { truncateWords } from "@/lib/utils";

export interface NewsShowcaseSectionProps {
  data: NewsShowcaseSectionData;
  section: PageSection;
  /** The whole batched read from `lib/sections/resolve.ts`; this block's rows are pulled out by id. */
  resolved?: ResolvedSectionData;
  /** The rows directly, for a studio preview or a bespoke page. Wins over `resolved` when given. */
  rows?: PostRow[];
  total?: number;
  droppedIds?: number;
}

/** Below this, "feature" has nothing to be featured against. See the header. */
const FEATURE_MINIMUM = 3;

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});

/**
 * The date a reader should see.
 *
 * `publishedAt` is stamped when a piece goes live; a SCHEDULED piece that has passed its `publishAt`
 * is already public but may not have been stamped yet, because the cron that does it is a convenience
 * rather than the mechanism (lib/content.ts). Falling back to `publishAt` means a piece that went
 * live an hour ago is dated today rather than not dated at all.
 */
function publishedOn(post: PostRow): Date | null {
  return post.publishedAt ?? post.publishAt ?? null;
}

function PostMeta({ post }: { post: PostRow }) {
  const date = publishedOn(post);
  return (
    <>
      {date ? (
        // A machine-readable date beside the human one, so a reader's tooling and a search engine
        // read the same day the page shows.
        <time dateTime={date.toISOString()}>{DATE_FORMAT.format(date)}</time>
      ) : null}
      {post.readingMinutes ? <span>{post.readingMinutes} min read</span> : null}
    </>
  );
}

export function NewsShowcaseSection({
  data,
  section,
  resolved,
  rows: given,
  total: givenTotal,
  droppedIds: givenDropped
}: NewsShowcaseSectionProps) {
  const { rows, total: matched, droppedIds } = pickShowcase(resolved?.news, section.id, {
    rows: given,
    total: givenTotal,
    droppedIds: givenDropped
  });

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const label = data.ctaLabel.trim();
  const href = data.ctaHref.trim();
  const link = label && href ? { href, label } : undefined;
  const showsHeader = Boolean(heading || eyebrow || body || link);
  const hidden = Math.max(0, matched - rows.length);

  const lead = rows[0];
  const featured = data.layout === "feature" && rows.length >= FEATURE_MINIMUM && lead !== undefined;
  const rest = featured ? rows.slice(1) : rows;

  const empty = {
    icon: Newspaper,
    title: "No news to show yet",
    description: "Pieces appear here as soon as they are published in the studio.",
    headingLevel: 3 as const
  };

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <SectionHeading
            eyebrow={eyebrow || undefined}
            title={heading || "News"}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            // ⚠ Withheld when the heading is off screen: `SectionHeading` gates its trailing link on
            // the link alone, so an `sr-only` title still paints it — and the row below would draw
            // the same call to action a second time. Exactly one of the two ever renders.
            link={heading ? link : undefined}
          />
        </Reveal>

        <div className={showsHeader ? "mt-12" : undefined}>
          {rows.length === 0 ? (
            <EmptyState {...empty} />
          ) : featured && lead ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <Reveal className="h-full">
                <EntityCard
                  href={`/news/${lead.slug}`}
                  media={lead.cover}
                  variant="cover"
                  aspect="16 / 9"
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  eyebrow={lead.category?.name ?? undefined}
                  title={lead.title}
                  description={
                    lead.excerpt?.trim()
                      ? truncateWords(lead.excerpt, 260)
                      : (lead.subtitle ?? undefined)
                  }
                  meta={<PostMeta post={lead} />}
                />
              </Reveal>

              {/* The stagger is AnimatedList's own — a Reveal around each row on top of it would
                  animate the same entrance twice. The lead card is not part of the organism, so it
                  keeps its Reveal above. */}
              <AnimatedList className="grid content-start gap-4">
                {rest.map((post, index) => (
                  <AnimatedListItem key={post.id} index={index}>
                    <EntityCard
                      href={`/news/${post.slug}`}
                      media={post.cover}
                      variant="compact"
                      eyebrow={post.category?.name ?? undefined}
                      title={post.title}
                      meta={<PostMeta post={post} />}
                    />
                  </AnimatedListItem>
                ))}
              </AnimatedList>
            </div>
          ) : data.layout === "list" ? (
            <AnimatedList className="divide-y divide-line-200 border-t border-line-200">
              {rows.map((post, index) => (
                <AnimatedListItem key={post.id} index={index} className="py-5">
                  <h3 className="display-title text-balance text-lg leading-snug">
                    <Link
                      href={`/news/${post.slug}`}
                      className="transition-colors hover:text-purple-700"
                    >
                      {post.title}
                    </Link>
                  </h3>
                  {post.excerpt?.trim() ? (
                    <p className="prose-measure mt-1.5 text-sm leading-relaxed text-ink-500">
                      {truncateWords(post.excerpt, 200)}
                    </p>
                  ) : null}
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                    <PostMeta post={post} />
                  </p>
                </AnimatedListItem>
              ))}
            </AnimatedList>
          ) : (
            <CardGrid columns={3} stagger empty={empty}>
              {rows.map((post) => (
                <EntityCard
                  key={post.id}
                  href={`/news/${post.slug}`}
                  media={post.cover}
                  variant="cover"
                  eyebrow={post.category?.name ?? undefined}
                  title={post.title}
                  description={post.excerpt?.trim() ? truncateWords(post.excerpt, 180) : undefined}
                  meta={<PostMeta post={post} />}
                />
              ))}
            </CardGrid>
          )}
        </div>

        <ShowcaseNote hidden={hidden} matched={matched} dropped={droppedIds} link={link} />

        {/* The CTA's one copy when the heading is off screen — see the note beside `SectionHeading`. */}
        {!heading && link ? (
          <div className="mt-10">
            <LinkButton href={link.href} variant="secondary" icon={ArrowRight} iconPosition="end">
              {link.label}
            </LinkButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** The honest footnote — contract §1.6. */
function ShowcaseNote({
  hidden,
  matched,
  dropped,
  link
}: {
  hidden: number;
  matched: number;
  dropped: number;
  link?: { href: string; label: string };
}) {
  if (hidden === 0 && dropped === 0) return null;

  return (
    <p className="mt-8 text-sm text-ink-500">
      {hidden > 0 ? (
        <>
          Showing {matched - hidden} of {matched} news items.{" "}
          {link ? (
            <Link href={link.href} className="font-medium text-purple-700 hover:text-purple-800">
              {link.label}
            </Link>
          ) : null}
        </>
      ) : null}
      {dropped > 0 ? (
        <>
          {hidden > 0 ? " " : null}
          {dropped} chosen {dropped === 1 ? "item is" : "items are"} no longer published and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
