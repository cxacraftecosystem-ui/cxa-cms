import type { Metadata } from "next";
import type { Prisma } from "@prisma/client";

import { PageHero } from "@/components/site/PageHero";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { pageMetadata } from "@/lib/seo";

import { PeopleDirectory } from "./PeopleDirectory";
import { prerenderSafe } from "@/lib/prerender";

/**
 * /people — the Centre's directory.
 *
 * A SERVER COMPONENT that reads the whole roster in one query and hands it to a Client Component which
 * does the searching and filtering in the browser. The roster is bounded by how many people work at a
 * Centre, so there is nothing to page and no request to race: typing is instant, and a reader with no
 * JavaScript still receives every profile, grouped and linked, in the HTML.
 *
 * THE ORDER IS DECIDED HERE, ONCE, AND IT IS TOTAL. `sortOrder` is the editor's arrangement inside a
 * group; `name` breaks a tie (which is the convention the schema documents); `id` breaks the tie
 * `name` cannot — two people with the same sortOrder AND the same name is unusual but not impossible,
 * and without a unique final key Postgres may return them in either order on either request. The
 * reader would see a list that reshuffles itself for no reason, which reads as data changing.
 *
 * The GROUPING is not done in SQL. `ORDER BY kind` would happen to produce the right sequence today,
 * because the required group order matches the declaration order of the enum — but a value inserted
 * into the middle of `PersonKind` in a later migration would silently reorder every group on this page.
 * `PERSON_KIND_ORDER` in components/site/PersonCard.tsx is the answer to "what order are the groups
 * in", and it is code rather than a coincidence.
 */

/**
 * How many profiles are loaded at once.
 *
 * There has to be a number: the entire roster is serialised into the page, so an unbounded query is an
 * unbounded payload. Four hundred is comfortably more than any single Centre's establishment, and when
 * it IS reached the directory says so on screen and names how many are missing (contract §1.6).
 */
const ROSTER_CAP = 400;

const personSelect = {
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
  /**
   * The shared fragment, which carries `variants` — without them `pickVariant` has nothing to choose
   * from and every portrait falls back to the full-size original inside a 320px card.
   */
  photo: { select: MEDIA_IMAGE_SELECT }
} satisfies Prisma.PersonSelect;

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: "People",
    description:
      "The faculty, scientists, researchers, students, staff, visitors and alumni of the Centre of Excellence, with their research interests and publications.",
    path: "/people"
  });
}

/**
 * Refreshed every five minutes rather than frozen at build time.
 *
 * ⚠ REQUIRED BY THE `prerenderSafe` GUARD BELOW, not merely nice to have. A page whose data read fell
 * back at build time is prerendered EMPTY, and without a revalidation window that snapshot would be
 * served until the next deploy. It is also right on its own terms: this page reads content an editor
 * publishes without a deploy, so an infinite-lifetime static page is wrong regardless.
 */
export const revalidate = 300;

export default async function PeoplePage() {
  // `isVisible` is the editor's "show this person in the directory" switch and is separate from
  // publication state: a profile can be published (so its own page resolves, and citations of it keep
  // working) while being kept off the roster. app/sitemap.ts applies the identical pair.
  const where: Prisma.PersonWhereInput = { ...liveStatusWhere(), isVisible: true };

  // The count is a second query rather than `take: CAP + 1`. One extra row would only prove that
  // somebody is missing; the count says how many, which is the difference between "this list stops"
  // and "this list stops and 37 people are not on it".
  const [people, total] = await prerenderSafe(
    "people",
    () =>
      Promise.all([
        prisma.person.findMany({
          where,
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
          take: ROSTER_CAP,
          select: personSelect
        }),
        prisma.person.count({ where })
      ]),
    [[], 0]
  );

  return (
    <>
      <PageHero
        eyebrow="Directory"
        title="People"
        description="The researchers, students and staff of the Centre, and the alumni who built what is here. Search by name, or narrow the list by role, department or research interest."
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "People", href: "/people" }
        ]}
      />

      <section className="shell pb-24 sm:pb-32">
        <PeopleDirectory
          people={people}
          truncated={total > people.length}
          cap={ROSTER_CAP}
          total={total}
        />
      </section>
    </>
  );
}
