/**
 * /about — the Centre's own account of itself.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO SOURCES, ONE ROUTE, AND IT IS A REAL PAGE EITHER WAY.
 *
 *   1. **The page builder.** When a live `Page` row with the slug "about" has visible sections, those
 *      sections ARE this page: an editor who lays out a story in the studio expects to see exactly
 *      that, and a code route that ignored them would be a second, invisible about page.
 *   2. **A composed default.** With no such row — or a row nobody has put any blocks in — the page is
 *      assembled from settings and from the Centre's own records: the leadership and faculty, the
 *      corpus as it stands, and where to find the place. A fresh install must not answer /about with
 *      a blank frame or a 404, because the site header links here from the day it is deployed.
 *
 * ⚠ THE `<h1>` IS OWNED EXACTLY ONCE, AND THAT TAKES TWO QUESTIONS RATHER THAN ONE. Two `<h1>`s and no
 * `<h1>` are both accessibility faults, and this is the one route where which of them happens depends on
 * editor data (contract §11).
 *
 *   • **Is there an opening on this page at all?** No HERO block means the standard `PageHero` supplies
 *     one, visibly, exactly as it does on every other route.
 *   • **Will anything actually render the `<h1>`?** That is `sectionsOwnPageTitle` from
 *     `SectionRenderer`, and it is NOT the same as "a HERO block exists": `HeroSection` renders its
 *     heading only when the headline has words in it, so a hero whose headline is blank draws its
 *     eyebrow, its introduction and its buttons and leaves the page with no heading of any level. When
 *     that happens the title is supplied VISUALLY HIDDEN, because the hero band is already the page's
 *     opening on screen and a second full-width title band above it is an opening no editor asked for.
 *
 * NOTHING HERE INVENTS PROSE. Where a settings field is empty its section is absent rather than filled
 * with a written-in-code paragraph about a Centre this code knows nothing about. The one thing the
 * default path always renders is the row of onward links, so the page is never merely a headline.
 *
 * NO EDITOR-FACING MESSAGE EVER REACHES A VISITOR. There is deliberately no "this page has not been
 * written yet" — that is a message for the Centre, and the studio's own screens are where it belongs
 * (the same asymmetry `SectionRenderer` applies to a broken block).
 *
 * ⚠ THE `leadership` SETTING IS NOT ONLY READ HERE, AND ASSUMING IT WAS IS WHAT MADE IT USELESS. This
 * composed default runs only on the second of the two paths above — no `Page` row, or one with no visible
 * blocks — and every seeded installation has such a row. So for as long as this was the setting's only
 * reader, an administrator could name the Centre's leadership, save it, and find /about unchanged, because
 * the section a visitor was reading came from a PEOPLE_SHOWCASE block that had never heard of it.
 * `peopleShowcaseSectionSchema` now offers "The Centre's leadership list" as a way of choosing, so the
 * BLOCK reads the same setting through `leadershipCuration` in lib/sections/resolve.ts. Both paths answer
 * "who leads the Centre" out of one row; what follows is only about this one.
 *
 * ⚠ THE LEADERSHIP SECTION HAS TWO SOURCES TOO, AND THE CONFIGURED ONE IS ABSOLUTE. The `leadership`
 * settings group is a curation control: while its `personIds` list holds anything, those people in that
 * order ARE the section — any kind of person, no cap, and no truncation sentence, because an administrator
 * who has named eleven people has already answered the question a cap exists to answer. While the list is
 * empty the section is the automatic query it has always been: FACULTY and SCIENTIST, `LEADERSHIP_LIMIT`
 * of them, and the sentence that says so when it bites. Empty is the state every installation starts in,
 * which is what makes the control safe to deploy before anybody has touched it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A SERVER COMPONENT throughout; `Reveal` and `CountUp` are the only client pieces.
 */

import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import type { PageSection, Prisma } from "@prisma/client";
import { ArrowRight, BookOpen, FolderKanban, Mail, MapPin, Microscope, Users } from "lucide-react";

import { CountUp } from "@/components/motion/CountUp";
import { Reveal } from "@/components/motion/Reveal";
import { SectionRenderer, sectionsOwnPageTitle } from "@/components/sections/SectionRenderer";
import { CardGrid } from "@/components/site/CardGrid";
import { DefinitionList, type DefinitionItem } from "@/components/site/DefinitionList";
import { EntityCard } from "@/components/site/EntityCard";
import { PageHero } from "@/components/site/PageHero";
import { SectionHeading } from "@/components/site/SectionHeading";
import { LinkButton } from "@/components/ui/Button";
import { livePublishableWhere, liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { framingAssets, withBaseAsset } from "@/lib/media/framing";
import { pictureFromMap, type ScreenFraming } from "@/lib/media/screens";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { resolveSectionData } from "@/lib/sections/resolve";
import { pageMetadata } from "@/lib/seo";
import { getSettingCached, getSettingsCached } from "@/lib/settings/service";
import { truncateWords } from "@/lib/utils";
import { prerenderSafe } from "@/lib/prerender";
import { SETTINGS_DEFAULTS } from "@/lib/settings/schema";

/**
 * How many faculty the AUTOMATIC list shows. Stated on screen when it bites.
 *
 * ⚠ IT DOES NOT APPLY TO THE CONFIGURED LIST, and that is the point of the setting rather than an
 * oversight. A cap answers "this query could return the whole establishment, so where does the page
 * stop?" — a question a named list has already answered. Capping a curation control would drop the ninth
 * person an administrator deliberately chose, and there is no honest sentence to print underneath it:
 * "showing 8 of the 11 you picked" describes a fault, not a decision.
 */
const LEADERSHIP_LIMIT = 8;

/**
 * Five minutes, matching every other settings-driven public page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS WAS MISSING, AND ITS ABSENCE IS THE SECOND HALF OF "I CHANGED IT AND NOTHING HAPPENED". This
 * route reads no request-scoped input, so Next prerendered it at build and served that one copy for the
 * life of the deployment. Not the leadership list, not the address, not the corpus figures, not a word of
 * an editor's copy would ever change on it again without a redeploy — /contact carries a note saying
 * exactly that about itself, and this page, which reads MORE settings than that one, had no window at all.
 *
 * ⚠ AND `prerenderSafe` BELOW IS NOT ALLOWED TO BE USED WITHOUT ONE. Its own header states the rule and
 * the reason: a page whose data read fell back is prerendered WITH THE FALLBACK, and with no revalidation
 * that snapshot is what visitors get until somebody deploys again. So one bad moment at build time — a
 * database asleep, a network blip — would have published this page with no leadership, no contact details
 * and four zeros where the counts go, permanently, with every check green.
 *
 * Five minutes rather than something shorter because nothing here is time-critical, and rather than
 * something longer because a corrected telephone number or a newly named director should appear while the
 * person who changed it is still at their desk.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const revalidate = 300;

const BREADCRUMBS = [
  { name: "Home", href: "/" },
  { name: "About", href: "/about" }
] as const;

/**
 * The shared media column list, named locally because both the SEO image and the faculty photo use it.
 * It MUST come from lib/media/select.ts: a hand-written copy is how the crop columns came to be stored
 * and never rendered.
 */
const mediaSelect = MEDIA_IMAGE_SELECT satisfies Prisma.MediaAssetSelect;

/**
 * The columns a leadership card needs — written ONCE, because two different queries now feed the same
 * cards and the same framing pass.
 *
 * ⚠ ONE SELECT RATHER THAN TWO COPIES, and the reason is the shape of the bug it prevents. A column added
 * to the automatic query and forgotten in the configured one would leave the section perfect on every
 * installation nobody has curated and quietly wrong on the ones that have — the hardest arrangement to
 * notice, because each half looks complete on its own and the site that is wrong is the site with an
 * administrator who cared enough to configure it. It also keeps the two row types identical, which is what
 * lets `shownPeople` below be either of them without a cast.
 */
const personSelect = {
  id: true,
  slug: true,
  name: true,
  designation: true,
  department: true,
  // The portrait's id and its framing beside the joined row: `pictureFromMap` resolves the base
  // photograph out of the media map BY ID, like any bucket that names an alternate, so a row
  // with the relation and no id cannot be framed at all (lib/media/screens.ts).
  photoId: true,
  photoScreens: true,
  photo: { select: mediaSelect }
} satisfies Prisma.PersonSelect;

/** One card's worth of a person, whichever of the two lists it arrived in. */
type LeadershipPerson = Prisma.PersonGetPayload<{ select: typeof personSelect }>;

/**
 * The `Page` row, memoised for the duration of ONE request.
 *
 * `generateMetadata` and the page component both need it, and React's `cache()` is what makes that one
 * query rather than two.
 *
 * `livePublishableWhere()` and NOT `liveStatusWhere()`: `Page` carries publishAt/unpublishAt, and using
 * the wrong one of the two is a leaked embargo in one direction and a Prisma runtime error in the other
 * (contract §9).
 */
const loadAboutPage = cache(async () =>
  // An unreachable database answers `null`, the same as "no such page" — and this page already
  // composes a complete default when the row is absent. `next build` renders it, so a throw here
  // would fail the deploy; see lib/prerender.ts for the argument at length.
  prisma.page
    .findFirst({
    where: { ...livePublishableWhere(), slug: "about" },
    select: {
      id: true,
      title: true,
      seoTitle: true,
      seoDescription: true,
      seoNoIndex: true,
      canonicalUrl: true,
      publishedAt: true,
      updatedAt: true,
      seoImage: { select: mediaSelect },
      // Full rows: `SectionRenderer` and `resolveSectionData` both take `PageSection` as it comes out
      // of the database, payload included.
      sections: { orderBy: { position: "asc" } }
    }
    })
    .catch((error: unknown) => {
      console.error(
        `[about] the page could not be read, so the built-in default is being shown. ` +
          `Reason: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    })
);

/** Hidden is not deleted: a block an editor switched off is gone from the page and still in the builder. */
function visibleSections(sections: readonly PageSection[]): PageSection[] {
  return sections.filter((section) => section.isVisible);
}

export async function generateMetadata(): Promise<Metadata> {
  const [page, settings] = await Promise.all([loadAboutPage(), getSettingsCached()]);

  if (page) {
    return pageMetadata({
      title: page.seoTitle?.trim() || page.title,
      description: page.seoDescription?.trim() || settings.branding.tagline || null,
      path: "/about",
      image: page.seoImage,
      noIndex: page.seoNoIndex,
      // Set only where an editor genuinely pointed the canonical elsewhere; `pageMetadata` builds the
      // absolute self-canonical otherwise.
      canonicalOverride: page.canonicalUrl?.trim() || undefined,
      type: "article",
      publishedTime: page.publishedAt,
      modifiedTime: page.updatedAt
    });
  }

  return pageMetadata({
    title: "About",
    description:
      settings.branding.tagline ||
      settings.seo.defaultDescription ||
      `${settings.branding.siteName} — its research areas, people and published work.`,
    path: "/about"
  });
}

export default async function AboutPage() {
  const page = await loadAboutPage();
  const sections = page ? visibleSections(page.sections) : [];

  // The builder owns the page whenever it has anything to say. A row that exists with no visible blocks
  // falls through to the composed default rather than rendering a title over an empty page.
  if (page && sections.length > 0) {
    // ONE batched pass for every row every block needs (lib/sections/resolve.ts). No renderer queries.
    const resolved = await resolveSectionData(sections);

    // The two questions from the header. `sections` is already filtered to the visible blocks, so a
    // hero an editor switched off correctly counts as no hero at all.
    const hasHero = sections.some((section) => section.type === "HERO");
    const ownsTitle = sectionsOwnPageTitle(sections);
    const title = page.title.trim();

    return (
      <>
        {hasHero ? null : (
          <PageHero title={page.title} eyebrow="About" breadcrumbs={BREADCRUMBS} />
        )}

        {/*
          The hero is there but its headline is empty, so nothing on the page is an `<h1>`. The page's
          own title — the words the editor gave it in the studio, and the words in the browser tab —
          fills the gap, off screen. Skipped when the title is blank too: an empty `<h1>` is a rung in
          the outline with nothing on it, which is no better than the missing rung it would replace.
        */}
        {hasHero && !ownsTitle && title.length > 0 ? (
          <h1 className="sr-only">{title}</h1>
        ) : null}

        <SectionRenderer sections={sections} resolved={resolved} />
      </>
    );
  }

  return <ComposedAboutPage title={page?.title?.trim() || null} />;
}

/**
 * The CONFIGURED leadership list: the exact people an administrator named, in the order they named them.
 *
 * ⚠ PRISMA ANSWERS AN `in` IN INDEX ORDER, NEVER IN ARGUMENT ORDER. The database returns the matching
 * rows however its index walk found them, which on a curation control is the worst default there is: the
 * ordering IS the content of the setting — who is listed first is a statement — and a page that silently
 * rearranges it reads as a control that does not work rather than as a query with no `ORDER BY`. There is
 * no column to sort on either, because the order lives in the JSON array and nowhere in the `Person` row,
 * so the positions the setting gave are what the rows are sorted back into here.
 *
 * ⚠ THE PUBLICATION FILTERS STILL APPLY. Choosing somebody in settings does not publish them, and a
 * draft, a soft-deleted or a hidden profile must not reach the public site through a second door. Those ids
 * simply resolve to nothing and the person is absent — the same thing that happens to them in every other
 * listing, which is why nothing is said on screen about it.
 *
 * NO `take` AND NO CAP: the ids are already a bounded list — `MAX_LEADERSHIP` is enforced where the
 * setting is saved — so there is no unbounded payload for a cap to protect against, and nothing to state.
 *
 * The settings read costs NOTHING EXTRA. `getSettingCached` goes through the same request-scoped
 * `getSettingsCached` memo the caller below already awaits, so the two see one settings query between them
 * and, being one memo, they cannot disagree halfway down the page about which list is in force.
 */
async function loadCuratedLeadership(
  live: ReturnType<typeof liveStatusWhere>
): Promise<LeadershipPerson[]> {
  const { personIds } = await getSettingCached("leadership");
  // The unconfigured site is the common case and must not pay a round trip to be told what is already
  // known: an empty `in` list matches nothing.
  if (personIds.length === 0) return [];

  const people = await prisma.person.findMany({
    where: { ...live, isVisible: true, id: { in: personIds } },
    select: personSelect
  });

  // Built from the SETTING rather than from the rows, so an id that resolved to nothing costs a gap in the
  // numbering and nothing else — the people either side of a deleted colleague keep their places.
  const position = new Map(personIds.map((id, index) => [id, index] as const));
  // The fallback cannot fire: every row came back from this very list. It is `personIds.length` rather
  // than `0` all the same, because a run of equal keys is a sort that leaves the database's own order
  // untouched — which is precisely the bug this function exists to prevent, wearing a smaller costume.
  return people.sort(
    (left, right) =>
      (position.get(left.id) ?? personIds.length) - (position.get(right.id) ?? personIds.length)
  );
}

/**
 * The default page: settings, the faculty, and the corpus as it stands.
 *
 * Split out as its own async component so the builder path above reads as one decision, and so the reads
 * below are not issued at all on a route the studio has taken over.
 */
async function ComposedAboutPage({ title }: { title: string | null }) {
  const live = liveStatusWhere();

  /**
   * Guarded, because `next build` renders this page and an unreachable database would fail the whole
   * deploy. The fallback is the shipped defaults, no people of either kind and empty counts, and the page
   * below already draws that state honestly, and the `revalidate` window at the top of this file replaces
   * it with the real figures. ⚠ That window is what makes this call legitimate rather than a permanent
   * empty page, and until it was added this comment was describing something that did not exist. See
   * lib/prerender.ts.
   */
  const [
    settings,
    curatedLeadership,
    faculty,
    areaCount,
    projectCount,
    publicationCount,
    peopleCount
  ] = await prerenderSafe(
    "about",
    () =>
      Promise.all([
        getSettingsCached(),
        // BESIDE the automatic query rather than instead of it. Which of the two the page draws is decided
        // by the very setting this call reads, so choosing first would mean awaiting the settings row
        // before any of these queries could start — a serial round trip charged to every visitor in order
        // to save one query on the installations that have curated a list. Both are issued instead, and on
        // a curated site the nine rows the automatic query returns are simply thrown away.
        loadCuratedLeadership(live),
        prisma.person.findMany({
          // The FALLBACK list, in force only while nobody has configured one. FACULTY and SCIENTIST, which
          // is what "leadership" means in a research centre — and `leadershipBlurb` below says exactly
          // that, in so many words, whenever this list is the one on screen, so the SENTENCE under the
          // heading matches the query rather than implying a hierarchy the data does not record. (The
          // heading itself is fixed on both paths; only the sentence beneath it branches.) `isVisible` is
          // a second, editor-facing switch beside publication state: somebody can have a citable page and
          // still be kept out of listings.
          where: { ...live, isVisible: true, kind: { in: ["FACULTY", "SCIENTIST"] } },
          // The editors' own order (`Person.sortOrder`), ties broken on name exactly as that column
          // requires, so the ordering is TOTAL and the row does not reshuffle between requests. It has
          // nothing to do with the configured order above, which is a different question answered in a
          // different place.
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
          // One more than the cap, so "did this list stop early?" is a fact rather than a guess.
          take: LEADERSHIP_LIMIT + 1,
          select: personSelect
        }),
        prisma.researchArea.count({ where: live }),
        prisma.project.count({ where: live }),
        prisma.publication.count({ where: live }),
        prisma.person.count({ where: { ...live, isVisible: true } })
      ]),
    // Positionally matched to the reads above: the shipped defaults, neither leadership list, and zero for
    // every count. `SETTINGS_DEFAULTS` carries an EMPTY `leadership.personIds`, so a build that fell back
    // to this takes the automatic path and finds nothing — which the empty state below says out loud.
    [SETTINGS_DEFAULTS, [], [], 0, 0, 0, 0] as const
  );

  const { branding, contact, seo, leadership } = settings;

  /**
   * Which of the two lists IS the section.
   *
   * ⚠ THE TEST IS ON THE SETTING, NOT ON THE ROWS IT RESOLVED TO. A configured list whose people have all
   * been unpublished is an EMPTY leadership section, not a silent return to the automatic query: the
   * administrator's answer to "who leads this Centre" is still on record, and replacing it with a
   * different set of faces the moment the last chosen one goes out of publication is the reverse of what
   * the control is for — and it would do it without a word on the page or a line in a log.
   */
  const curated = leadership.personIds.length > 0;
  const shownPeople: LeadershipPerson[] = curated
    ? curatedLeadership
    : faculty.slice(0, LEADERSHIP_LIMIT);
  // Only the automatic list can stop early — the configured one is taken whole — so the sentence below is
  // false on the curated path and is not reachable from it. Contract §1.6 cuts both ways: a list that
  // quietly stops must say so, and a list that did not stop must not claim it did.
  const facultyTruncated = !curated && faculty.length > LEADERSHIP_LIMIT;

  /**
   * What the section is allowed to claim about the people under it, which can no longer be one sentence.
   *
   * The automatic list IS the faculty and the scientists, by construction, so it may say exactly that. The
   * configured list is whoever an administrator named — a director, a chair, a chief administrator, a
   * student representative — and describing those people as "the Centre's faculty and scientists" would be
   * this page asserting something about them it has not checked and cannot. Both sentences end on the same
   * pointer to the directory, because either way the section is a selection and /people is the whole answer.
   */
  /**
   * The heading, which CANNOT be fixed once the list is curated.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ "LEADERSHIP AND FACULTY" IS A CLAIM ABOUT THE QUERY, AND ONLY THE AUTOMATIC QUERY MAKES IT TRUE.
   * That one asks for `kind: { in: ["FACULTY", "SCIENTIST"] }`, so the heading and the rows agree by
   * construction. The curated list has NO kind filter at all — deliberately, because an administrator
   * naming the people who lead the Centre may name a director, a chief administrator and a student
   * representative and no faculty member whatsoever, and any mix of categories, including none from a
   * category, has to work. Keeping the old heading over that list would print the word "faculty" above
   * a row of people who are not faculty.
   *
   * So the automatic path keeps the heading that describes it exactly, and the curated path says the
   * one thing that is true of any list an administrator can produce.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const leadershipTitle = curated ? "Leadership" : "Leadership and faculty";

  const leadershipBlurb = curated
    ? "The people the Centre lists as its leadership. Every member of the Centre, including students, staff and visiting researchers, is listed on the people page."
    : "The Centre's faculty and scientists. Every member of the Centre, including students, staff and visiting researchers, is listed on the people page.";

  /**
   * The alternate photographs the shown portraits' framings name, in one query.
   *
   * ⚠ ONLY THE PORTRAITS THAT ARE DRAWN. The automatic query deliberately takes one row more than the cap
   * so the truncation can be stated honestly, and fetching alternates for a face nobody sees would be a
   * query for nothing. Unconditional otherwise, because it costs NO query when nothing is framed — which
   * is nearly always, and a prerender that fell back to `[]` therefore costs nothing (lib/media/framing.ts).
   *
   * It reads `shownPeople`, never either list by name, which is what makes it right for whichever of the
   * two is in force — the configured one included, where every row IS drawn and nothing is spare.
   *
   * The cast is deliberate: `Prisma.JsonValue` carries no shape, the studio's route validates the value
   * with `screenFramingField()` on the way in, and the resolver reads every bucket defensively.
   */
  const shownFramings = shownPeople.map(
    (person) => (person.photoScreens ?? null) as unknown as ScreenFraming | null
  );
  const shownFramingMedia = await framingAssets(...shownFramings);

  const tagline = branding.tagline.trim();
  const description = seo.defaultDescription.trim();
  // The hero takes the tagline where there is one; the standfirst below then carries the longer
  // description. With only one of the two, it is used once and the other section is absent — the same
  // sentence twice, 200px apart, reads as a mistake.
  const heroLede = tagline || description;
  const standfirst = tagline && description ? description : "";

  /** Only the figures that are actually non-zero. See `numbers` below. */
  const numbers = [
    { label: "Research areas", value: areaCount, href: "/research" },
    { label: "Projects", value: projectCount, href: "/projects" },
    { label: "Publications", value: publicationCount, href: "/publications" },
    { label: "People", value: peopleCount, href: "/people" }
  ].filter((entry) => entry.value > 0);

  const address = [
    contact.addressLine1.trim(),
    contact.addressLine2.trim(),
    [contact.city.trim(), contact.state.trim()].filter(Boolean).join(", "),
    contact.postalCode.trim(),
    contact.country.trim()
  ].filter((line) => line.length > 0);

  const contactFacts: DefinitionItem[] = [
    {
      term: "Address",
      value:
        address.length > 0 ? (
          // A `<br>`-separated address would be one string to a screen reader; block spans keep the
          // lines separate without turning the value into a list.
          <>
            {address.map((line, index) => (
              // The lines are assembled here and never reordered, so the index is a stable key.
              <span key={`${line}-${index}`} className="block">
                {line}
              </span>
            ))}
          </>
        ) : undefined
    },
    {
      term: "Email",
      value: contact.email.trim() || undefined,
      href: contact.email.trim() ? `mailto:${contact.email.trim()}` : undefined
    },
    {
      term: "Telephone",
      value: contact.phone.trim() || undefined,
      href: contact.phone.trim() ? `tel:${contact.phone.trim().replace(/\s+/g, "")}` : undefined
    }
  ];

  return (
    <>
      <PageHero
        eyebrow={branding.siteName}
        title={title || "About the Centre"}
        description={heroLede || undefined}
        breadcrumbs={BREADCRUMBS}
      />

      {standfirst ? (
        <section className="shell pb-4">
          <Reveal>
            <p className="prose-measure text-lg leading-relaxed text-ink-700">{standfirst}</p>
          </Reveal>
        </section>
      ) : null}

      {numbers.length > 0 ? (
        // Only rendered when there is something to count, and only the non-zero figures appear. A strip
        // of four zeros on a new installation reads as a broken page rather than as a young Centre —
        // and a "0 publications" tile is a claim about the Centre nobody asked this page to make.
        <section className="shell py-12">
          <Reveal>
            <SectionHeading
              eyebrow="Where things stand"
              title="The Centre in numbers"
              description="Counted from the records published on this site, so these figures move as the work does."
              className="mb-10"
            />
          </Reveal>

          {/* `dl > div > dt/dd` is the shape the HTML content model allows, which is why `Reveal` IS
              the grid item and carries the panel styling rather than wrapping another box inside it. */}
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {numbers.map((entry, index) => (
              <Reveal
                key={entry.label}
                delay={Math.min(index, 8) * 0.05}
                className="panel h-full p-6"
              >
                <dt className="field-label">{entry.label}</dt>
                <dd className="mt-2">
                  {/* `CountUp`'s SSR output is the FINAL value, so the figure is correct with no
                      JavaScript and before the observer fires — a statistic that reads zero until a
                      script runs is simply wrong. */}
                  <CountUp
                    value={String(entry.value)}
                    className="display-title text-3xl sm:text-4xl"
                  />
                  <Link
                    href={entry.href}
                    className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-purple-700 transition-colors hover:text-purple-800"
                  >
                    Browse {entry.label.toLowerCase()}
                    <ArrowRight aria-hidden="true" className="h-4 w-4" />
                  </Link>
                </dd>
              </Reveal>
            ))}
          </dl>
        </section>
      ) : null}

      <section id="leadership" data-anchor="" className="shell py-16 md:py-24">
        <Reveal>
          <SectionHeading
            eyebrow="Who we are"
            title={leadershipTitle}
            description={leadershipBlurb}
            link={{ href: "/people", label: "All people at the Centre" }}
            className="mb-10"
          />
        </Reveal>

        <CardGrid
          columns={4}
          stagger
          empty={{
            icon: Users,
            headingLevel: 3,
            /*
              A curated section that draws nothing is not the same emptiness as an uncurated one, and the
              difference is the entire message. On the automatic path nobody has published a faculty record
              yet; on the curated path somebody HAS chosen people, and their profiles are not published.
              Telling a reader of the second that "names appear here once a faculty record is published"
              describes a Centre that does not exist and a task nobody needs to do.
            */
            title: curated ? "Nobody in this section is published" : "No faculty are listed yet",
            description: curated
              ? "The people this section lists have no published profile at the moment."
              : "Names appear here once a faculty or scientist record is published in the studio."
          }}
        >
          {shownPeople.map((person, index) => (
            <EntityCard
              key={person.id}
              href={`/people/${person.slug}`}
              media={person.photo}
              /* A bucket naming a photograph the map does not hold INHERITS rather than blanking the
                 portrait — the rule `pictureFromMap` owns so no call site writes its own `assetOf`.
                 Nothing framed resolves to one band, which `MediaImage` ignores. */
              picture={pictureFromMap(
                person.photoId,
                shownFramings[index],
                withBaseAsset(shownFramingMedia, person.photoId, person.photo)
              )}
              variant="portrait"
              eyebrow={person.designation?.trim() || undefined}
              title={person.name}
              description={
                person.department?.trim() ? truncateWords(person.department, 90) : undefined
              }
            />
          ))}
        </CardGrid>

        {facultyTruncated ? (
          <p className="mt-8 text-sm text-ink-500">
            Showing {LEADERSHIP_LIMIT} of the Centre’s faculty and scientists. The people page lists
            everyone.
          </p>
        ) : null}
      </section>

      <section id="find-us" data-anchor="" className="shell py-16 md:py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <Reveal>
              <SectionHeading
                eyebrow="Find us"
                title="Where the Centre is"
                description="For anything the pages here do not answer, the contact form reaches the right desk directly."
                className="mb-8"
              />
            </Reveal>

            {/* `DefinitionList` renders nothing at all when every field is empty, so a settings group
                nobody has filled in leaves no heading with a blank space under it. */}
            <DefinitionList items={contactFacts} />

            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/contact" icon={Mail}>
                Get in touch
              </LinkButton>
              {contact.city.trim() ? (
                <LinkButton href="/contact#map" variant="secondary" icon={MapPin}>
                  See the map
                </LinkButton>
              ) : null}
            </div>
          </div>

          {/*
            The onward row. ALWAYS rendered, which is what guarantees this page is a page rather than a
            headline: on an installation with no settings, no people and no records, these four links are
            still true and still useful.
          */}
          <nav aria-labelledby="explore-heading" className="section-band p-8 sm:p-10">
            <h2 id="explore-heading" className="display-title text-xl">
              Explore the Centre
            </h2>
            <ul className="mt-6 grid gap-3">
              {[
                { href: "/research", label: "Research areas", icon: Microscope },
                { href: "/projects", label: "Projects", icon: FolderKanban },
                { href: "/publications", label: "Publications", icon: BookOpen },
                { href: "/people", label: "People", icon: Users }
              ].map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="group flex items-center gap-3 rounded-md border border-line-200 bg-card px-4 py-3 text-sm font-medium text-ink-900 transition duration-200 ease-out hover:border-purple-200 hover:text-purple-700"
                  >
                    <item.icon aria-hidden="true" className="h-4 w-4 shrink-0 text-purple-700" />
                    <span className="flex-1">{item.label}</span>
                    <ArrowRight
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-ink-300 transition-colors group-hover:text-purple-700"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>
    </>
  );
}
