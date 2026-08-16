/**
 * HorizontalRailSection — a line of cards the reader travels along sideways.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT IS A REAL, NATIVELY SCROLLABLE RAIL FIRST, AND A PINNED EFFECT SECOND.
 *
 * This is a SERVER COMPONENT: every card, every photograph and every word arrives in the HTML, is
 * indexed, and is readable with JavaScript switched off. What it renders is an ordinary
 * `overflow-x: auto` strip with CSS scroll-snap — a thing a reader can drag with a thumb, flick with
 * a trackpad, drag by its scrollbar, or step through from the keyboard. `RailStage` is a client
 * wrapper around it that owns no content and adds one optional enhancement: on a wide screen, when
 * the editor has asked for it, the section pins and the track travels sideways as the page scrolls.
 *
 * The order is the point, and the schema's header says why: a rail built as a pinned GSAP effect
 * with a fallback bolted on afterwards is a carousel that cannot be scrolled on the one device where
 * sideways scrolling is natural, and its fallback is the half nobody ever looks at.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ THE SCROLLER IS A NAMED, FOCUSABLE REGION AND THAT IS NOT DECORATION. A box that scrolls only in
 * response to a pointer gesture is content a keyboard reader cannot reach at all: without
 * `tabIndex`, the arrow keys never get a chance to act on it, and everything past the second card is
 * unreachable for them. `role="region"` plus a name is what stops it being an anonymous landmark
 * once it is a tab stop (contract §11).
 *
 * ⚠ WHY THE WHOLE CARD IS A LINK BY `::after` OVERLAY RATHER THAN BY ONE `<a>` WRAPPING IT. A card
 * whose picture comes from the bundled craft manifest ALWAYS renders `ImageCredit` beneath it, and
 * that credit contains two external anchors — it is a licence obligation, not a caption, so it
 * cannot be dropped. An `<a>` around the whole card would therefore nest anchors: invalid HTML that
 * the parser silently unpicks, and a credit whose links vanish from the accessibility tree. So the
 * link is on the title, where it gets a real accessible name from real text, and its `::after`
 * stretches over the card to make the rest of it clickable. The credit's own links are lifted back
 * above that overlay by hand — see `CREDIT_ABOVE_OVERLAY` — because a licence link a reader can see
 * and cannot click is the same failure as no credit at all.
 *
 * ⚠ NO `.mask-edges-x` HERE, unlike the other rails on the site. The fade is a `mask-image` on the
 * scrolling box, and a mask applies to everything the element paints — including its focus ring,
 * whose left and right strokes sit exactly in the transparent 6% at each end. On a rail that is a
 * tab stop, an edge fade would quietly erase the one thing telling a keyboard reader where they are.
 */

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { PageSection } from "@prisma/client";

import { Reveal } from "@/components/motion/Reveal";
import { RailStage } from "@/components/sections/story/RailStage";
import { StoryPicture } from "@/components/sections/story/StoryPicture";
import { ArcCarousel, type ArcCarouselItem } from "@/components/site/ArcCarousel";
import { SectionHeading } from "@/components/site/SectionHeading";
import { hashUnit } from "@/components/craft/motifs";
import { craftImage, type CraftImage } from "@/lib/media/craft-imagery";
import { CRAFT_CATEGORY_SHEETS, craftSheet, type CraftSheet } from "@/lib/media/craft-sheets";
import { mediaAlt, mediaSrc } from "@/lib/media/url";
import { sectionLabel } from "@/lib/sections/registry";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { HorizontalRailItem, HorizontalRailSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface HorizontalRailSectionProps {
  data: HorizontalRailSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. */
  resolved?: ResolvedSectionData;
}

/**
 * Complete literal class strings, and a `sizes` hint that matches each of them.
 *
 * ⚠ A `w-${size}` assembled from the payload is purged by the content scanner (contract §5), so the
 * widths are written out in full. The two rungs per card are the phone width and the width from `sm`
 * up, where a card can afford to be the size the editor actually chose: "large shows about two at a
 * time, small about four", which is the sentence the studio's help text promises.
 */
const CARD_WIDTH: Record<HorizontalRailSectionData["cardWidth"], { frame: string; sizes: string }> = {
  sm: { frame: "w-60 sm:w-72", sizes: "(min-width: 640px) 18rem, 15rem" },
  md: { frame: "w-72 sm:w-[22rem]", sizes: "(min-width: 640px) 22rem, 18rem" },
  lg: { frame: "w-80 sm:w-[30rem]", sizes: "(min-width: 640px) 30rem, 20rem" }
};

/**
 * Lifts the craft credit's links above the card-wide `::after` overlay.
 *
 * The overlay is a positioned pseudo-element and the credit's anchors are ordinary inline text, so
 * the overlay paints on top of them and eats their clicks. Giving those anchors a position and a
 * rung puts them back on top — and only them, so the photograph itself stays under the overlay and
 * clicking the picture still follows the card. See the header for why this is not solved by using
 * one `<a>` around everything.
 */
const CREDIT_ABOVE_OVERLAY = "[&_figcaption_a]:relative [&_figcaption_a]:z-10";

/**
 * Is there anything in this card, or is it a row an editor added and has not filled in?
 *
 * An empty card in a rail is worse than an empty card in a grid: it is a blank 22rem panel the
 * reader has to travel past to reach the next real one.
 */
function isFilledIn(item: HorizontalRailItem): boolean {
  return (
    item.title.length > 0 ||
    item.detail.length > 0 ||
    item.meta.length > 0 ||
    item.mediaId.length > 0 ||
    item.craftImage.length > 0 ||
    item.href.length > 0
  );
}

/**
 * `/path`, `#anchor` and `?query` are ours; anything else is another origin, a `mailto:` or a `tel:`.
 *
 * The same test `LinkGridSection` makes, and kept local rather than shared for now: it is one line of
 * string matching, and the moment a third block needs it the honest move is to lift it into
 * `lib/utils.ts` rather than to have two blocks importing each other.
 */
function isInternalHref(href: string): boolean {
  return href.startsWith("/") || href.startsWith("#") || href.startsWith("?");
}

/**
 * The cards again, flattened for the arc: finished `src` strings and nothing to resolve, so the
 * carousel stays a dumb client leaf and the media precedence stays server-side — an UPLOADED ASSET
 * ALWAYS WINS over a manifest slug, exactly `StoryPicture`'s rule, because an arc that decided
 * differently would show a different photograph than the rail for the same row.
 *
 * ⚠ THE CREDITS ARE THE PRICE OF THE FLATTENING AND THEY ARE NOT OPTIONAL. A manifest photograph
 * normally travels through `CraftPhoto`, which renders `ImageCredit` under it unconditionally —
 * that is what makes publishing a CC BY picture lawful. The arc draws its pictures without
 * `CraftPhoto`, so the obligation is discharged here instead: every DISTINCT manifest photograph
 * the fan shows comes back in `credits`, and the caller renders the lot directly beneath the
 * stage. Deduplicated because the licence asks for attribution, not for one line per appearance.
 */
/**
 * A Centre category plate for a row that named no picture of its own.
 *
 * ⚠ KEYED ON THE TITLE, NOT THE HREF, AND THE FIRST VERSION OF THIS HAD IT THE OTHER WAY ROUND.
 * A rail's rows very often share a destination — the landing page's own fan points ELEVEN rows at
 * `/craft-explorer` — so hashing the href gave every card in the fan the identical plate, which is
 * exactly what an editor would report as "all the images are the same". The title is the one field
 * that is reliably distinct per row, because it is what tells the two rows apart on screen.
 *
 * `hashUnit`'s channel is named so a second thing derived from the same row later cannot move in
 * step with this one and read as a mistake.
 */
function fallbackSheet(item: HorizontalRailItem): CraftSheet | null {
  const identity = (item.title.trim() || item.href.trim()).toLowerCase();
  if (!identity) return null;
  const index = Math.min(
    CRAFT_CATEGORY_SHEETS.length - 1,
    Math.floor(hashUnit(identity, "arc-plate") * CRAFT_CATEGORY_SHEETS.length)
  );
  return CRAFT_CATEGORY_SHEETS[index] ?? null;
}

function arcCardsOf(
  items: HorizontalRailItem[],
  resolved: ResolvedSectionData | undefined
): { cards: ArcCarouselItem[]; credits: CraftImage[] } {
  const cards: ArcCarouselItem[] = [];
  const credits: CraftImage[] = [];

  for (const item of items) {
    const asset = item.mediaId.trim() ? resolved?.media[item.mediaId.trim()] : undefined;
    const slug = item.craftImage.trim();

    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * THE CENTRE'S OWN PLATES COME FIRST, AND A COMMONS PHOTOGRAPH IS NOW THE LAST RESORT.
     *
     * This row used to resolve `item.craftImage` through `craftImage()` alone, so the fan was eight
     * Wikimedia photographs — on the page that is the Centre's own archive. The order is now:
     *
     *   1. an UPLOADED asset, which still wins over everything (StoryPicture's rule, unchanged);
     *   2. the slug read as a CONTACT SHEET, so an editor can name `metal` or `textile-embroidery`
     *      directly and get the Centre's plate;
     *   3. the slug read as a manifest photograph, for rows authored before the sheets existed;
     *   4. failing all of those, a Centre CATEGORY plate chosen deterministically from the row's own
     *      href-or-title, so the fan is never a hole and never somebody else's picture.
     *
     * ⚠ STEP 4 IS A STABLE HASH, NOT A ROTATION. `hashUnit` keyed on the row's identity means a
     * given card always draws the same plate — between renders, between visits and between server
     * and client. A random or index-based pick would reshuffle the fan on every navigation, which
     * reads as a bug even to somebody who cannot say what changed.
     *
     * ⚠ A SHEET IS A MOSAIC AND THESE CARDS ARE 256px WIDE, which is below the ~380px floor
     * craft-sheets.ts sets for reading one. That is accepted here on purpose: at this size the plate
     * is being used as a TEXTURE — a dense field of craft with the card's own title over it — not as
     * something to read. The full sheet is legible where it is offered as a subject, in the hero's
     * vitrine and the map's hover card.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    const sheet = !asset ? (slug ? craftSheet(slug) : null) ?? fallbackSheet(item) : null;
    const craft = !asset && !sheet && slug ? craftImage(slug) : null;
    if (craft && !credits.some((image) => image.slug === craft.slug)) credits.push(craft);

    cards.push({
      href: item.href.trim(),
      title: item.title.trim(),
      subtitle: item.meta.trim() || undefined,
      // 640 targets the card's real cost: a 256px slot at a 2× screen is a 512px image, and the
      // derivative ladder's next rung up from that is the 640 "sm".
      imageSrc: asset ? mediaSrc(asset, 640) ?? undefined : (sheet?.src ?? craft?.src),
      // The empty string is deliberate where nothing better exists: it marks the picture decorative
      // rather than making a screen reader announce a filename (contract §11). A sheet gets no alt
      // text at all here: the card's own `<h3>` already carries the craft's name, and announcing
      // "a plate of photographs of metal crafts" beside it would read the card twice.
      imageAlt: asset ? mediaAlt(asset) : sheet ? "" : craft ? craft.title : ""
    });
  }

  return { cards, credits };
}

export function HorizontalRailSection({ data, section, resolved }: HorizontalRailSectionProps) {
  const items = data.items.filter(isFilledIn);

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  /** Is any of the header visible? Only then does it take space above the rail. */
  const showsHeader = Boolean(heading || eyebrow || body);

  // With no cards AND no words there is nothing to draw and nothing to say, which is the one case
  // where rendering nothing is honest rather than silent.
  if (items.length === 0 && !showsHeader) return null;

  const width = CARD_WIDTH[data.cardWidth];
  /**
   * What the rail is called, in the outline and out loud.
   *
   * One value for both the heading and the region's `aria-label`, so a rail can never be announced
   * as one thing and headed as another. The fallback is the block's own name from `SECTION_REGISTRY`
   * — an editor who cleared the heading has taken it off screen, not left the landmark anonymous.
   */
  const railName = heading || sectionLabel(section.type);

  /*
    ALWAYS RENDERED, in both drawings. Every card title is an `<h3>`, so a block with no `<h2>` of
    its own takes the page from `<h1>` straight to `<h3>` — a level missing from the outline a
    screen-reader user navigates by (contract §11). Where the editor has cleared it, the fallback
    name is rendered `sr-only`: present in the outline, absent from the page.
  */
  const headingBlock = (
    <SectionHeading
      eyebrow={eyebrow || undefined}
      title={railName}
      titleClassName={heading ? undefined : "sr-only"}
      description={body || undefined}
      className={showsHeader ? "mb-10" : undefined}
    />
  );

  /*
    Said on screen, not left blank, whichever way the line is drawn. An empty strip is
    indistinguishable from a strip whose cards failed to load, and the person who can fix it is the
    one looking at the page (contract §1.6).
  */
  const emptyNotice = (
    <p className="rounded-lg border border-dashed border-line-200 bg-surface-100 p-6 text-center text-sm text-ink-500">
      No cards have been added to this rail yet.
    </p>
  );

  /*
    The arc drawing: the SAME resolved rows, fanned along a curve the reader turns by hand — see the
    schema's `presentation` field. No `RailStage` here on purpose: pinning is the rail's cinema, and
    the arc never takes the page's scroll away; `pin` and `cardWidth` are simply ignored while the
    arc is chosen, so switching back in the studio restores the rail exactly as it was.
  */
  if (data.presentation === "arc") {
    const { cards, credits } = arcCardsOf(items, resolved);

    return (
      <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
        <div className="shell">
          {headingBlock}

          {items.length === 0 ? (
            emptyNotice
          ) : (
            <Reveal>
              <ArcCarousel items={cards} />
              {credits.length > 0 ? (
                // The licence lines for every manifest photograph on the fan — see `arcCardsOf` for
                // why they sit here rather than under each picture.
                <div className="mt-6 space-y-0.5">
              {/* The arc photographs' attribution moved to /credits with the rest of the landing's
                  (owner's direction; CraftPhoto's licence note carries the CC BY reasoning). */}
                </div>
              ) : null}
            </Reveal>
          )}
        </div>
      </section>
    );
  }

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      {/*
        The stage wraps the WHOLE section body, because it is the section that pins — not the rail
        inside it. A pinned sticky child stops moving relative to the viewport and reports almost no
        progress, which is the classic way a scrubbed rail ends up doing all its travelling in the
        last inch of the section.
      */}
      <RailStage pin={data.pin}>
        <div className="shell">
          {headingBlock}

          {items.length === 0 ? (
            emptyNotice
          ) : (
            <Reveal>
              {/*
                THE RAIL ITSELF, and everything about this element is load-bearing:

                • `tabIndex` + `role="region"` + `aria-label` — a scrollable box that is not a tab
                  stop is content a keyboard reader cannot reach, and a tab stop with no name is an
                  unnamed landmark.
                • The inset ring is the focus treatment that survives the bleed. globals.css already
                  outlines any `[tabindex]` in purple-700 at a 2px offset, but this box deliberately
                  runs past the content column to the edge of the screen, so that outline's side
                  strokes sit at (or beyond) the very edge of the viewport. The ring is drawn INSIDE
                  the box instead, where nothing can crop it — and the outline is left in place rather
                  than switched off, because `data-high-contrast` thickens exactly that outline and
                  `outline: none` would leave those readers with the thinner of the two cues.
                • `overscroll-x-contain` — a horizontal overscroll on a trackpad is the browser's
                  "go back" gesture, and losing the page mid-rail is not a scroll, it is a navigation.
                • `scroll-pl-*` matches the padding, so a snapped card lands on the content column
                  rather than flush against the edge of the screen.
              */}
              <div
                data-rail-viewport
                role="region"
                tabIndex={0}
                aria-label={`${railName} — scrollable rail`}
                className={cn(
                  "-mx-5 snap-x snap-mandatory scroll-pl-5 overflow-x-auto overscroll-x-contain px-5 pb-4 sm:-mx-8 sm:scroll-pl-8 sm:px-8",
                  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-700"
                )}
              >
                {/*
                  `<ol>` because the rail is ordered: the cards run left to right in the order the
                  editor put them in, and a screen reader should say "list, 8 items" and then "3 of 8"
                  as the reader moves along it.
                */}
                <ol role="list" data-rail-track className="flex list-none items-stretch gap-5">
                  {items.map((item, index) => (
                    <RailCard
                      // Index-keyed deliberately. These cards carry no identity of their own — there
                      // is no id in the payload — and they are reordered only by an editor rewriting
                      // the array, which re-renders the whole block anyway. A key built from the
                      // title would collide the moment two cards were called the same thing.
                      key={index}
                      item={item}
                      resolved={resolved}
                      width={width}
                    />
                  ))}
                </ol>
              </div>
            </Reveal>
          )}
        </div>
      </RailStage>
    </section>
  );
}

/**
 * One card.
 *
 * The picture is rendered ONLY where the editor asked for one. `StoryPicture` states an absence
 * rather than leaving a hole — which is right when a chosen photograph has gone missing, and wrong
 * as the resting state of a deliberately text-only rail, where it would print "no photograph" eight
 * times across a strip that never wanted any. So the rule is: asked for and missing is stated; never
 * asked for is simply absent.
 */
function RailCard({
  item,
  resolved,
  width
}: {
  item: HorizontalRailItem;
  resolved: ResolvedSectionData | undefined;
  width: { frame: string; sizes: string };
}) {
  const title = item.title.trim();
  const meta = item.meta.trim();
  const detail = item.detail.trim();
  const href = item.href.trim();
  const wantsPicture = item.mediaId.length > 0 || item.craftImage.length > 0;

  /**
   * A link needs words. An `::after` overlay hung on an anchor with no text is a card-sized target
   * whose accessible name is its own URL, so a card with an address and no title stays a plain card
   * and says why — a control that looks pressable and leads somewhere unnameable is worse than none
   * (contract §1.8).
   */
  const linked = Boolean(href && title);

  const heading = title ? (
    <h3 className="display-title text-balance text-base leading-snug">
      {linked ? (
        <CardLink href={href}>
          {title}
          <ArrowRight
            aria-hidden="true"
            className="ml-1.5 inline h-4 w-4 shrink-0 align-[-0.15em] text-ink-300 transition-colors group-hover:text-purple-700"
          />
        </CardLink>
      ) : (
        title
      )}
    </h3>
  ) : null;

  return (
    <li
      data-rail-card
      className={cn(
        // `relative` is what the title link's `::after` overlay measures itself against; without it
        // the overlay would stretch to the nearest positioned ancestor, which is the whole rail.
        "group relative flex shrink-0 snap-start flex-col rounded-lg border border-line-200 bg-card p-4 shadow-sm transition-colors",
        width.frame,
        linked && "hover:border-purple-300"
      )}
    >
      {wantsPicture ? (
        <div className={cn("mb-4", CREDIT_ABOVE_OVERLAY)}>
          <StoryPicture
            mediaId={item.mediaId}
            craftSlug={item.craftImage}
            resolved={resolved}
            // One shape for every card, so the titles below them line up along the rail whatever
            // proportions the photographs arrived in.
            aspect="4 / 3"
            sizes={width.sizes}
            emptyLabel="The photograph chosen for this card is no longer available."
          />
        </div>
      ) : null}

      {heading}

      {meta ? (
        <p
          className={cn(
            "text-xs font-medium uppercase tracking-[0.14em] text-ink-500",
            title && "mt-1.5"
          )}
        >
          {meta}
        </p>
      ) : null}

      {detail ? (
        <p className={cn("text-sm leading-relaxed text-ink-500", (title || meta) && "mt-2.5")}>
          {detail}
        </p>
      ) : null}

      {href && !title ? (
        // Said on screen rather than logged: the person who can fix it is the one looking at the page.
        <p className="mt-2.5 text-xs text-ink-500">
          This card has a link but no title, so it is not shown as one.
        </p>
      ) : null}
    </li>
  );
}

/**
 * The card's one interactive element.
 *
 * `after:absolute after:inset-0` is what turns the whole card into the target: the pseudo-element
 * stretches over the `<li>` above everything except the credit lifted by `CREDIT_ABOVE_OVERLAY`, so
 * a pointer anywhere on the card follows the link while the accessible name stays the title alone.
 *
 * Two concrete branches rather than one element chosen into a variable: `next/link` on an internal
 * path, for client routing and prefetch, and a plain `<a>` on anything else — routing an absolute
 * URL, a `mailto:` or a `tel:` through the client router adds prefetch machinery and a surprise.
 * The target is never inferred from the address: some absolute links belong in the same tab and some
 * internal ones do not, so guessing gets both wrong (`LinkGridSection` carries the long version of
 * this note), and this block's payload has no "open in a new tab" for an editor to choose.
 */
function CardLink({ href, children }: { href: string; children: ReactNode }) {
  const className =
    "transition-colors after:absolute after:inset-0 after:content-[''] group-hover:text-purple-700";

  if (isInternalHref(href)) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }

  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
