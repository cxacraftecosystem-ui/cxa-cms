/**
 * PeopleShowcaseSection — portraits, names, designations and departments.
 *
 * PORTRAITS ARE 4/5, NOT THE CARD'S DEFAULT 3/4. A portrait photograph of a person is taller than it
 * is wide by more than a third; cropping to 3/4 takes the top of the head off often enough that it
 * is worth overriding. The ratio is passed to `EntityCard` rather than set on the image, so the space
 * is reserved before the bytes arrive and nothing below the row moves as the photographs load.
 *
 * THE `row` LAYOUT IS A HORIZONTAL SCROLLER, and it is a real `<ul>` of real links. It carries no
 * `tabIndex`: a scroll container whose children are all focusable is already reachable, and adding a
 * tab stop for the container itself would make a keyboard user press Tab twice to reach the first
 * person. The browser scrolls a focused card into view on its own. The edge fade is `.mask-edges-x`
 * from globals.css, which is a mask rather than an overlaid gradient so it is correct in both themes.
 *
 * A Server Component.
 */

import Link from "next/link";
import type { PageSection } from "@prisma/client";
import { ArrowRight, Users } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { CardGrid } from "@/components/site/CardGrid";
import { EntityCard } from "@/components/site/EntityCard";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { pictureFromMap, type ScreenFraming } from "@/lib/media/screens";
import {
  pickShowcase,
  type MediaRow,
  type PersonRow,
  type ResolvedSectionData
} from "@/lib/sections/resolve";
import type { PeopleShowcaseSectionData } from "@/lib/sections/schema";

export interface PeopleShowcaseSectionProps {
  data: PeopleShowcaseSectionData;
  section: PageSection;
  /** The whole batched read from `lib/sections/resolve.ts`; this block's rows are pulled out by id. */
  resolved?: ResolvedSectionData;
  /** The rows directly, for a studio preview or a bespoke page. Wins over `resolved` when given. */
  rows?: PersonRow[];
  total?: number;
  droppedIds?: number;
}

/**
 * The plural an editor would say, for the empty state and the footnote.
 *
 * Lower case, because every use is mid-sentence — "No scientists to show yet", "Showing 6 of 11
 * scientists." A `Record` over the block's own kind union rather than over `PersonKind`, so it also
 * covers "" ("everyone").
 */
const KIND_PLURAL: Record<PeopleShowcaseSectionData["kind"], string> = {
  "": "people",
  FACULTY: "faculty members",
  SCIENTIST: "scientists",
  RESEARCHER: "researchers",
  STUDENT: "students",
  STAFF: "staff",
  VISITOR: "visitors",
  ALUMNUS: "alumni",
  // The one entry that keeps its capitals and takes a noun after it: "DC, Handicrafts" is a title, and
  // both sentences this map feeds need something countable to follow it — "Showing 1 of 1 DC,
  // Handicrafts." reads as a truncated sentence, "…1 of 1 DC, Handicrafts profiles." does not.
  DC_HANDICRAFTS: "DC, Handicrafts profiles"
};

/** A portrait is taller than the card's default. See the header. */
const PORTRAIT_ASPECT = "4 / 5";

export function PeopleShowcaseSection({
  data,
  section,
  resolved,
  rows: given,
  total: givenTotal,
  droppedIds: givenDropped
}: PeopleShowcaseSectionProps) {
  const { rows, total: matched, droppedIds } = pickShowcase(resolved?.people, section.id, {
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

  const plural = KIND_PLURAL[data.kind];
  const hidden = Math.max(0, matched - rows.length);
  const scrolling = data.layout === "row";

  const empty = {
    icon: Users,
    title: `No ${plural} to show yet`,
    description: "People appear here once their profiles are published in the studio.",
    headingLevel: 3 as const
  };

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <SectionHeading
            eyebrow={eyebrow || undefined}
            title={heading || "People"}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            // ⚠ Withheld when the heading is off screen: `SectionHeading` gates its trailing link on
            // the link alone, so an `sr-only` title still paints it — and the row below would draw
            // the same call to action a second time. Exactly one of the two ever renders.
            link={heading ? link : undefined}
          />
        </Reveal>
      </div>

      {scrolling ? (
        <div className={showsHeader ? "mt-12" : undefined}>
          {rows.length === 0 ? (
            <div className="shell">
              <EmptyState {...empty} />
            </div>
          ) : (
            // Full-bleed on purpose: a row that scrolls should run to the edge of the screen, so the
            // fade is the signal that there is more rather than a hard stop at the column.
            <ul className="mask-edges-x flex snap-x snap-mandatory gap-6 overflow-x-auto px-5 pb-4 sm:px-8">
              {rows.map((person, index) => (
                <li key={person.id} className="w-56 shrink-0 snap-start sm:w-64">
                  <Reveal delay={Math.min(index, 8) * 0.05} className="h-full">
                    <PersonCard
                      person={person}
                      media={resolved?.media}
                      showRole={data.showRole}
                      sizes="16rem"
                    />
                  </Reveal>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="shell">
          <div className={showsHeader ? "mt-12" : undefined}>
            <CardGrid columns={4} stagger empty={empty}>
              {rows.map((person) => (
                <PersonCard
                  key={person.id}
                  person={person}
                  media={resolved?.media}
                  showRole={data.showRole}
                />
              ))}
            </CardGrid>
          </div>
        </div>
      )}

      <div className="shell">
        <ShowcaseNote
          hidden={hidden}
          matched={matched}
          dropped={droppedIds}
          plural={plural}
          link={link}
        />

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

function PersonCard({
  person,
  media,
  showRole,
  sizes
}: {
  person: PersonRow;
  /**
   * The page's media map, which carries the portrait AND every alternate a framing names —
   * `attachPersonFraming` in lib/sections/resolve.ts puts both there. Absent on the `rows` path (a
   * studio preview, a bespoke page), where the portrait then draws unframed rather than not at all.
   */
  media?: Record<string, MediaRow | undefined>;
  showRole: boolean;
  sizes?: string;
}) {
  return (
    <EntityCard
      href={`/people/${person.slug}`}
      media={person.photo}
      /* The column is `Json?`, so its shape is a claim rather than a proof — safe because the resolver
         reads a framing defensively, which is what makes a hand-edited row degrade to no framing. */
      picture={pictureFromMap(
        person.photoId,
        (person.photoScreens ?? null) as unknown as ScreenFraming | null,
        media
      )}
      variant="portrait"
      aspect={PORTRAIT_ASPECT}
      sizes={sizes}
      title={person.name}
      // The designation is what a reader is looking for after the name; the department places them.
      description={showRole ? (person.designation ?? undefined) : undefined}
      meta={person.department ? <span>{person.department}</span> : undefined}
    />
  );
}

/** The honest footnote — contract §1.6. */
function ShowcaseNote({
  hidden,
  matched,
  dropped,
  plural,
  link
}: {
  hidden: number;
  matched: number;
  dropped: number;
  plural: string;
  link?: { href: string; label: string };
}) {
  if (hidden === 0 && dropped === 0) return null;

  return (
    <p className="mt-8 text-sm text-ink-500">
      {hidden > 0 ? (
        <>
          Showing {matched - hidden} of {matched} {plural}.{" "}
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
          {dropped} chosen {dropped === 1 ? "person is" : "people are"} no longer published and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
