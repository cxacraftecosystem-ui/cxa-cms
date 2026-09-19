import "server-only";
import { cache } from "react";
import type { Prisma, PersonKind } from "@prisma/client";

import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { framingAssets, withBaseAsset } from "@/lib/media/framing";
import { pictureFromMap, type Picture, type ScreenFraming } from "@/lib/media/screens";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { PERSON_KIND_ORDER, type PersonGroupCount } from "@/lib/people/groups";
import { prerenderSafe } from "@/lib/prerender";

/**
 * Reading the Centre's roster — the one definition of who is listed, and the one query that lists them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: "A LISTABLE PERSON" WAS WRITTEN OUT FOUR TIMES.
 *
 * `{ ...liveStatusWhere(), isVisible: true }` is TWO independent editor switches — publication, and the
 * separate "show this person in the directory" — and every public read of a person has to apply both.
 * `/people` did, with a comment saying "app/sitemap.ts applies the identical pair"; the sitemap did;
 * `/people/[slug]` did; the share card did. Four hand-kept copies of a predicate is three chances for a
 * withdrawn profile to reappear on one surface, and this change was about to add two more — the header
 * menu's per-group counts and the group pages themselves.
 *
 * A count that disagrees with a page is not a cosmetic fault here: the header offers a group ONLY when
 * somebody is in it, so a count taken with a different predicate offers a menu entry that leads to an
 * empty page, or hides a group that has people in it.
 *
 * ⚠ THE SELECT LIVES HERE TOO, AND `scripts/framing-select-check.ts` IS WHY IT IS WHOLE. That check
 * reads ONE FILE AT A TIME: a `photo: { select: … }` must carry `photoScreens` AND `photoId` as literal
 * siblings, because a query that fetches the portrait without the framing silently renders every
 * framed portrait uncropped. Splitting this object across two files would pass the check and break the
 * pictures, so it is declared once, here, and imported whole.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * How many profiles any one page loads at once.
 *
 * There has to be a number: a roster page serialises every row it loads into the HTML, so an unbounded
 * query is an unbounded payload. Four hundred is comfortably more than any single Centre's
 * establishment, and when it IS reached the page says so on screen and names how many are missing
 * (contract §1.6) — which is why `loadRoster` returns the total beside the rows rather than leaving the
 * caller to guess whether it stopped short.
 */
export const ROSTER_CAP = 400;

/**
 * Who appears in a public list of people.
 *
 * `isVisible` is the editor's "show this person in the directory" switch and is SEPARATE from
 * publication state: a profile can be published — so its own page resolves, and citations of it keep
 * working — while being kept off every roster. Both conditions, everywhere, or the switch means
 * nothing.
 */
export function listablePersonWhere(): Prisma.PersonWhereInput {
  return { ...liveStatusWhere(), isVisible: true };
}

/**
 * The columns a roster card reads.
 *
 * `photoId` looks redundant next to the relation and is not: `pictureFromMap` resolves the base
 * photograph out of a media map BY ID, exactly like a bucket that names an alternate — so a row
 * carrying the relation but not the id cannot be framed at all (lib/media/screens.ts). `MEDIA_IMAGE_SELECT`
 * carries the `variants`; without them `pickVariant` has nothing to choose from and every portrait falls
 * back to the full-size original inside a 320px card.
 */
export const ROSTER_SELECT = {
  id: true,
  slug: true,
  name: true,
  kind: true,
  designation: true,
  department: true,
  // Read for the filter facet as well as the card, so the two cannot offer an interest nobody has.
  researchInterests: true,
  startedOn: true,
  endedOn: true,
  photoId: true,
  photoScreens: true,
  photo: { select: MEDIA_IMAGE_SELECT }
} satisfies Prisma.PersonSelect;

/** One roster row, with its portrait's per-screen framing already resolved on the server. */
export type RosterPerson = Prisma.PersonGetPayload<{ select: typeof ROSTER_SELECT }> & {
  /**
   * The portrait, resolved HERE rather than in the browser: the alternate photographs a framing names
   * are ids in a JSONB column that no relation joins, so only a server query can fetch them. Null for
   * the overwhelming majority, who are unframed.
   */
  picture: Picture | null;
};

export interface Roster {
  /** The rows, in the total order below, capped at `ROSTER_CAP`. */
  people: RosterPerson[];
  /** How many there are in all. Equal to `people.length` unless the cap was reached. */
  total: number;
}

/**
 * The roster, or one group of it.
 *
 * ⚠ THE ORDER IS TOTAL, AND THE THIRD KEY IS NOT DECORATION. `sortOrder` is the editor's arrangement
 * inside a group; `name` breaks a tie (the convention the schema documents); `id` breaks the tie `name`
 * cannot — two people with the same sortOrder AND the same name is unusual but not impossible, and
 * without a unique final key Postgres may return them in either order on either request. A reader would
 * see a list that reshuffles itself for no reason, which reads as data changing.
 *
 * ⚠ THE COUNT IS A SECOND QUERY RATHER THAN `take: CAP + 1`. One extra row would only prove that
 * somebody is missing; the count says how many, which is the difference between "this list stops" and
 * "this list stops and 37 people are not on it" (contract §1.6).
 *
 * ⚠ WRAPPED IN `prerenderSafe`, SO EVERY CALLER MUST EXPORT `revalidate`. lib/prerender.ts states the
 * pairing as non-optional: a page whose read fell back at build time is prerendered EMPTY, and without
 * a revalidation window that snapshot is served until the next deploy.
 */
export async function loadRoster(kind?: PersonKind): Promise<Roster> {
  const where: Prisma.PersonWhereInput = kind
    ? { ...listablePersonWhere(), kind }
    : listablePersonWhere();

  const [rows, total] = await prerenderSafe(
    kind ? `people/group/${kind}` : "people",
    () =>
      Promise.all([
        prisma.person.findMany({
          where,
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
          take: ROSTER_CAP,
          select: ROSTER_SELECT
        }),
        prisma.person.count({ where })
      ]),
    [[], 0]
  );

  /**
   * Every alternate photograph the framings name, in ONE query for the whole page.
   *
   * ⚠ AND NO QUERY AT ALL WHEN NOBODY HAS FRAMED A PORTRAIT, which is the common case and the reason
   * this is not guarded: `framingAssets` returns an empty map without touching the database when there
   * are no ids (lib/media/framing.ts). A prerender whose read fell back to `[]` therefore costs nothing
   * either.
   *
   * The base photograph is added PER PERSON rather than into one shared map: `pictureFromMap` looks it
   * up by id like any other band, and a map holding four hundred portraits would be four hundred
   * entries no single card can use.
   */
  const alternates = await framingAssets(
    // The column is `Json?`, so the shape is a claim rather than a proof — safe because the resolver
    // reads a framing defensively, which is what makes a hand-edited row degrade to "no framing".
    ...rows.map((person) => (person.photoScreens ?? null) as unknown as ScreenFraming | null)
  );

  const people = rows.map((person) => {
    const framing = (person.photoScreens ?? null) as unknown as ScreenFraming | null;
    return {
      ...person,
      picture: pictureFromMap(
        person.photoId,
        framing,
        withBaseAsset(alternates, person.photoId, person.photo)
      )
    };
  });

  return { people, total };
}

/**
 * How many listable people are in each group, in roster order.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS RUNS IN THE SITE LAYOUT, WHICH MEANS IT RUNS ON EVERY PAGE — INCLUDING EVERY PAGE THE BUILD
 * PRERENDERS. Two consequences, both of which this function is shaped by:
 *
 *   • It is wrapped in React `cache()`, so a page that also asks (a group page naming its siblings)
 *     pays for one query per request rather than two.
 *   • AN UNREACHABLE DATABASE MUST NOT THROW. `getNavigation` learnt this the expensive way and says so
 *     in its own header: a throw in the layout failed the WHOLE BUILD, on whichever page Next happened
 *     to prerender first, which is why the failure kept appearing to move between pages. An empty list
 *     here means the header shows "People" with no submenu — exactly what a Centre with nobody
 *     published shows, which is the correct empty state rather than a broken one.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Groups with nobody in them are OMITTED, and that is the requirement rather than an optimisation: every
 * group has a page, always, but the menu only offers the ones that lead to somebody. It is not contract
 * §1.6 truncation either — nothing is being hidden from a list, because an empty group has nothing in it
 * to hide.
 */
export const listablePeopleByGroup = cache(async (): Promise<PersonGroupCount[]> => {
  const rows = await prisma.person
    .groupBy({
      by: ["kind"],
      where: listablePersonWhere(),
      _count: { _all: true }
    })
    .catch((error: unknown) => {
      console.error(
        "[people] the group counts could not be read, so the header menu will show no groups. " +
          `Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      return [] as { kind: PersonKind; _count: { _all: number } }[];
    });

  const counts = new Map<PersonKind, number>();
  for (const row of rows) counts.set(row.kind, row._count._all);

  // Ordered from `PERSON_KIND_ORDER` rather than from the query: Postgres returns groups in whatever
  // order it pleases, and the menu must list them the way every other roster on the site does.
  // A kind the array does not name is appended rather than dropped, so a value added to the enum and
  // forgotten here still reaches the menu (the same rule the directory applies to its headings).
  const ordered: PersonGroupCount[] = [];
  for (const kind of PERSON_KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0) ordered.push({ kind, count });
    counts.delete(kind);
  }
  for (const [kind, count] of counts) {
    if (count > 0) ordered.push({ kind, count });
  }

  return ordered;
});
