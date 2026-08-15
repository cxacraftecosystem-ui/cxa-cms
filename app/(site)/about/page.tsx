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
import { resolveSectionData } from "@/lib/sections/resolve";
import { pageMetadata } from "@/lib/seo";
import { getSettingsCached } from "@/lib/settings/service";
import { truncateWords } from "@/lib/utils";
import { prerenderSafe } from "@/lib/prerender";
import { SETTINGS_DEFAULTS } from "@/lib/settings/schema";

/** How many faculty the default page shows. Stated on screen when it bites. */
const LEADERSHIP_LIMIT = 8;

const BREADCRUMBS = [
  { name: "Home", href: "/" },
  { name: "About", href: "/about" }
] as const;

const mediaSelect = {
  objectKey: true,
  width: true,
  height: true,
  altText: true,
  blurDataUrl: true,
  variants: { select: { label: true, format: true, objectKey: true, width: true } }
} satisfies Prisma.MediaAssetSelect;

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
 * The default page: settings, the faculty, and the corpus as it stands.
 *
 * Split out as its own async component so the builder path above reads as one decision, and so the four
 * reads below are not issued at all on a route the studio has taken over.
 */
async function ComposedAboutPage({ title }: { title: string | null }) {
  const live = liveStatusWhere();

  /**
   * Guarded, because `next build` renders this page and an unreachable database would fail the whole
   * deploy. The fallback is the shipped defaults plus empty counts, and the page below already draws
   * that state honestly — a `revalidate` window replaces it with the real figures. See lib/prerender.ts.
   */
  const [settings, faculty, areaCount, projectCount, publicationCount, peopleCount] =
    await prerenderSafe(
      "about",
      () =>
        Promise.all([
        getSettingsCached(),
        prisma.person.findMany({
          // FACULTY and SCIENTIST, which is what "leadership" means in a research centre — and the
          // section is labelled with exactly that, so the heading matches the query rather than implying a
          // hierarchy the data does not record. `isVisible` is a second, editor-facing switch beside
          // publication state: somebody can have a citable page and still be kept out of every listing.
          where: { ...live, isVisible: true, kind: { in: ["FACULTY", "SCIENTIST"] } },
          // The curated order, ties broken on name exactly as `Person.sortOrder` requires, so the
          // ordering is TOTAL and the row does not reshuffle between requests.
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
          // One more than the cap, so "did this list stop early?" is a fact rather than a guess.
          take: LEADERSHIP_LIMIT + 1,
          select: {
            id: true,
            slug: true,
            name: true,
            designation: true,
            department: true,
            photo: { select: mediaSelect }
          }
        }),
        prisma.researchArea.count({ where: live }),
        prisma.project.count({ where: live }),
        prisma.publication.count({ where: live }),
        prisma.person.count({ where: { ...live, isVisible: true } })

        ]),
      [SETTINGS_DEFAULTS, [], 0, 0, 0, 0] as const
    );

  const { branding, contact, seo } = settings;

  const facultyTruncated = faculty.length > LEADERSHIP_LIMIT;
  const shownFaculty = faculty.slice(0, LEADERSHIP_LIMIT);

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
            title="Leadership and faculty"
            description="The Centre's faculty and scientists. Every member of the Centre, including students, staff and visiting researchers, is listed on the people page."
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
            title: "No faculty are listed yet",
            description:
              "Names appear here once a faculty or scientist record is published in the studio."
          }}
        >
          {shownFaculty.map((person) => (
            <EntityCard
              key={person.id}
              href={`/people/${person.slug}`}
              media={person.photo}
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
