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
import { truncateWords } from "@/lib/utils";

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
 * How much of a department a card's meta row carries, in characters.
 *
 * ⚠ `Person.department` IS FREE TEXT AND ONE OF THE SPELLINGS IN IT IS 199 CHARACTERS LONG. It is the
 * Centre's own name written the way a funder's letterhead writes it — the unit, then "at IIT Kharagpur",
 * then the Office, the Ministry and the Government that pay for it — and it is now the spelling
 * lib/people/departments.ts elects as canonical, so it is what the studio's datalist offers an editor
 * and what the roster will increasingly carry. `EntityCard`'s meta row is a wrapping flex row at
 * `text-xs` with NO clamp of any kind: a four-column card inside the shell leaves it about 260px, which
 * is roughly forty characters a line, so 199 of them are five lines of grey between the designation and
 * the interests rail. And because the cards in a grid row are `h-full`, they are five lines on every
 * OTHER card in that row as well — one long department makes the whole row of portraits tall.
 *
 * SO THE CUT IS IN THE STRING, AND IT IS NEVER `line-clamp-*`. A CSS clamp hides the tail from a sighted
 * reader while leaving the whole of it in the accessibility tree, so the two disagree about what the
 * card says (EntityCard's own note on `description`). `truncateWords` cuts on a word boundary and says
 * so with an ellipsis — the on-screen statement that something was dropped (contract §1.6) — and the
 * value in full is one tap away on the profile the card already links to.
 *
 * 70 IS TWO LINES, AND IT IS ALSO WHERE THE UNIT'S OWN NAME ENDS. The narrowest slot this row is drawn
 * in is not the grid but the 16rem showcase rail (components/sections/PeopleShowcaseSection.tsx), which
 * is about thirty-five characters a line; seventy is two of them there and a little under two in the
 * grid. The ten or so extra characters a grid card could afford buy nothing anyway: they land inside
 * "at IIT Kharagpur" and leave the line reading "…Platform at IIT…", which a reader takes for a
 * rendering fault rather than for a placing. Stopping where the Centre's name stops says where somebody
 * works; the funding clause after it is a fact for the page about them, not for a card in a grid of
 * twenty-four.
 *
 * ⚠ THIS RUNS IN THE BROWSER ON `/people`, AND THAT IS NOT A BREACH OF THE RULE. "Truncate on the
 * server" is shorthand for "cut the text, not the pixels": the directory filters in the browser and
 * therefore re-renders these cards there, and `lib/utils` carries zero imports precisely so a helper
 * like this one can be reached from a Client Component, an RSC and `tsx` alike (lib/utils.ts's header).
 * Either way the DOM holds exactly the characters the reader is shown.
 */
export const DEPARTMENT_META_LIMIT = 70;

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
            {/* As much of the placing as a card can carry, cut out loud — see DEPARTMENT_META_LIMIT. */}
            {person.department ? (
              <span>{truncateWords(person.department, DEPARTMENT_META_LIMIT)}</span>
            ) : null}
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
