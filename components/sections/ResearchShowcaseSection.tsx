/**
 * ResearchShowcaseSection — the Centre's research areas, as cards.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ACCENT COLOUR IS A DATA-ENCODING CHANNEL, AND THIS IS THE ONLY PLACE IT IS ALLOWED.
 *
 * `ResearchArea.accentColor` exists so one area is the same colour in the research graph as it is on
 * this card — that is a legend, not a second brand accent. Contract §1.1 says purple-700 is the only
 * action colour, so the accent here touches exactly two things, both decorative and both
 * `aria-hidden`: the rail across the top of the card, and the dot beside the eyebrow. It never
 * reaches a button, a link, the title, or any text. Colour is never the only carrier of meaning
 * (§11): the area's NAME is what identifies it, every time.
 *
 * A stored value that does not look like a CSS colour is dropped rather than passed through. React
 * writes `style` through the CSSOM, so a malformed value cannot inject a second declaration — but it
 * CAN silently produce an invisible rail, which reads as a design bug rather than as bad data.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE CARD IS BESPOKE RATHER THAN AN `EntityCard`, and deliberately so: an icon above the title and
 * an accent rail are unique to this one block, and `EntityCard` is documented as the card for
 * projects, people, publications, news, events, crafts and albums — research areas are not on that
 * list. The link overlay below is copied from it verbatim, including the DOM ordering rule, because
 * the alternatives (an `<a>` wrapping the card, or two links) are both wrong for the reasons set out
 * in components/site/EntityCard.tsx.
 *
 * THE `graph` LAYOUT RENDERS THE GRID. The interactive research graph is a separate client component
 * built around a page of its own; until it exists, the honest fallback is the same cards with the
 * same accents — every record is shown, nothing is hidden, so there is nothing to declare on screen.
 *
 * A Server Component. `Reveal` is the only client piece.
 */

import Link from "next/link";
import type { PageSection } from "@prisma/client";
import * as LucideIcons from "lucide-react";
import { ArrowRight, Microscope, type LucideIcon } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { CardGrid } from "@/components/site/CardGrid";
import { LinkButton } from "@/components/ui/Button";
import {
  pickShowcase,
  type ResearchAreaRow,
  type ResolvedSectionData
} from "@/lib/sections/resolve";
import type { ResearchShowcaseSectionData } from "@/lib/sections/schema";
import { cn, stableHash, truncateWords } from "@/lib/utils";

export interface ResearchShowcaseSectionProps {
  data: ResearchShowcaseSectionData;
  section: PageSection;
  /**
   * The whole batched read, as `SectionRenderer` hands it to every block. The rows for THIS block are
   * pulled out by id — nothing is queried here.
   */
  resolved?: ResolvedSectionData;
  /** The rows directly, for a studio preview or a bespoke page. Wins over `resolved` when given. */
  rows?: ResearchAreaRow[];
  /** How many areas match the block's criteria in total. Defaults to the number of rows passed. */
  total?: number;
  /** Hand-picked ids that no longer resolve. */
  droppedIds?: number;
}

/**
 * The whole lucide export map, resolved by name on the SERVER.
 *
 * `ResearchArea.icon` is a free-text lucide name chosen from the studio's picker, so a curated
 * shortlist here would render the fallback for a perfectly valid choice — a silent wrongness the
 * editor cannot see. This is a Server Component, so the namespace import costs the browser nothing:
 * the icon is already an inline `<svg>` in the HTML by the time it reaches a reader.
 */
const ICON_SET = LucideIcons as unknown as Record<string, LucideIcon | undefined>;

/** lucide also exports helpers and objects; only a PascalCase function is an icon. */
function resolveIcon(name: string | null): LucideIcon {
  const key = name?.trim() ?? "";
  if (!/^[A-Z][A-Za-z0-9]*$/.test(key)) return Microscope;
  const candidate = ICON_SET[key];
  return typeof candidate === "function" ? candidate : Microscope;
}

/**
 * Accept a value that plausibly IS a colour, and nothing else.
 *
 * Deliberately permissive about the colour space — the studio stores OKLCH, editors paste hex, and
 * both are correct — and deliberately strict about the characters, so a pasted stylesheet fragment
 * becomes "no accent" rather than a broken rule.
 */
const COLOUR_SHAPE =
  /^(?:#[0-9a-f]{3,8}|(?:oklch|oklab|lab|lch|rgb|rgba|hsl|hsla|color)\([^;{}()]*\)|[a-z]{3,20})$/i;

function accentOf(value: string | null): string | null {
  const colour = value?.trim() ?? "";
  return colour && COLOUR_SHAPE.test(colour) ? colour : null;
}

export function ResearchShowcaseSection({
  data,
  section,
  resolved,
  rows: given,
  total: givenTotal,
  droppedIds: givenDropped
}: ResearchShowcaseSectionProps) {
  const { rows, total: matched, droppedIds } = pickShowcase(resolved?.research, section.id, {
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

  return (
    // The block's own id, so a builder's "jump to this block" and any hand-written anchor have
    // something stable to point at. `scroll-margin-top` comes from globals.css; never restate it.
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <SectionHeading
            eyebrow={eyebrow || undefined}
            // An editor who cleared the heading wanted no heading ON SCREEN, not a list with no name
            // in the document outline. `sr-only` keeps the outline intact and the page as asked.
            title={heading || "Research areas"}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            // ⚠ WITHHELD WHEN THE HEADING IS OFF SCREEN. `SectionHeading` gates its trailing link on
            // the link alone — `titleClassName` never reaches it — so an `sr-only` title still paints
            // the link beside nothing, and the row below would then draw the same words, to the same
            // place, a second time. Exactly one of the two ever renders.
            link={heading ? link : undefined}
          />
        </Reveal>

        <div className={showsHeader ? "mt-12" : undefined}>
          <CardGrid
            columns={3}
            stagger
            empty={{
              icon: Microscope,
              title: "No research areas to show yet",
              description:
                "Research areas appear here once they are published in the studio.",
              headingLevel: 3
            }}
          >
            {rows.map((area) => (
              <ResearchAreaCard key={area.id} area={area} />
            ))}
          </CardGrid>
        </div>

        <ShowcaseNote hidden={hidden} matched={matched} dropped={droppedIds} link={link} />

        {/* The CTA's ONE copy when the heading is off screen: the link was deliberately not handed
            to `SectionHeading` above, so the "see everything" route needs its own row rather than
            disappearing with the heading that would have carried it. */}
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

function ResearchAreaCard({ area }: { area: ResearchAreaRow }) {
  const Icon = resolveIcon(area.icon);
  const accent = accentOf(area.accentColor);
  // A deterministic id: a Server Component has no `useId`, and `aria-labelledby` needs one.
  const titleId = `research-area-${stableHash(area.slug).toString(36)}`;

  return (
    <article
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-lg border border-line-200 bg-card",
        "transition duration-200 ease-out hover:-translate-y-0.5 hover:border-purple-200 hover:shadow-md",
        "active:translate-y-0 active:shadow-sm"
      )}
    >
      {/* The accent rail. Decorative — the area's name carries the meaning. */}
      <span
        aria-hidden="true"
        style={accent ? { backgroundColor: accent } : undefined}
        className={cn("h-1 w-full", accent ? undefined : "bg-purple-200")}
      />

      {/*
        THE ONE LINK, as an overlay rather than a wrapper. Declared before the content and after the
        rail: positioned elements paint in DOM order and nothing here carries a z-index (contract §6).
        See components/site/EntityCard.tsx for why the two obvious shapes are both wrong.
      */}
      <Link
        href={`/research/${area.slug}`}
        aria-labelledby={titleId}
        className="absolute inset-0 rounded-lg"
      />

      <div className="flex flex-1 flex-col p-6">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-purple-50 text-purple-700">
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>

        <h3
          id={titleId}
          className="display-title mt-5 text-balance text-lg leading-snug transition-colors group-hover:text-purple-700"
        >
          {area.title}
        </h3>

        {area.summary ? (
          <p className="mt-2 text-sm leading-relaxed text-ink-500">
            {/* Truncated on the SERVER. A CSS line clamp hides text from sighted readers while
                leaving it in the accessibility tree, so the two disagree about what the card says. */}
            {truncateWords(area.summary, 160)}
          </p>
        ) : null}

        <p className="mt-auto flex items-center gap-2 pt-6 text-sm font-medium text-purple-700">
          <span
            aria-hidden="true"
            style={accent ? { backgroundColor: accent } : undefined}
            className={cn("h-2 w-2 shrink-0 rounded-full", accent ? undefined : "bg-purple-300")}
          />
          Explore this area
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </p>
      </div>
    </article>
  );
}

/**
 * The honest footnote.
 *
 * A list that quietly stops is indistinguishable from a place with no more records (contract §1.6),
 * and a hand-picked list that has lost two of its items looks like an editor who chose four things.
 * Both facts are stated here or nowhere.
 */
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
          Showing {matched - hidden} of {matched} research areas.{" "}
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
          {dropped} chosen {dropped === 1 ? "area is" : "areas are"} no longer published and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
