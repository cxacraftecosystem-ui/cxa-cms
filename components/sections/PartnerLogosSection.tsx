/**
 * PartnerLogosSection — the wall of partner and funder logos.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A LOGO IN A LINK MUST CARRY THE PARTNER'S NAME AS ITS ACCESSIBLE TEXT.
 *
 * `alt=""` marks an image decorative, which is correct for an ornament and catastrophic here: an
 * anchor whose only content is a decorative image has NO accessible name at all, and a screen reader
 * announces it as "link" — or, worse, reads the URL out character by character. So the alt is the
 * partner's name, overriding whatever the asset stores, and a partner with no logo renders their
 * name as text instead of an empty box.
 *
 * A PARTNER WITH NO URL IS NOT A LINK. A `<span>`, never an `<a href="#">` and never a `<button>`
 * that does nothing: a control that looks pressable and is not costs a keyboard user a tab stop and a
 * screen-reader user an announcement, in exchange for nothing.
 *
 * OVER TWELVE LOGOS IT BECOMES A MARQUEE, and three things make that safe rather than fashionable:
 *
 *   1. The track is DUPLICATED and translated by exactly -50% (`animate-ticker-track`), so the seam
 *      is invisible. The duplicate is `aria-hidden` AND has no links in it, because a focusable
 *      element inside an `aria-hidden` subtree is focusable-but-hidden — the worst of both.
 *   2. Reduced motion neutralises it. The global rule in globals.css collapses the animation to one
 *      iteration of 0.01ms with no fill mode, so the track simply parks at its starting offset with
 *      the first, real, linked copy on screen. It has to remain READABLE when stopped, and it does.
 *   3. Hover and focus pause it. A row that keeps moving while a keyboard user is trying to read the
 *      link they have just landed on is unusable, and `[animation-play-state:paused]` is a complete
 *      literal class string, so it survives the content scanner (contract §5).
 *
 * GREYSCALE IS A CSS TRANSITION, not framer-motion — CSS is the half of the reduced-motion contract
 * that needs no JS branch, and this component ships no JavaScript at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A Server Component.
 */

import Link from "next/link";
import type { PageSection } from "@prisma/client";
import { ArrowRight, Handshake } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { MediaImage } from "@/components/ui/MediaImage";
import { pickShowcase, type PartnerRow, type ResolvedSectionData } from "@/lib/sections/resolve";
import type { PartnerLogosSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";
import type { CSSProperties } from "react";

export interface PartnerLogosSectionProps {
  data: PartnerLogosSectionData;
  section: PageSection;
  /** The whole batched read from `lib/sections/resolve.ts`; this block's rows are pulled out by id. */
  resolved?: ResolvedSectionData;
  /** The rows directly, for a studio preview or a bespoke page. Wins over `resolved` when given. */
  rows?: PartnerRow[];
  total?: number;
  droppedIds?: number;
}

/** Above this many, a static grid becomes a wall and the row starts scrolling itself. */
const MARQUEE_THRESHOLD = 12;

/** Seconds per logo. Slow enough to read a wordmark as it passes; the whole lap scales with the row. */
const SECONDS_PER_LOGO = 3.5;

/** Complete literal class strings — a `grid-cols-${n}` built from a variable is purged (contract §5). */
const COLUMN_CLASS: Record<3 | 4 | 5 | 6, string> = {
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6"
};

export function PartnerLogosSection({
  data,
  section,
  resolved,
  rows: given,
  total: givenTotal,
  droppedIds: givenDropped
}: PartnerLogosSectionProps) {
  const { rows, total: matched, droppedIds } = pickShowcase(resolved?.partners, section.id, {
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
  const marquee = rows.length > MARQUEE_THRESHOLD;

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <SectionHeading
            eyebrow={eyebrow || undefined}
            title={heading || "Partners"}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            // ⚠ Withheld when the heading is off screen: `SectionHeading` gates its trailing link on
            // the link alone, so an `sr-only` title still paints it — and the row below would draw
            // the same call to action a second time. Exactly one of the two ever renders.
            link={heading ? link : undefined}
          />
        </Reveal>
      </div>

      <div className={showsHeader ? "mt-12" : undefined}>
        {rows.length === 0 ? (
          <div className="shell">
            <EmptyState
              icon={Handshake}
              title="No partners to show yet"
              description="Partners appear here once they are added and made visible in the studio."
              headingLevel={3}
            />
          </div>
        ) : marquee ? (
          <PartnerMarquee partners={rows} monochrome={data.monochrome} />
        ) : (
          <div className="shell">
            <ul className={cn("grid items-center gap-4", COLUMN_CLASS[data.columns])}>
              {rows.map((partner) => (
                <li key={partner.id}>
                  <PartnerLogo partner={partner} monochrome={data.monochrome} interactive />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="shell">
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

function PartnerMarquee({
  partners,
  monochrome
}: {
  partners: PartnerRow[];
  monochrome: boolean;
}) {
  // The variable the `animate-ticker-track` keyframes read. Set inline because a class assembled from
  // a computed duration would be purged by the content scanner.
  const style = { "--ticker-duration": `${partners.length * SECONDS_PER_LOGO}s` } as CSSProperties;

  return (
    <div className="mask-edges-x overflow-hidden">
      <div
        style={style}
        className={cn(
          // `w-max` is what makes the -50% translate land exactly one copy along; a percentage width
          // would move it by a fraction of the viewport instead and the seam would jump each lap.
          "flex w-max animate-ticker-track items-center gap-12",
          "hover:[animation-play-state:paused] focus-within:[animation-play-state:paused]"
        )}
      >
        {/* The real copy: real links, real names, in the document. */}
        <ul className="flex shrink-0 items-center gap-12">
          {partners.map((partner) => (
            <li key={partner.id} className="w-36 shrink-0 sm:w-40">
              <PartnerLogo partner={partner} monochrome={monochrome} interactive />
            </li>
          ))}
        </ul>

        {/*
          The seam filler. Hidden from assistive technology AND stripped of its links, so nothing in
          here is focusable — an `aria-hidden` subtree containing a tab stop is a trap that announces
          nothing when you land in it.
        */}
        <ul aria-hidden="true" className="flex shrink-0 items-center gap-12">
          {partners.map((partner) => (
            <li key={`echo-${partner.id}`} className="w-36 shrink-0 sm:w-40">
              <PartnerLogo partner={partner} monochrome={monochrome} interactive={false} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PartnerLogo({
  partner,
  monochrome,
  interactive
}: {
  partner: PartnerRow;
  monochrome: boolean;
  /** False for the marquee's duplicate copy, which must hold nothing focusable. */
  interactive: boolean;
}) {
  const external = partner.url?.trim() ?? "";

  const mark = partner.logo ? (
    <MediaImage
      media={partner.logo}
      // The NAME, not the asset's stored alt: this image is the whole of the link's accessible text.
      alt={partner.name}
      aspect="3 / 2"
      rounded="none"
      sizes="160px"
      className="w-full"
      imageClassName={cn(
        // `!object-contain` because MediaImage sets `object-cover` first and `cn()` is a plain join,
        // so a later utility does not win (contract §5). A cropped logo is a defaced logo.
        "!object-contain p-2 transition duration-300 ease-out",
        // Driven from the frame rather than the image, so the whole target restores the colour —
        // hovering the padding beside a narrow wordmark should count as hovering the logo.
        monochrome ? "grayscale opacity-70 group-hover:grayscale-0 group-hover:opacity-100" : undefined
      )}
    />
  ) : (
    // No logo is not a hole: the name is the point, and the name is what the link is called anyway.
    <span className="flex h-full min-h-16 items-center justify-center px-2 text-center text-sm font-medium text-ink-700">
      {partner.name}
    </span>
  );

  const frame = "group flex h-20 items-center justify-center rounded-md";

  if (!interactive) {
    return (
      <span className={frame}>{mark}</span>
    );
  }

  if (!external) {
    // A partner with no website. A statement, not a control — see the header.
    return <span className={frame}>{mark}</span>;
  }

  const internal = external.startsWith("/");
  const className = cn(frame, "transition-colors hover:bg-surface-50");

  if (internal) {
    return (
      <Link href={external} className={className}>
        {mark}
      </Link>
    );
  }

  return (
    <a href={external} target="_blank" rel="noopener noreferrer" className={className}>
      {mark}
      {/* A reader whose focus lands on another site with no warning has lost their place and their
          Back button with it. */}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
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
          Showing {matched - hidden} of {matched} partners.{" "}
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
          {dropped} chosen {dropped === 1 ? "partner is" : "partners are"} no longer visible and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
