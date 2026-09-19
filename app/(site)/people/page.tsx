import type { Metadata } from "next";

import { PageHero } from "@/components/site/PageHero";
import { loadRoster, ROSTER_CAP } from "@/lib/people/roster";
import { pageMetadata } from "@/lib/seo";

import { PeopleDirectory, type DirectoryPerson } from "./PeopleDirectory";

/**
 * /people — the Centre's directory.
 *
 * A SERVER COMPONENT that reads the whole roster in one query and hands it to a Client Component which
 * does the searching and filtering in the browser. The roster is bounded by how many people work at a
 * Centre, so there is nothing to page and no request to race: typing is instant, and a reader with no
 * JavaScript still receives every profile, grouped and linked, in the HTML.
 *
 * THE ORDER, THE CAP, THE "IS THIS PERSON LISTED" PAIR AND THE PORTRAIT FRAMING ALL COME FROM
 * `loadRoster` (lib/people/roster.ts). They used to be written out here, and were then written out
 * again by app/sitemap.ts and would have been written out twice more by the group pages and by the
 * header menu's counts — four hand-kept copies of one predicate, which is three chances for a withdrawn
 * profile to reappear on one surface. That module's header carries the argument in full.
 *
 * THE GROUPING IS NOT DONE IN SQL. `ORDER BY kind` would happen to produce the right sequence today,
 * because the required group order matches the declaration order of the enum — but a value inserted
 * into the middle of `PersonKind` in a later migration would silently reorder every group on this page.
 * `PERSON_KIND_ORDER` in lib/people/groups.ts is the answer to "what order are the groups in", and it
 * is code rather than a coincidence.
 */

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
 * ⚠ REQUIRED BY THE `prerenderSafe` GUARD INSIDE `loadRoster`, not merely nice to have. A page whose
 * data read fell back at build time is prerendered EMPTY, and without a revalidation window that
 * snapshot would be served until the next deploy. It is also right on its own terms: this page reads
 * content an editor publishes without a deploy, so an infinite-lifetime static page is wrong regardless.
 */
export const revalidate = 300;

export default async function PeoplePage() {
  const { people, total } = await loadRoster();

  const roster: DirectoryPerson[] = people;

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
          people={roster}
          truncated={total > people.length}
          cap={ROSTER_CAP}
          total={total}
        />
      </section>
    </>
  );
}
