/**
 * LinkGridSection — a grid of resource links: guidelines, past papers, funding calls.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A NEW TAB IS ANNOUNCED, NOT SPRUNG.
 *
 * An external card gets `target="_blank"`, `rel="noopener noreferrer"` and a visually-hidden "(opens in
 * a new tab)". The spoken half is not politeness: a reader whose focus lands in a new tab with no
 * warning has lost their place in the document AND their Back button, and for somebody navigating by
 * keyboard or by screen reader that is a dead end rather than an inconvenience. The `rel` pair is the
 * other half — `noopener` is what stops the opened page reaching back into this one through
 * `window.opener`.
 *
 * It is the EDITOR's choice, taken from the payload, and deliberately not inferred from the address.
 * Some absolute links belong in the same tab (a partner page a reader is meant to move on to) and some
 * internal ones are a download they will come straight back from, so guessing from the URL gets both
 * cases wrong. The static arrow points up-and-out on an external card, so the choice is visible as well
 * as spoken — colour and hover are never the only signal (contract §1.4, §11).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NOT A SHOWCASE BLOCK, on purpose. These point at things that live outside the CMS at least as often
 * as inside it — a ministry circular, a partner university's page — so there is no table to curate from
 * and the links themselves are the payload.
 *
 * THE ICONS COME FROM `FeatureGridSection`'s MAP, imported rather than rebuilt. That map is explicit
 * (`import * as Icons` plus a dynamic index would put all fourteen hundred lucide glyphs into the
 * bundle of every page carrying one), it already handles a name lucide has since renamed, and a second
 * map here would be a second list for the studio's icon picker to fall out of step with. A card with no
 * icon chosen simply has none — inventing a fallback glyph would put a meaningless picture on the card,
 * where `FeatureGridSection` can justify one because its cards are built around the icon.
 *
 * A Server Component. `Reveal` is the only client piece.
 */

import Link from "next/link";
import type { PageSection } from "@prisma/client";
import { ArrowRight, ArrowUpRight } from "lucide-react";

import { STAGGER } from "@/components/motion/constants";
import { Reveal } from "@/components/motion/Reveal";
import { featureIcon } from "@/components/sections/FeatureGridSection";
import { SectionHeading } from "@/components/site/SectionHeading";
import { sectionLabel } from "@/lib/sections/registry";
import type { LinkGridItem, LinkGridSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

/** Complete literal class strings — a `grid-cols-${n}` assembled from data is purged (contract §5). */
const COLUMN_CLASS: Record<LinkGridSectionData["columns"], string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
};

/** The entrance delay stops growing here; twenty-four cards at a full stagger arrive a second apart. */
const MAX_STAGGER_STEPS = 8;

/** `/path`, `#anchor` and `?query` are ours; anything else is another origin, a mailto or a tel. */
function isInternalHref(href: string): boolean {
  return href.startsWith("/") || href.startsWith("#") || href.startsWith("?");
}

/** Is there anything in this card, or is it a row an editor added and has not filled in? */
function isFilledIn(item: LinkGridItem): boolean {
  return item.label.length > 0 || item.description.length > 0 || item.href.length > 0;
}

export interface LinkGridSectionProps {
  data: LinkGridSectionData;
  section: PageSection;
}

export function LinkGridSection({ data, section }: LinkGridSectionProps) {
  const items = data.items.filter(isFilledIn);
  // Consistent with `FeatureGridSection`: a content block with nothing in it renders nothing. A freshly
  // added block is seeded with three cards, so an empty one is an editor saying "not this block".
  if (items.length === 0) return null;

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  /** Is any of the header visible? Only then does it take space above the cards. */
  const showsHeader = Boolean(heading || eyebrow || body);

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {/*
          ALWAYS RENDERED, even when an editor has cleared the words: a band of links with no heading in
          the document outline is a band a screen-reader user cannot find or skip. The fallback is the
          block's own name from `SECTION_REGISTRY`, so the wording comes from one place. The margin is
          gated on there being something to see, so a header that exists only for the outline does not
          leave 40px of empty space above the first card.
        */}
        <SectionHeading
          eyebrow={eyebrow || undefined}
          title={heading || sectionLabel(section.type)}
          titleClassName={heading ? undefined : "sr-only"}
          description={body || undefined}
          className={showsHeader ? "mb-10" : undefined}
        />

        <ul role="list" className={cn("grid list-none gap-4", COLUMN_CLASS[data.columns])}>
          {items.map((item, index) => (
            <Reveal
              as="li"
              key={`${index}-${item.label}-${item.href}`}
              delay={Math.min(index, MAX_STAGGER_STEPS) * STAGGER.cards}
              className="h-full"
            >
              <LinkCard item={item} />
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * One card.
 *
 * The card's TEXT is its accessible name, deliberately — no `aria-label`. An `aria-label` on an anchor
 * REPLACES its content for a screen reader, so labelling it with the card's title would throw away the
 * description underneath, which is the line that says whether the link is worth following. The cost is
 * that the name is a little long; the alternative is that half the card is inaudible.
 *
 * A card with no address renders as a plain box rather than as a link. It is not hidden: an unfinished
 * card that is visibly unfinished is how the editor discovers it, whereas one that is quietly dropped
 * looks to everybody like a list that was always this length (contract §1.6). It is not a dead link
 * either — a control that looks pressable and does nothing is worse than no control (§1.8).
 */
function LinkCard({ item }: { item: LinkGridItem }) {
  const label = item.label.trim();
  const description = item.description.trim();
  const href = item.href.trim();
  const Icon = item.icon ? featureIcon(item.icon) : null;
  const Arrow = item.external ? ArrowUpRight : ArrowRight;

  // `pr-12` only where the arrow is drawn: on a card with no address the extra right padding would be an
  // unexplained notch of empty space.
  const frame = cn(
    "relative flex h-full flex-col rounded-lg border border-line-200 bg-card p-5 shadow-sm transition",
    href && "pr-12"
  );

  const body = (
    <>
      {/* The static affordance. Up-and-out for a card that leaves the site, straight for one that does
          not — a difference a reader can see without hovering anything. */}
      {href ? (
        <Arrow
          aria-hidden="true"
          className="absolute right-4 top-5 h-4 w-4 text-ink-300 transition-colors group-hover:text-purple-700"
        />
      ) : null}

      {Icon ? (
        <span
          aria-hidden="true"
          className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-md bg-surface-100 text-purple-600"
        >
          <Icon className="h-5 w-5" />
        </span>
      ) : null}

      {label ? (
        <span className="display-title block text-balance text-base leading-snug transition-colors group-hover:text-purple-700">
          {label}
        </span>
      ) : null}

      {description ? (
        <span className={cn("block text-sm leading-relaxed text-ink-500", label && "mt-1.5")}>
          {description}
        </span>
      ) : null}

      {item.external && href ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </>
  );

  if (!href) {
    return (
      <div className={cn(frame, "border-dashed")}>
        {body}
        {/* Said on screen rather than logged: the person who can fix it is the one looking at the page. */}
        <span className="mt-3 block text-xs text-ink-500">This link has no address yet.</span>
      </div>
    );
  }

  const newTabProps = item.external
    ? ({ target: "_blank", rel: "noopener noreferrer" } as const)
    : {};

  // Two concrete branches rather than one element chosen into a variable: `next/link` on an internal
  // path (client routing, prefetch) and a plain `<a>` on anything else, because routing an absolute URL
  // or a `mailto:` through the client router adds prefetch machinery and a surprise.
  if (isInternalHref(href)) {
    return (
      <Link href={href} className={cn("group", frame, "hover:border-purple-300 hover:shadow-md")} {...newTabProps}>
        {body}
      </Link>
    );
  }

  return (
    <a href={href} className={cn("group", frame, "hover:border-purple-300 hover:shadow-md")} {...newTabProps}>
      {body}
    </a>
  );
}
