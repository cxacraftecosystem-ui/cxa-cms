/**
 * The social card for one article.
 *
 * The newsroom is the page most often shared and the one where a generic card costs most: a headline is
 * the whole reason somebody clicks. This card carries the headline, the standfirst and the category.
 * The design lives in `lib/og/card.tsx`; this file is the query and the three choices below.
 *
 * ⚠ `livePublishableWhere()`, NOT `liveStatusWhere()`. `Post` is the scheduled model — it has
 * `publishAt` and `unpublishAt` — so this is the one card of the five whose filter compares against the
 * clock. A crawler that asks for the card of an embargoed piece, or one whose `unpublishAt` has passed,
 * must get the institutional card and not its headline: the filter is what enforces the embargo (see
 * lib/content.ts), and a card is a public surface with no HTML for `npm run leak-check` to grep.
 *
 * ⚠ IT IS CALLED FRESH ON EVERY REQUEST, never hoisted to a module constant. `livePublishableWhere()`
 * closes over `new Date()`; frozen at module scope it would filter every card against the instant the
 * server booted — the same trap `page.tsx` documents above `postSelect`.
 *
 * THE HEADLINE FOLLOWS THE PAGE'S OWN PRECEDENCE — `seoTitle` over `title`, `seoDescription` over the
 * excerpt over the subtitle — so a card and the `<title>` beside it in the same preview cannot disagree
 * about what the piece is called.
 *
 * THE BODY IS NOT READ, and that is the one place this card is deliberately poorer than the page's
 * metadata. `generateMetadata` falls back to `richTextExcerpt(parseRichText(post.body))` when all three
 * text fields are empty; parsing a whole Tiptap document per crawler request, for a subtitle that is
 * optional on the card, is not worth the column. A piece with no excerpt gets a headline and a
 * category, which is still the piece.
 *
 * `seoNoIndex` IS NOT CONSULTED. It asks search engines not to index the page; it does not make the
 * page private, and the reader who pasted the link is entitled to a preview of what they linked to.
 */

import { ImageResponse } from "next/og";

import { livePublishableWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { siteName } from "@/lib/env";
import { OG_CONTENT_TYPE, OG_SIZE, fallbackCard, loadCardRecord, recordCard } from "@/lib/og/card";

/**
 * Five minutes, the same window as the page beside it (and re-exported into the generated route by
 * Next's metadata loader, exactly as `runtime` is). It caps two things at once: how much of a busy
 * channel's preview traffic reaches the database, and how long a card can outlive the record it names.
 */
export const revalidate = 300;

export const runtime = "nodejs";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt =
  "A Centre of Excellence share card naming one article, its opening line and its category.";

/**
 * ⚠ `params` ARRIVES ALREADY RESOLVED HERE, unlike a page's — Next's metadata-image route awaits the
 * segment params before calling this handler. Typed as the union and awaited so it is right either way.
 */
interface CardProps {
  params: Promise<{ slug: string }> | { slug: string };
}

export default async function ArticleSocialCard({ params }: CardProps) {
  const { slug } = await params;

  const post = await loadCardRecord("article", () =>
    prisma.post.findFirst({
      // Evaluated here, per request. See the header.
      where: { slug, ...livePublishableWhere() },
      select: {
        title: true,
        subtitle: true,
        excerpt: true,
        seoTitle: true,
        seoDescription: true,
        category: { select: { name: true } }
      }
    })
  );

  return new ImageResponse(
    post
      ? recordCard({
          kind: "Article",
          // The same precedence the page's `<title>` uses.
          title: post.seoTitle?.trim() || post.title,
          subtitle: post.seoDescription?.trim() || post.excerpt?.trim() || post.subtitle,
          // The category, not the date: a date on a card ages the link every time it is reshared, and
          // the section is what tells a reader whether the piece is for them.
          meta: post.category?.name ?? null,
          siteName: siteName()
        })
      : fallbackCard(),
    OG_SIZE
  );
}
