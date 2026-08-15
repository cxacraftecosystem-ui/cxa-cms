/**
 * RelatedContent — the block at the foot of a detail page that says what this record connects to.
 *
 * The archive is a graph, and every detail page is one node of it. Without this block a reader who has
 * finished a craft, a project or a research area has nowhere to go but the Back button, and a site that
 * holds several thousand connected records reads as a pile of unlinked ones.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT RENDERS NOTHING WHEN THERE IS NOTHING, AND IT SAYS NOTHING WHILE IT DOES SO.
 *
 * `CardGrid` draws an `EmptyState` for an empty list, and that is right for a page's PRIMARY listing —
 * "no projects yet" is the answer to the question the reader arrived with. It is wrong here. Nobody
 * reaches the foot of a craft page in order to ask what else resembles it, so a heading reading
 * "Related crafts" over the words "nothing yet" is a worse ending than no heading at all. The empty
 * case therefore returns `null` BEFORE the grid is reached, which also makes it impossible for the
 * truncation sentence to be printed on its own with no list above it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE CALLER CAPS THE LIST, AND THE CALLER OWNS `more`. This component is presentational and cannot
 * know whether six items are all there are or the first six of ninety — so it never guesses. Each page
 * takes one row MORE than its cap, slices, and passes `more` when that extra row came back. That is
 * what turns "the list stopped" into a stated fact with a way onward (contract §1.6), and it is the
 * whole reason the cap is not a prop: a component that sliced the array itself would be the one thing
 * on the page that knew about the truncation and could not say so.
 *
 * ⚠ IT OWNS NO LAYOUT — no `.shell`, no vertical rhythm. The pages that use it sit their related block
 * in different frames: inside a page's existing shell on the craft record, as a top-level section on
 * the project and research pages. A component carrying its own `.shell` would double the gutter on the
 * first of those, which is a bug you only see at one breakpoint.
 *
 * `EntityCard` in its `text` variant draws the cards, so the link overlay, the hover lift and the focus
 * outline are the ones every other card on the site has — read its header before changing anything
 * about how the card is linked. `Reveal` and `CardGrid`'s stagger are the standard entrance and the
 * only client code here; this file is otherwise a Server Component and ships no JavaScript of its own.
 */

import type { ReactNode } from "react";
import Link from "next/link";

import { Reveal } from "@/components/motion/Reveal";
import { CardGrid, type CardGridColumns } from "@/components/site/CardGrid";
import { EntityCard, type EntityCardHeadingLevel } from "@/components/site/EntityCard";
import { SectionHeading, type SectionHeadingLink } from "@/components/site/SectionHeading";

/** Levels 2 and 3 only: a related block is a section of a page, never the page's `<h1>`, and nothing
 *  on this site nests one deeper than a section inside a section. */
export type RelatedContentLevel = 2 | 3;

export interface RelatedItem {
  /**
   * Where the card goes — and its React key. One record cannot legitimately appear twice in a related
   * list, so the destination identifies the card; a duplicate href would also collide inside
   * `EntityCard`, which derives its `aria-labelledby` id from the same string.
   */
  href: string;
  /**
   * The card's heading. Plain text nearly always, but a `ReactNode` because a craft's local name has to
   * arrive with its `lang` attribute attached — read with an English voice, Devanagari produces sounds
   * that are not the name of anything.
   */
  title: ReactNode;
  /**
   * What the reader is about to open: "Craft", "Project", "Publication". It is the record's KIND and
   * not the relationship — why these records are related is one sentence in `description`, said once,
   * rather than the same phrase repeated on every card.
   */
  kind: string;
  /**
   * Two or three lines. ⚠ Truncate it on the SERVER with `truncateWords`: a CSS line clamp hides the
   * tail from sighted readers while leaving it in the accessibility tree, so the two disagree about
   * what the page says.
   */
  summary?: string | null;
}

/**
 * The sentence printed under a list that was capped, and the way to the rest of it.
 *
 * `note` states the fact ("More than these six crafts are connected to this one.") and `label` names
 * the destination — "Every craft recorded in Kutch", never "See more". A link whose text does not say
 * where it goes is useless read out of context, which is how a screen reader's link list reads it.
 */
export interface RelatedMore {
  note: string;
  href: string;
  label: string;
}

export interface RelatedContentProps {
  /** "Related crafts", "Related work". A noun phrase — the reader is scanning, not reading. */
  heading: string;
  /** Why these records are here. Say how the list was worked out; a derived list that presents itself
   *  as a curated one is a claim the archive never made. */
  description?: string;
  /** Already capped and already excluding the record this page is about. */
  items: readonly RelatedItem[];
  /** The permanent way to the full listing, beside the heading. Shown whether or not the list was
   *  capped — unlike `more`, which is the statement that it WAS. */
  link?: SectionHeadingLink;
  /** Passed only when the caller's query proved there are more. See the header. */
  more?: RelatedMore;
  level?: RelatedContentLevel;
  columns?: CardGridColumns;
  /** The frame the block sits in — `.shell`, spacing, margins. This component supplies none. */
  className?: string;
}

/**
 * The cards sit one level under the block's own heading, and heading levels never skip (contract §11).
 * A lookup rather than `level + 1`, so the result is a checked `EntityCardHeadingLevel` instead of an
 * arithmetic `number` that has to be cast back into the union.
 */
const CARD_LEVEL: Record<RelatedContentLevel, EntityCardHeadingLevel> = { 2: 3, 3: 4 };

export function RelatedContent({
  heading,
  description,
  items,
  link,
  more,
  level = 2,
  columns = 3,
  className
}: RelatedContentProps) {
  // Before anything else, and deliberately before `CardGrid` can offer an empty state. See the header.
  if (items.length === 0) return null;

  return (
    <section className={className}>
      <Reveal>
        <SectionHeading
          level={level}
          title={heading}
          description={description}
          link={link}
          className="mb-10"
        />
      </Reveal>

      <CardGrid columns={columns} stagger>
        {items.map((item) => (
          <EntityCard
            key={item.href}
            href={item.href}
            variant="text"
            eyebrow={item.kind}
            headingLevel={CARD_LEVEL[level]}
            title={item.title}
            description={item.summary ?? undefined}
          />
        ))}
      </CardGrid>

      {more ? (
        <p className="mt-8 text-sm text-ink-500">
          {more.note}{" "}
          <Link href={more.href} className="font-medium text-purple-700 hover:text-purple-800">
            {more.label}
          </Link>
          .
        </p>
      ) : null}
    </section>
  );
}
