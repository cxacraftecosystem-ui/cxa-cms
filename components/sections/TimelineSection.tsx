/**
 * TimelineSection — a chronology, down the page or along it.
 *
 * A Server Component. The only client piece is `./timeline/TimelineSpine`, which owns the ref that
 * `ScrollProgress` measures; the entries themselves are rendered on the server and handed to it as
 * children, so a forty-entry history with a picture on every row ships no JavaScript of its own.
 *
 * ⚠ `year` IS A STRING AND MUST STAY ONE. The honest answers here are "c. 1780", "2024–26" and
 * "Mughal period"; a date column would force a precision the record does not have, and a made-up date
 * in an archive is worse than no date at all (the same note sits on `Craft.originYear` in the Prisma
 * schema). Nothing in this file parses, sorts or reformats it — it is printed exactly as typed, and
 * the ORDER of the entries is the editor's, not a sort of ours.
 *
 * THE SPINE IS TWO SIGNALS. The track and the dots are static and carry the whole structure; the
 * purple fill that follows the reader down is decoration on top of it, and `ScrollProgress` drops its
 * travelling node entirely under reduced motion (contract §1.4).
 *
 * The horizontal variant is a scrolling rail. It carries `tabIndex={0}` and a name because a
 * scrollable region that cannot be reached from the keyboard is content some readers cannot get to
 * at all.
 */

import type { PageSection } from "@prisma/client";

import { STAGGER } from "@/components/motion/constants";
import { Reveal } from "@/components/motion/Reveal";
import { TimelineSpine } from "@/components/sections/timeline/TimelineSpine";
import { SectionHeading } from "@/components/site/SectionHeading";
import { MediaImage } from "@/components/ui/MediaImage";
import { sectionLabel } from "@/lib/sections/registry";
import type { ResolvedSectionData } from "@/lib/sections/resolve";
import type { TimelineSectionData } from "@/lib/sections/schema";
import { cn } from "@/lib/utils";

export interface TimelineSectionProps {
  data: TimelineSectionData;
  section: PageSection;
  /** The batched read from `lib/sections/resolve.ts`; `resolved.media` is keyed by ASSET id. */
  resolved?: ResolvedSectionData;
}

/** Long chronologies stop gaining delay here; the fortieth entry must not arrive two seconds late. */
const MAX_STAGGER_STEPS = 8;

export function TimelineSection({ data, section, resolved }: TimelineSectionProps) {
  // An entry with nothing in any of its three fields is a row an editor added and has not filled in.
  const entries = data.entries.filter(
    (entry) => entry.year.length > 0 || entry.title.length > 0 || entry.body.length > 0
  );
  if (entries.length === 0) return null;

  const horizontal = data.orientation === "horizontal";

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  /** Is any of the header visible? Only then does it take space above the chronology. */
  const showsHeader = Boolean(heading || eyebrow || body);

  // The dot sits on the rail in both orientations: on the spine at 8px from the left going down, and
  // on each card's own top hairline going across.
  const rowClass = horizontal
    ? "w-72 shrink-0 snap-start border-t border-line-200 pt-6"
    : "pl-12 pb-12 last:pb-0";

  const list = (
    <ol className={cn(horizontal && "flex gap-8")}>
      {entries.map((entry, index) => {
        const asset = entry.mediaId ? resolved?.media[entry.mediaId] : undefined;

        return (
          <Reveal
            as="li"
            key={`${index}-${entry.year}-${entry.title}`}
            delay={Math.min(index, MAX_STAGGER_STEPS) * STAGGER.rows}
            className={cn("relative", rowClass)}
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute flex h-4 w-4 items-center justify-center rounded-full border border-line-200 bg-card",
                horizontal ? "-top-2 left-0" : "left-0 top-1"
              )}
            >
              <span className="block h-1.5 w-1.5 rounded-full bg-purple-700" />
            </span>

            {entry.year ? <p className="eyebrow">{entry.year}</p> : null}

            {entry.title ? (
              <h3 className={cn("display-title text-lg sm:text-xl", entry.year && "mt-2")}>
                {entry.title}
              </h3>
            ) : null}

            {entry.body ? (
              <p className="prose-measure mt-2.5 text-sm leading-relaxed text-ink-500">
                {entry.body}
              </p>
            ) : null}

            {asset ? (
              <MediaImage
                media={asset}
                rounded="md"
                aspect="4 / 3"
                sizes="(min-width: 1024px) 24rem, 100vw"
                className={cn("mt-5 border border-line-200", horizontal ? "w-full" : "max-w-sm")}
              />
            ) : null}
          </Reveal>
        );
      })}
    </ol>
  );

  return (
    <section id={`s-${section.id}`} data-anchor="" className="py-20 md:py-28">
      <div className="shell">
        {/*
          ALWAYS RENDERED. Every entry's title is an `<h3>`, so a chronology with no `<h2>` of its own
          takes the page from `<h1>` straight to `<h3>` — a level missing from the outline a
          screen-reader user navigates by (contract §11).

          A heading an editor cleared is taken OFF SCREEN rather than invented, and the fallback words
          are the block's own name from `SECTION_REGISTRY` so they come from one place. The margin is
          gated on there being something to see, so a header that exists only for the outline does not
          leave 56px of empty space above the first entry.
        */}
        <SectionHeading
          eyebrow={eyebrow || undefined}
          title={heading || sectionLabel(section.type)}
          titleClassName={heading ? undefined : "sr-only"}
          description={body || undefined}
          className={showsHeader ? "mb-14" : undefined}
        />

        {horizontal ? (
          // The rail bleeds to the edge of the viewport on a phone while its first card stays in line
          // with the column: the negative margin is exactly the shell's own padding, paid back inside.
          <div
            role="group"
            tabIndex={0}
            // The trimmed heading, so a heading of nothing but spaces does not name the rail
            // " — timeline".
            aria-label={heading ? `${heading} — timeline` : "Timeline"}
            className="mask-edges-x -mx-5 snap-x snap-mandatory overflow-x-auto px-5 pb-4 sm:-mx-8 sm:px-8"
          >
            {list}
          </div>
        ) : (
          <TimelineSpine>{list}</TimelineSpine>
        )}
      </div>
    </section>
  );
}
