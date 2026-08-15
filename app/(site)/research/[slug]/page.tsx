/**
 * /research/[slug] — one research area: what it is, what is running inside it, what it has published,
 * who works in it, and where it touches the rest of the Centre.
 *
 * A SERVER COMPONENT reading Prisma directly (contract §9). Nothing on this page is interactive, so it
 * ships no JavaScript of its own beyond `Reveal`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PEOPLE ROW IS DERIVED, AND THE PAGE SAYS SO.
 *
 * `ResearchArea` has no people relation, because a person does not belong to an area — they belong to
 * projects, and projects belong to areas. So this list is assembled from project membership and
 * de-duplicated, and each card says how many projects in this area that person is on. A page that
 * presented a derived list as a roster would be inventing an affiliation the Centre never recorded, so
 * the section's description states where the list comes from.
 *
 * THE MEMBERSHIP SCAN IS CAPPED AND THE CAP IS STATED. De-duplication happens in this process, so the
 * only honest thing a capped scan can say is how many membership rows it read (contract §1.6).
 *
 * RELATED AREAS ARE COMPUTED, NOT CURATED — there is no relation in the schema to curate. The row shows
 * the areas that share a researcher with this one, which is a real relationship this page can prove;
 * when there are none it falls back to the Centre's other areas and CHANGES ITS HEADING, so the row
 * never claims a connection that does not exist. It draws through `components/site/RelatedContent`,
 * the same block that ends the project and craft pages, and adds NO query of its own — its two
 * candidate lists are already part of the `Promise.all` below. This area's projects and its
 * publications are not in it: both have their own full sections above, and a related block that
 * repeated them would be a second, shorter copy of a list the reader has just scrolled past.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `revalidate` IS SET DELIBERATELY. This page reads no request-scoped input, so without it Next would
 * render it once on first request and serve that copy for the life of the deployment — an area renamed,
 * rewritten or retired in the studio would never reach a reader. Publication state is resolved at read
 * time (lib/content.ts), so the window below is also the longest anything here can be stale.
 */

import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma, ProjectStatus, PublicationKind } from "@prisma/client";
import {
  ArrowRight,
  BookOpen,
  CircleCheckBig,
  CirclePause,
  CirclePlay,
  FolderKanban,
  Lightbulb,
  Microscope,
  Users,
  type LucideIcon
} from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { CardGrid } from "@/components/site/CardGrid";
import { EntityCard } from "@/components/site/EntityCard";
import { PageHero } from "@/components/site/PageHero";
import { ProjectProgress } from "@/components/site/ProjectProgress";
import { ProseArticle } from "@/components/site/ProseArticle";
import { RelatedContent, type RelatedItem } from "@/components/site/RelatedContent";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { publicationDisplayVenue } from "@/lib/citation";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { parseRichText, richTextExcerpt } from "@/lib/richtext";
import { pageMetadata } from "@/lib/seo";
import { truncateWords } from "@/lib/utils";

/** Five minutes. Long enough to be worth caching, short enough that a correction is not a mystery. */
export const revalidate = 300;

/** Caps. Each one is stated on screen at the place it applies. */
const PROJECT_LIMIT = 9;
const PUBLICATION_LIMIT = 8;
/**
 * How many `ProjectMember` rows the people list is derived from. Rows, not people: the same person
 * appears once per project, so this is not a limit on the number of names.
 */
const MEMBERSHIP_SCAN_LIMIT = 200;
/** Two full rows of the three-column related grid. Both of its queries take one more than this. */
const RELATED_LIMIT = 6;

/**
 * Everything `<MediaImage>` needs.
 *
 * `variants` is not optional: without it `pickVariant` has nothing to choose from and every image falls
 * back to the full-size ORIGINAL — a 6 MB photograph inside a 320px card. Written out here rather than
 * imported because lib/sections/resolve.ts keeps its copy private.
 */
const mediaSelect = {
  objectKey: true,
  width: true,
  height: true,
  altText: true,
  blurDataUrl: true,
  variants: { select: { label: true, format: true, objectKey: true, width: true } }
} satisfies Prisma.MediaAssetSelect;

const projectCardSelect = {
  id: true,
  slug: true,
  title: true,
  tagline: true,
  summary: true,
  state: true,
  progress: true,
  startedOn: true,
  endedOn: true,
  cover: { select: mediaSelect }
} satisfies Prisma.ProjectSelect;

type ProjectCardRow = Prisma.ProjectGetPayload<{ select: typeof projectCardSelect }>;

/**
 * Wider than the row looks, because `publicationDisplayVenue` reads volume, issue, publisher and the
 * identifier columns to punctuate one line correctly. Trimming this to "what is visible" would
 * silently degrade every reference on the page.
 */
const publicationRowSelect = {
  id: true,
  slug: true,
  kind: true,
  title: true,
  authorLine: true,
  venue: true,
  publisher: true,
  volume: true,
  issue: true,
  pages: true,
  year: true,
  month: true,
  doi: true,
  isbn: true,
  issn: true,
  patentNumber: true,
  arxivId: true,
  url: true
} satisfies Prisma.PublicationSelect;

type PublicationRow = Prisma.PublicationGetPayload<{ select: typeof publicationRowSelect }>;

const personCardSelect = {
  id: true,
  slug: true,
  name: true,
  designation: true,
  department: true,
  photo: { select: mediaSelect }
} satisfies Prisma.PersonSelect;

type PersonCardRow = Prisma.PersonGetPayload<{ select: typeof personCardSelect }>;

/**
 * The stage, as a word, a glyph and a tone — in that order of importance. Colour never carries the
 * meaning alone (contract §11).
 *
 * ⚠ The wording must stay in step with components/sections/ProjectShowcaseSection.tsx and
 * app/(site)/projects. One project cannot be "Active" here and "In progress" there.
 */
const STAGE: Record<ProjectStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  PROPOSED: { label: "Proposed", tone: "neutral", icon: Lightbulb },
  ACTIVE: { label: "Active", tone: "info", icon: CirclePlay },
  COMPLETED: { label: "Completed", tone: "success", icon: CircleCheckBig },
  ON_HOLD: { label: "On hold", tone: "warn", icon: CirclePause }
};

/** The words a reader uses. The chip carries the kind so the title does not have to. */
const KIND_LABEL: Record<PublicationKind, string> = {
  JOURNAL_ARTICLE: "Journal article",
  CONFERENCE_PAPER: "Conference paper",
  BOOK: "Book",
  BOOK_CHAPTER: "Book chapter",
  PATENT: "Patent",
  DATASET: "Dataset",
  SOFTWARE: "Software",
  PREPRINT: "Preprint",
  THESIS: "Thesis",
  REPORT: "Report"
};

/**
 * The area, memoised for the duration of ONE request.
 *
 * `generateMetadata` and the page component both need it, and React's `cache()` is what makes that one
 * query instead of two. Per-render, not time-based: an editor who publishes a change sees it on the
 * next request with no revalidation call.
 */
const loadArea = cache(async (slug: string) => {
  const live = liveStatusWhere();
  return prisma.researchArea.findFirst({
    // The publication filter is not optional and is never hand-rolled (contract §9). A draft area must
    // 404 rather than be readable by anyone who guesses its slug.
    where: { ...live, slug },
    select: {
      id: true,
      slug: true,
      title: true,
      summary: true,
      body: true,
      accentColor: true,
      publishedAt: true,
      updatedAt: true,
      cover: { select: mediaSelect },
      // Filtered counts, so the figures agree with the lists below and no draft is advertised.
      _count: { select: { projects: { where: live }, publications: { where: live } } }
    }
  });
});

interface AreaPageProps {
  /** Next 15 hands route params in as a promise. */
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: AreaPageProps): Promise<Metadata> {
  const { slug } = await params;
  const area = await loadArea(slug);

  if (!area) {
    // The page itself calls `notFound()`. Metadata is still produced, because a 404 whose `<head>`
    // carries the previous page's title is worse than a plain one — and there is nothing to index.
    return pageMetadata({
      title: "Research area not found",
      path: `/research/${slug}`,
      noIndex: true
    });
  }

  return pageMetadata({
    title: area.title,
    // The summary is the editor's own one-liner; the body's opening sentences are the fallback, so a
    // share card is never blank merely because nobody filled in the summary field.
    description: area.summary?.trim() || richTextExcerpt(parseRichText(area.body), 200) || null,
    path: `/research/${area.slug}`,
    image: area.cover,
    type: "article",
    publishedTime: area.publishedAt,
    modifiedTime: area.updatedAt
  });
}

export default async function ResearchAreaPage({ params }: AreaPageProps) {
  const { slug } = await params;
  const area = await loadArea(slug);
  if (!area) notFound();

  const live = liveStatusWhere();

  const [projects, publications, memberships, sharingAreas, otherAreas] = await Promise.all([
    prisma.project.findMany({
      where: { ...live, researchAreaId: area.id },
      // Featured first, then most recently started — the same ordering the projects index uses, so a
      // project does not change position between the two pages. `nulls: "last"` is load-bearing:
      // Postgres sorts NULLs FIRST on a DESC order, so a project with no start date would otherwise
      // head a list ordered by recency.
      orderBy: [
        { isFeatured: "desc" },
        { startedOn: { sort: "desc", nulls: "last" } },
        { id: "asc" }
      ],
      take: PROJECT_LIMIT,
      select: projectCardSelect
    }),
    prisma.publication.findMany({
      where: { ...live, researchAreaId: area.id },
      orderBy: [{ year: "desc" }, { month: { sort: "desc", nulls: "last" } }, { title: "asc" }],
      take: PUBLICATION_LIMIT,
      select: publicationRowSelect
    }),
    prisma.projectMember.findMany({
      // A person is in this list because a PUBLISHED project of theirs sits in this area and their own
      // record is published and visible. `isVisible` is a second, editor-facing switch beside
      // publication state: somebody can have a citable page and still be kept out of every listing.
      where: {
        project: { ...live, researchAreaId: area.id },
        person: { ...live, isVisible: true }
      },
      orderBy: [{ person: { sortOrder: "asc" } }, { person: { name: "asc" } }, { personId: "asc" }],
      // One more than the cap, so "did this scan stop early?" is a fact rather than a guess.
      take: MEMBERSHIP_SCAN_LIMIT + 1,
      select: { personId: true, person: { select: personCardSelect } }
    }),
    // Areas that share at least one researcher with this one, through published projects on both
    // sides. A real relationship, computed — see the header.
    prisma.researchArea.findMany({
      where: {
        ...live,
        id: { not: area.id },
        projects: {
          some: {
            ...live,
            members: {
              some: { person: { ...live, isVisible: true, projects: { some: { project: { ...live, researchAreaId: area.id } } } } }
            }
          }
        }
      },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }, { id: "asc" }],
      // One more than the cap, so "are there more of these?" is a fact rather than a guess.
      take: RELATED_LIMIT + 1,
      select: { id: true, slug: true, title: true, summary: true }
    }),
    // The fallback row. Fetched unconditionally so both possibilities cost ONE round trip together;
    // it is discarded when the computed row above found anything.
    prisma.researchArea.findMany({
      where: { ...live, id: { not: area.id } },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }, { id: "asc" }],
      take: RELATED_LIMIT + 1,
      select: { id: true, slug: true, title: true, summary: true }
    })
  ]);

  const membershipScanTruncated = memberships.length > MEMBERSHIP_SCAN_LIMIT;
  const scanned = memberships.slice(0, MEMBERSHIP_SCAN_LIMIT);

  // De-duplicate to people, counting how many projects in THIS area each one is on. First-seen order
  // is the query's order, which is the curated people order.
  const peopleById = new Map<string, { person: PersonCardRow; projectCount: number }>();
  for (const row of scanned) {
    const existing = peopleById.get(row.personId);
    if (existing) existing.projectCount += 1;
    else peopleById.set(row.personId, { person: row.person, projectCount: 1 });
  }
  const people = [...peopleById.values()];

  const projectTotal = area._count.projects;
  const publicationTotal = area._count.publications;
  const projectsHidden = Math.max(0, projectTotal - projects.length);
  const publicationsHidden = Math.max(0, publicationTotal - publications.length);

  const relatedIsComputed = sharingAreas.length > 0;
  const relatedPool = relatedIsComputed ? sharingAreas : otherAreas;
  /** Both queries took one row more than the cap, so this is a fact and gets said on screen below. */
  const relatedTruncated = relatedPool.length > RELATED_LIMIT;

  const relatedItems: RelatedItem[] = relatedPool.slice(0, RELATED_LIMIT).map((other) => ({
    href: `/research/${other.slug}`,
    kind: "Research area",
    title: other.title,
    // Truncated on the SERVER: a CSS line clamp hides the tail from sighted readers while leaving it
    // in the accessibility tree, so the two disagree about what the card says.
    summary: other.summary ? truncateWords(other.summary, 140) : undefined
  }));

  return (
    <>
      <PageHero
        // The dark band is for an area with a photograph behind it; without one the light tone keeps
        // the page from opening on a flat rectangle. PageHero treats `media` differently in each.
        tone={area.cover ? "dark" : "light"}
        eyebrow="Research area"
        title={area.title}
        description={area.summary?.trim() || undefined}
        media={area.cover}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Research", href: "/research" },
          { name: area.title, href: `/research/${area.slug}` }
        ]}
        meta={
          <>
            <span className="tabular-nums">
              {projectTotal} {projectTotal === 1 ? "project" : "projects"}
            </span>
            <span className="tabular-nums">
              {publicationTotal} {publicationTotal === 1 ? "publication" : "publications"}
            </span>
            {/* The researcher count is omitted when the membership scan hit its cap: a number in a
                hero has no room for the caveat that would make an undercount honest, and the people
                section below states the cap where it applies. */}
            {people.length > 0 && !membershipScanTruncated ? (
              <span className="tabular-nums">
                {people.length} {people.length === 1 ? "researcher" : "researchers"}
              </span>
            ) : null}
          </>
        }
      />

      {/* The body. `ProseArticle` holds it to the 68ch reading measure and renders NOTHING when the
          document is empty — no fallback copy, because the hero has already said what this area is. */}
      <div className="shell py-4">
        <ProseArticle value={area.body} />
      </div>

      <section id="projects" data-anchor="" className="shell py-16 md:py-24">
        <Reveal>
          <SectionHeading
            title="Projects in this area"
            description="Work published under this strand, featured first and then most recently started."
            link={
              projectTotal > 0
                ? {
                    href: `/projects?area=${encodeURIComponent(area.slug)}`,
                    label: `All ${projectTotal} ${projectTotal === 1 ? "project" : "projects"} in this area`
                  }
                : undefined
            }
            className="mb-10"
          />
        </Reveal>

        <CardGrid
          columns={3}
          stagger
          empty={{
            icon: FolderKanban,
            headingLevel: 3,
            title: "No projects have been published in this area yet",
            description:
              "Projects appear here once one is published against this area in the studio. The area's publications and people may still be listed below."
          }}
        >
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </CardGrid>

        {projectsHidden > 0 ? (
          <p className="mt-8 text-sm text-ink-500">
            Showing {projects.length} of {projectTotal} projects.{" "}
            <Link
              href={`/projects?area=${encodeURIComponent(area.slug)}`}
              className="font-medium text-purple-700 hover:text-purple-800"
            >
              See the other {projectsHidden}
            </Link>
            .
          </p>
        ) : null}
      </section>

      <section id="publications" data-anchor="" className="shell py-16 md:py-24">
        <Reveal>
          <SectionHeading
            title="Publications"
            description="Papers, chapters, datasets and patents recorded against this area, newest first."
            className="mb-10"
          />
        </Reveal>

        {publications.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            headingLevel={3}
            title="No publications have been recorded in this area yet"
            description="Published work appears here as it is added to the Centre's bibliography."
          />
        ) : (
          <ul className="divide-y divide-line-200 border-y border-line-200">
            {publications.map((publication) => (
              <li key={publication.id}>
                <PublicationRowItem publication={publication} />
              </li>
            ))}
          </ul>
        )}

        {publicationsHidden > 0 ? (
          <p className="mt-6 text-sm text-ink-500">
            Showing the {publications.length} most recent of {publicationTotal} publications in this
            area.{" "}
            <Link href="/publications" className="font-medium text-purple-700 hover:text-purple-800">
              Search the full bibliography
            </Link>
            .
          </p>
        ) : null}
      </section>

      <section id="people" data-anchor="" className="shell py-16 md:py-24">
        <Reveal>
          <SectionHeading
            title="People working in this area"
            // Says where the list comes from, because it is derived rather than recorded — see the
            // header. A reader who knows how it was built can tell what its absences mean.
            description="Drawn from the teams of the published projects above, so somebody appears here because of the work they are on rather than a label attached to them."
            className="mb-10"
          />
        </Reveal>

        <CardGrid
          columns={4}
          stagger
          empty={{
            icon: Users,
            headingLevel: 3,
            title: "No people are listed against this area yet",
            description:
              "Names appear here once a published project in this area has a published team member on it."
          }}
        >
          {people.map(({ person, projectCount }) => (
            <EntityCard
              key={person.id}
              href={`/people/${person.slug}`}
              media={person.photo}
              variant="portrait"
              title={person.name}
              eyebrow={person.designation?.trim() || undefined}
              description={person.department?.trim() || undefined}
              meta={
                <span className="tabular-nums">
                  {projectCount} {projectCount === 1 ? "project" : "projects"} in this area
                </span>
              }
            />
          ))}
        </CardGrid>

        {membershipScanTruncated ? (
          <p className="mt-8 text-sm text-ink-500">
            This list is worked out from the first {MEMBERSHIP_SCAN_LIMIT} project memberships in this
            area, so a few more people may work in it than are shown here. Each project page lists its
            own full team.
          </p>
        ) : null}
      </section>

      {/*
        The heading CHANGES with the list, because the two lists are different claims: one is "these
        areas share a researcher with this one", the other is "nothing shares a researcher, so here is
        the rest of the Centre". `RelatedContent` renders nothing at all when both come back empty — on
        a site with exactly one research area, an "Other research areas" heading over an empty grid
        would be the only thing this section could say, and it would be worse than silence.

        The stopping point is stated rather than left to look like the end of the archive (contract
        §1.6): both queries took one row more than the cap, so `relatedTruncated` is a fact.
      */}
      <RelatedContent
        className="shell py-16 md:py-24"
        heading={
          relatedIsComputed ? "Areas that share researchers with this one" : "Other research areas"
        }
        description={
          relatedIsComputed
            ? "Worked out from the people on this area's projects: each of these areas has at least one researcher in common with it."
            : "No other area currently shares a researcher with this one. These are the Centre's other strands of work."
        }
        items={relatedItems}
        link={{ href: "/research", label: "All research areas" }}
        more={
          relatedTruncated
            ? {
                note: relatedIsComputed
                  ? `More than these ${RELATED_LIMIT} areas share a researcher with this one.`
                  : `The Centre has more than these ${RELATED_LIMIT} other areas.`,
                href: "/research",
                label: "See every research area"
              }
            : undefined
        }
      />

      <section className="shell pb-20 md:pb-28">
        <div className="section-band flex flex-col items-start gap-4 p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div>
            <h2 className="display-title text-xl sm:text-2xl">Looking for something specific?</h2>
            <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-500">
              Every project, paper and person at the Centre is listed and searchable, across all of its
              research areas.
            </p>
          </div>
          <LinkButton
            href="/research"
            variant="secondary"
            icon={Microscope}
            iconPosition="start"
          >
            Browse every research area
          </LinkButton>
        </div>
      </section>
    </>
  );
}

/**
 * A year range as a person would write it.
 *
 * Rendered in UTC: `startedOn` and `endedOn` are calendar dates rather than instants, and formatting a
 * stored midnight in a zone west of UTC moves it back a day — which for a January start moves it back
 * a YEAR.
 */
function yearOf(value: Date | null): string | null {
  if (!value) return null;
  const year = value.getUTCFullYear();
  return Number.isFinite(year) ? String(year) : null;
}

function periodOf(project: ProjectCardRow): string | null {
  const from = yearOf(project.startedOn);
  const to = yearOf(project.endedOn);
  if (from && to) return from === to ? from : `${from}–${to}`;
  if (from) return project.state === "COMPLETED" ? from : `${from}–`;
  return to;
}

function ProjectCard({ project }: { project: ProjectCardRow }) {
  const stage = STAGE[project.state];
  const period = periodOf(project);
  const summary = project.tagline?.trim() || project.summary?.trim() || "";

  return (
    <EntityCard
      href={`/projects/${project.slug}`}
      media={project.cover}
      title={project.title}
      description={summary ? truncateWords(summary, 170) : undefined}
      meta={
        <>
          <Badge tone={stage.tone} icon={stage.icon} size="sm">
            {stage.label}
          </Badge>
          {period ? <span className="tabular-nums">{period}</span> : null}
        </>
      }
      footer={
        // Renders nothing at all when progress is 0 — "not tracked" and "not started" are different
        // claims and only one of them is true (components/site/ProjectProgress.tsx).
        <ProjectProgress progress={project.progress} projectTitle={project.title} size="sm" />
      }
    />
  );
}

/**
 * One publication, as a row.
 *
 * The TITLE is the link and the row is not: the author line and the venue are text a reader copies out
 * of a bibliography, and a whole-row link makes selecting them a navigation instead.
 */
function PublicationRowItem({ publication }: { publication: PublicationRow }) {
  const venue = publicationDisplayVenue(publication);

  return (
    <article className="flex flex-col gap-2 py-5 sm:flex-row sm:items-baseline sm:gap-6">
      <p className="shrink-0 font-display text-sm font-semibold tabular-nums text-ink-500 sm:w-16">
        {publication.year}
      </p>

      <div className="min-w-0 flex-1">
        <h3 className="text-base font-semibold leading-snug text-ink-900">
          <Link
            href={`/publications/${publication.slug}`}
            className="rounded transition-colors hover:text-purple-700"
          >
            {publication.title}
          </Link>
        </h3>

        <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{publication.authorLine}</p>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-500">
          <Badge size="sm">{KIND_LABEL[publication.kind]}</Badge>
          {venue ? <span>{venue}</span> : null}
        </div>
      </div>

      <ArrowRight
        aria-hidden="true"
        className="hidden h-4 w-4 shrink-0 self-center text-ink-300 sm:block"
      />
    </article>
  );
}
