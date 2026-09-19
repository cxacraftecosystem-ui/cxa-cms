/**
 * PersonCard — one member of the Centre, as a card.
 *
 * NO `"use client"` AND NO SERVER-ONLY IMPORT, on purpose. The card itself is presentational and
 * renders identically in a Server Component and inside a client tree — which is load-bearing here,
 * because `/people` filters its roster in the browser and therefore renders these cards from a Client
 * Component, while `/people/[slug]` and the section renderers want them on the server. A module with
 * neither directive can be reached from both.
 *
 * ⚠ THE GROUP VOCABULARY IS NO LONGER HERE. `PERSON_KIND_ORDER`, `PERSON_KIND_LABELS` and
 * `PERSON_KIND_GROUPS` moved to lib/people/groups.ts, which that file's header explains in full: two
 * callers had already been forced to write their own copy of the words rather than import a CARD, and
 * the site header — a Client Component on every page — was about to become the third. This file now
 * imports them like everybody else. Anything that wants the words and not the card should import from
 * lib/people/groups.ts directly.
 *
 * PORTRAITS ARE 4/5, NOT THE CARD'S DEFAULT 3/4. A portrait photograph of a person is taller than it
 * is wide by more than a third, and 3/4 crops the top of the head off often enough to be worth
 * overriding. The ratio is passed to `EntityCard` rather than set on the image, so the space is
 * reserved before the bytes arrive and nothing below the row moves as the photographs load.
 */

import type { PersonKind } from "@prisma/client";

import { EntityCard, type EntityCardHeadingLevel } from "@/components/site/EntityCard";
import { TagList } from "@/components/site/TagList";
import { PERSON_KIND_LABELS } from "@/lib/people/groups";
import type { Picture } from "@/lib/media/screens";
import type { MediaLike } from "@/lib/media/url";

/**
 * The columns a card reads.
 *
 * Declared structurally rather than as the Prisma row, so a caller can pass a `select`-narrowed object
 * — which is what every listing does. A full `Person` satisfies it.
 */
export interface PersonCardPerson {
  slug: string;
  name: string;
  kind: PersonKind;
  designation?: string | null;
  department?: string | null;
  researchInterests?: readonly string[];
  startedOn?: Date | null;
  endedOn?: Date | null;
  photo?: MediaLike | null;
}

/**
 * The years a person has been with the Centre, or null when nothing is recorded.
 *
 * ⚠ THE YEAR IS READ IN UTC, DELIBERATELY. These dates are absolute instants, and `getFullYear()`
 * resolves them in the viewer's timezone — so a start date stored as midnight on 1 January 2019 reads
 * as 2018 anywhere west of UTC. On this page that is not merely a wrong label: `/people` renders the
 * roster on the server and re-renders the same rows in the browser as the reader types, so a
 * timezone-dependent string is a hydration mismatch as well as a lie.
 *
 * A person with no `endedOn` is CURRENT and shows no end date — that is the schema's convention
 * (prisma/schema.prisma) and the reason an alumnus's years read as a closed range.
 */
export function personTenure(person: {
  startedOn?: Date | null;
  endedOn?: Date | null;
}): string | null {
  const from = person.startedOn ? person.startedOn.getUTCFullYear() : null;
  const to = person.endedOn ? person.endedOn.getUTCFullYear() : null;

  if (to !== null) {
    // An en dash for a range of years, which is what a date range takes in British typography.
    return from !== null ? (from === to ? `${from}` : `${from}–${to}`) : `Until ${to}`;
  }
  return from !== null ? `Since ${from}` : null;
}

/** How many interests fit on a card before the honest "+N more" chip takes over. */
const INTEREST_LIMIT = 3;

/**
 * ⚠ THE DEPARTMENT IS PRINTED WHOLE, AND A CHARACTER LIMIT ON IT WAS A MISTAKE THAT SHIPPED.
 *
 * This file briefly cut it to seventy characters with `truncateWords`, because one department at this
 * Centre is 199 characters long — the unit, then "at IIT Kharagpur", then the Office, the Ministry and
 * the Government that fund it — and five lines of grey in a card's meta row makes every other card in
 * that `h-full` row as tall.
 *
 * The limit was wrong because IT MEASURED NOTHING. A character count is fixed and a card is not: this
 * row is drawn in a four-column grid at 2xl, three columns at lg, full width on a phone and a 16rem
 * rail in a showcase block, and seventy characters was sized against the narrowest of those. Every
 * wider card then showed an ellipsis with room to spare, which reads as a rendering fault — the tail
 * is missing and the space it would have occupied is visibly there.
 *
 * A shorter department needs no cut, and the long one is long because of a funding clause that belongs
 * in the prose about the Centre rather than in a field printed under twenty people's names. That is an
 * editorial fix in Studio → People, on one value, and it is the right place for it — not a number in a
 * component pretending to know how wide a card is.
 */

export interface PersonCardProps {
  person: PersonCardPerson;
  /**
   * The portrait's per-screen framing, already resolved.
   *
   * A PROP rather than a column on `PersonCardPerson`, because resolving one needs the alternate
   * photographs the framing names — arbitrary ids in `Person.photoScreens` that no relation joins, so
   * only the query that fetched the row can fetch them (lib/media/framing.ts). Omitted, or resolved from
   * a person nobody has framed, the card renders exactly as it did before the column existed.
   */
  picture?: Picture | null;
  /**
   * Show the kind as the card's eyebrow. Off by default: a roster grouped by kind already says it in
   * the heading above, and repeating it on every card reads as a rendering bug.
   */
  showKind?: boolean;
  /** Show the research interests on the bottom rail. On by default — it is what a card is scanned for. */
  showInterests?: boolean;
  /** The rank of the card's heading. Default 3 — a card under a group's `<h2>`. */
  headingLevel?: EntityCardHeadingLevel;
  /** `sizes` for the portrait. Override for a slot narrower than a four-column grid. */
  sizes?: string;
  /** Only for a card ABOVE THE FOLD. */
  priority?: boolean;
  className?: string;
}

/** A portrait is taller than the card's default. See the header. */
const PORTRAIT_ASPECT = "4 / 5";

/**
 * Two letters for a portrait plate. Never three: at the size this renders it stops being legible and
 * starts being a word.
 *
 * First and LAST word, not the first two, so "Faiz Ahmad Ansari" is FA rather than FA of "Faiz
 * Ahmad" — a middle name should not displace the family name. A single-word name gives one letter.
 *
 * EXPORTED because the person's own PAGE needs the same plate, and it needs it more: there the slot is
 * 18rem wide, so `MediaImage`'s "No image" diagnostic is a grey rectangle the size of a real portrait
 * rather than a small one on a card. Two implementations of "how this site draws a person with no
 * photograph" would disagree the first time either was touched.
 */
export function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export function PersonCard({
  person,
  picture,
  showKind = false,
  showInterests = true,
  headingLevel = 3,
  sizes,
  priority = false,
  className
}: PersonCardProps) {
  const tenure = personTenure(person);
  const interests = showInterests
    ? (person.researchInterests ?? []).filter((interest) => interest.trim().length > 0)
    : [];

  return (
    <EntityCard
      href={`/people/${person.slug}`}
      media={person.photo ?? null}
      picture={picture ?? null}
      /*
       * ⚠ MANY PEOPLE GENUINELY HAVE NO PORTRAIT, AND THAT IS NOT A FAULT TO REPORT.
       *
       * A directory of twenty-four grey boxes each reading "No image" tells a reader nothing and
       * looks broken; an initials plate is better looking AND more informative, and it does not
       * pretend a photograph exists. `aria-hidden` because the card's heading already carries the
       * name — announcing the initials as well would read it twice.
       */
      mediaFallback={
        <span
          aria-hidden="true"
          className="font-display text-3xl font-semibold tracking-tight text-purple-700/45"
        >
          {personInitials(person.name)}
        </span>
      }
      variant="portrait"
      aspect={PORTRAIT_ASPECT}
      sizes={sizes}
      priority={priority}
      headingLevel={headingLevel}
      eyebrow={showKind ? PERSON_KIND_LABELS[person.kind] : undefined}
      title={person.name}
      // The designation is what a reader looks for immediately after the name; the department places
      // them, and the years say whether they are still here.
      description={person.designation ?? undefined}
      meta={
        person.department || tenure ? (
          <>
            {person.department ? <span>{person.department}</span> : null}
            {tenure ? <span className="tabular-nums">{tenure}</span> : null}
          </>
        ) : undefined
      }
      footer={
        interests.length > 0 ? (
          // `max` truncates OUT LOUD: the overflow is a visible "+N more" that links to the profile
          // where the rest are listed. A list that quietly stops at three is indistinguishable from a
          // person with exactly three interests (contract §1.6).
          <TagList
            tags={interests}
            label="Research interests"
            max={INTEREST_LIMIT}
            moreHref={`/people/${person.slug}`}
            size="sm"
          />
        ) : undefined
      }
      className={className}
    />
  );
}
