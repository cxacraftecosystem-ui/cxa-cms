import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, TriangleAlert, Users } from "lucide-react";

import { CardGrid } from "@/components/site/CardGrid";
import { PageHero } from "@/components/site/PageHero";
import { PersonCard } from "@/components/site/PersonCard";
import { SectionHeading } from "@/components/site/SectionHeading";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  PEOPLE_PATH,
  PERSON_GROUP_DESCRIPTIONS,
  PERSON_GROUP_SLUGS,
  PERSON_KIND_GROUPS,
  personGroupFromSlug,
  personGroupPath
} from "@/lib/people/groups";
import { listablePeopleByGroup, loadRoster, ROSTER_CAP } from "@/lib/people/roster";
import { pageMetadata } from "@/lib/seo";

/**
 * /people/group/[group] — one group of the roster.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS A PAGE, NOT A FILTERED VIEW OF /people, BECAUSE IT IS WHAT GETS LINKED TO.
 *
 * `/people` already filters by role in the browser, and that view is deliberately not a shareable link
 * (PeopleDirectory's header argues why). But "the Centre's faculty" is a thing people link to: it is
 * what a department page points at, what a funder asks for, what somebody sends a colleague. So it has
 * its own title, its own description, its own canonical address and its own place in the header menu —
 * and the roster's in-browser Role filter goes on being the quick way to narrow a list you are already
 * reading.
 *
 * EVERY GROUP HAS A PAGE. A GROUP WITH NOBODY IN IT IS AN EMPTY STATE, NOT A 404. The eight groups are
 * an enum, not records: "Visitors" is a real part of how this Centre is organised whether or not anybody
 * is a visitor this month, and 404ing it would break a link that was correct the day it was written and
 * will be correct again. A slug that names NO group is a different thing — a wrong address — and that is
 * the 404. (The same distinction `news/category/[slug]` draws, in the same words.)
 *
 * ⚠ THE HEADER MENU DOES NOT OFFER AN EMPTY GROUP, AND THIS PAGE STILL EXISTS FOR IT. The menu is built
 * from `listablePeopleByGroup`, which omits groups with nobody in them; this route is built from the
 * enum. The two are meant to disagree — an address that survives and a menu entry that leads somewhere
 * are different promises. What keeps them honest is `generateMetadata` below, which tells crawlers not
 * to index a group that is currently empty rather than advertising a page of nothing.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `/people/group/faculty` CANNOT COLLIDE WITH A PERSON'S PROFILE. `/people/[slug]` matches exactly one
 * segment, so a profile can only ever be reached at `/people/<slug>`; these addresses are two segments
 * deep. A person whose slug is literally "group" still resolves at `/people/group`, because this
 * directory holds no page of its own at that depth. Nothing is reserved and nothing had to be.
 */

/** Five minutes — and it is REQUIRED, not a preference: `loadRoster` reads through `prerenderSafe`,
 *  which prerenders an EMPTY page if the database is unreachable at build time and serves that snapshot
 *  until the next deploy unless a revalidation window replaces it (lib/prerender.ts). */
export const revalidate = 300;

/**
 * Every group's address, prerendered.
 *
 * No `prerenderSafe` here and none needed: this list is the `PersonKind` enum, not a query, so there is
 * no database read that a build could fail on. Every group page is therefore built ahead of time and
 * refreshed on the window above.
 *
 * ⚠ TAKEN FROM `PERSON_GROUP_SLUGS`, NOT FROM `PERSON_KIND_ORDER`, for the reason `personGroupFromSlug`
 * gives at its own iteration: the slug record is a total `Record<PersonKind, string>` and the order
 * array is a hand-kept list. A group added to the enum and forgotten in the order array is still listed
 * by the roster and the menu, which both append what the array omits — prerendering from the array
 * would leave exactly that group without a page.
 */
export function generateStaticParams(): { group: string }[] {
  return Object.values(PERSON_GROUP_SLUGS).map((group) => ({ group }));
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ group: string }>;
}): Promise<Metadata> {
  const { group } = await params;
  const kind = personGroupFromSlug(group);

  // Never `notFound()` from here: this function only produces `<head>`, and throwing in it replaces the
  // page's own 404 with a less useful one. The page body below is what refuses the address.
  if (!kind) {
    return pageMetadata({
      title: "Group not found",
      path: `${PEOPLE_PATH}/group/${group}`,
      noIndex: true
    });
  }

  const label = PERSON_KIND_GROUPS[kind];
  // React `cache()` means this costs nothing here: the page body asks the same question in the same
  // request and gets the same answer without a second query.
  const groups = await listablePeopleByGroup();
  const listed = groups.some((entry) => entry.kind === kind);

  return pageMetadata({
    title: label,
    description: PERSON_GROUP_DESCRIPTIONS[kind],
    path: personGroupPath(kind),
    /*
     * A group with nobody in it is a real page and a thin one. `noIndex` keeps it out of a search
     * engine's results while it is empty — and drops away by itself the moment somebody is published
     * into the group, because this is resolved at read time like everything else on the site.
     */
    noIndex: !listed
  });
}

export default async function PeopleGroupPage({
  params
}: {
  params: Promise<{ group: string }>;
}) {
  const { group } = await params;
  const kind = personGroupFromSlug(group);
  if (!kind) notFound();

  const label = PERSON_KIND_GROUPS[kind];

  const [{ people, total }, groups] = await Promise.all([
    loadRoster(kind),
    listablePeopleByGroup()
  ]);

  // Every other group that has somebody in it — the same list the header menu offers, minus this one.
  const siblings = groups.filter((entry) => entry.kind !== kind);
  const omitted = Math.max(0, total - people.length);

  return (
    <>
      <PageHero
        eyebrow="Directory"
        title={label}
        description={PERSON_GROUP_DESCRIPTIONS[kind]}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "People", href: PEOPLE_PATH },
          { name: label, href: personGroupPath(kind) }
        ]}
        actions={
          <LinkButton href={PEOPLE_PATH} variant="secondary" icon={ArrowLeft}>
            Everyone at the Centre
          </LinkButton>
        }
      />

      <section className="shell pb-24 sm:pb-32">
        {people.length === 0 ? (
          <EmptyState
            // Level 2: this stands where the group's own heading would have been, under the page's h1.
            headingLevel={2}
            icon={Users}
            /*
              ⚠ THE LABEL IS NOT LOWER-CASED. It reads well for seven of the eight groups and turns the
              eighth into "No dc, handicrafts are listed" — an office of the Ministry of Textiles,
              written the way nobody writes it. "Nobody is listed in X" takes the label exactly as the
              rest of the site prints it and reads correctly for all eight.
            */
            title={`Nobody is listed in ${label} at the moment`}
            description="This group is part of how the Centre is organised, and it is ready for whoever joins it. Profiles appear here as soon as they are published and shown in the directory."
            action={
              <LinkButton href={PEOPLE_PATH} variant="secondary">
                See everyone at the Centre
              </LinkButton>
            }
          />
        ) : (
          <>
            <SectionHeading
              level={2}
              title={`${label} at the Centre`}
              // The page's `<h1>` already says the group; this heading exists so the grid sits under
              // something in the document outline rather than being a sibling of the hero.
              titleClassName="sr-only"
            />

            {omitted > 0 ? (
              // The cap, stated on screen (contract §1.6). A group that stops at four hundred looks
              // exactly like a group with four hundred people in it.
              <p className="mb-6 flex items-start gap-2.5 rounded-md border border-line-200 bg-surface-50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
                <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warn-800" />
                <span>
                  This page loads at most {ROSTER_CAP} profiles at once, so {omitted} further{" "}
                  {omitted === 1 ? "person is" : "people are"} not listed here. Search the directory to
                  find someone who is missing.
                </span>
              </p>
            ) : null}

            <CardGrid columns={4} stagger>
              {people.map((person) => (
                <PersonCard
                  key={person.id}
                  person={person}
                  picture={person.picture}
                  headingLevel={3}
                />
              ))}
            </CardGrid>
          </>
        )}

        {siblings.length > 0 ? (
          <nav aria-labelledby="other-groups" className="mt-16 border-t border-line-200 pt-8">
            <h2
              id="other-groups"
              className="display-title text-sm font-semibold uppercase tracking-[0.14em] text-ink-500"
            >
              Other groups
            </h2>

            <ul className="mt-4 flex flex-wrap gap-2">
              {siblings.map((entry) => (
                <li key={entry.kind}>
                  <Link
                    href={personGroupPath(entry.kind)}
                    className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line-200 bg-card px-4 py-2 text-sm font-medium text-ink-700 transition hover:border-purple-200 hover:text-ink-900"
                  >
                    {PERSON_KIND_GROUPS[entry.kind]}
                    <span className="tabular-nums text-ink-300">{entry.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </section>
    </>
  );
}
