/**
 * /projects — every published project, filtered by stage, research area and start year.
 *
 * A SERVER COMPONENT reading Prisma directly (contract §9). `FilterBar` is the only client piece, and
 * it carries its own `<Suspense>` boundary, so the listing beside it is server-rendered from
 * `searchParams` and is fully present for a reader with no JavaScript — they simply cannot change it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE URL IS THE STATE, AND THE FILTERS ARE VALIDATED AGAINST IT.
 *
 * Every filter is a query parameter, so a filtered view is a link somebody can send. A parameter can
 * therefore arrive hand-edited, stale, or pointing at a research area that has since been unpublished —
 * and the rule for all three is the same: THE VALUE IS IGNORED AND THE PAGE SAYS SO. The alternatives
 * are both worse. Applying an unknown stage returns an empty list with no visible cause, and silently
 * dropping it leaves `FilterBar` showing a chip that is narrowing nothing.
 *
 * `?page=` PAST THE END IS NOT AN EMPTY LIST. A stale bookmark to page nine of a list that now has
 * three is answered with a sentence saying so and a way back to the first page — not with "No projects
 * match these filters", which is a different fact and a discouraging one (contract §1.6).
 *
 * THE YEAR FILTER IS THE START YEAR, and the group is labelled "Start year" so that is on screen rather
 * than inferred. "Running in 2024" is a different question, and a filter that answers a question the
 * reader did not ask is worse than one that answers a narrower one plainly.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE ENTRANCE IS TWO PIECES AND DELIBERATELY NO MORE: `CardGrid`'s capped stagger for the cards, and
 * one `Reveal` for the pager beneath them — the same pair /news, /gallery, /events and /publications
 * carry, so a reader walking the listings meets one page rather than five that were each decided on
 * separately.
 *
 * NOTHING ABOVE THE GRID MOVES. The filter row, the ignored-parameter notice and the two truncation
 * notes all have to be readable the instant the page arrives: a sentence explaining that a filter was
 * thrown away is worth nothing if it fades in after the reader has looked past it. They are also at the
 * top of the page, where an entrance is a delay rather than an arrival.
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma, ProjectStatus } from "@prisma/client";
import {
  CircleCheckBig,
  CirclePause,
  CirclePlay,
  FolderKanban,
  Lightbulb,
  TriangleAlert,
  type LucideIcon
} from "lucide-react";

import { Reveal } from "@/components/motion";
import { CardGrid } from "@/components/site/CardGrid";
import { EntityCard } from "@/components/site/EntityCard";
import { FilterBar, type FilterGroup } from "@/components/site/FilterBar";
import { PageHero } from "@/components/site/PageHero";
import { ProjectProgress } from "@/components/site/ProjectProgress";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { Pagination } from "@/components/ui/Pagination";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { MEDIA_IMAGE_SELECT } from "@/lib/media/select";
import { pageMetadata } from "@/lib/seo";
import { truncateWords, unique } from "@/lib/utils";
import { prerenderSafe } from "@/lib/prerender";

const PAGE_SIZE = 12;
/** Enough research areas for any real Centre; a truncated filter list is stated on screen. */
const AREA_OPTION_LIMIT = 60;
/**
 * How many projects the year list is derived from. Scanned newest-first, so a truncated scan loses the
 * OLDEST years — which is what the note below says.
 */
const YEAR_SCAN_LIMIT = 500;

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: "Projects",
    description:
      "The Centre's research projects — active, completed, proposed and on hold — with their funding, teams and outputs.",
    // Deliberately the BARE path, whatever filters are applied. A canonical that carried the query
    // string would let `?year=2024` be indexed as a page competing with its own parent (lib/seo.ts).
    path: "/projects"
  });
}

/**
 * The stage, as a word, a glyph and a tone — in that order of importance. Colour never carries the
 * meaning alone (contract §11).
 *
 * ⚠ The wording must stay in step with components/sections/ProjectShowcaseSection.tsx and the research
 * area page. One project cannot be "Active" here and "In progress" there.
 */
const STAGE: Record<ProjectStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  PROPOSED: { label: "Proposed", tone: "neutral", icon: Lightbulb },
  ACTIVE: { label: "Active", tone: "info", icon: CirclePlay },
  COMPLETED: { label: "Completed", tone: "success", icon: CircleCheckBig },
  ON_HOLD: { label: "On hold", tone: "warn", icon: CirclePause }
};

/** Chip order: what is running now leads, because that is what most readers came for. */
const STAGE_ORDER: readonly ProjectStatus[] = ["ACTIVE", "COMPLETED", "PROPOSED", "ON_HOLD"];

function isProjectStatus(value: string): value is ProjectStatus {
  return (STAGE_ORDER as readonly string[]).includes(value);
}

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
  isFeatured: true,
  cover: { select: MEDIA_IMAGE_SELECT },
  researchArea: { select: { slug: true, title: true } }
} satisfies Prisma.ProjectSelect;

type ProjectCardRow = Prisma.ProjectGetPayload<{ select: typeof projectCardSelect }>;

/**
 * The first value of a repeated parameter.
 *
 * A single-value filter with two values in the URL is a hand-edited or stale link; the first one wins,
 * so the controls and the listing cannot disagree about what is selected. `FilterBar` reads the query
 * string by exactly the same rule.
 */
function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return typeof value === "string" ? value.trim() : "";
}

interface ProjectsPageProps {
  /** Next 15 hands the query string in as a promise. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Refreshed every five minutes rather than frozen at build time.
 *
 * ⚠ REQUIRED BY THE `prerenderSafe` GUARD BELOW, not merely nice to have: a page whose data read fell
 * back at build time is prerendered EMPTY, and without a revalidation window that snapshot would be
 * served until the next deploy. It is also right on its own terms — this page lists content an editor
 * publishes without a deploy, so an unlimited lifetime is the wrong default regardless.
 */
export const revalidate = 300;

export default async function ProjectsIndexPage({ searchParams }: ProjectsPageProps) {
  const params = await searchParams;
  const live = liveStatusWhere();

  const query = firstValue(params.q);
  const requestedState = firstValue(params.state).toUpperCase();
  const requestedArea = firstValue(params.area);
  const requestedYear = firstValue(params.year);
  const requestedPage = Number.parseInt(firstValue(params.page), 10);

  // The filter vocabularies. Fetched before the listing because a value in the URL is only usable once
  // it has been checked against the options that actually exist.
  const [areaRows, yearScan] = await prerenderSafe(
    "projects facets",
    () =>
      Promise.all([
          prisma.researchArea.findMany({
            where: live,
            orderBy: [{ sortOrder: "asc" }, { title: "asc" }, { id: "asc" }],
            // One more than the cap, so the note below is a fact rather than a guess.
            take: AREA_OPTION_LIMIT + 1,
            select: { slug: true, title: true }
          }),
          prisma.project.findMany({
            where: { ...live, startedOn: { not: null } },
            orderBy: [{ startedOn: "desc" }, { id: "asc" }],
            take: YEAR_SCAN_LIMIT + 1,
            select: { startedOn: true }
          })
      ]),
    [[], []]
  );

  const areaOptionsTruncated = areaRows.length > AREA_OPTION_LIMIT;
  const areas = areaRows.slice(0, AREA_OPTION_LIMIT);
  const areaTitleBySlug = new Map(areas.map((area) => [area.slug, area.title]));

  const yearScanTruncated = yearScan.length > YEAR_SCAN_LIMIT;
  // UTC, because `startedOn` is a calendar date rather than an instant: reading a stored midnight in a
  // zone west of UTC moves it back a day, and for a January start that moves it back a YEAR.
  const years = unique(
    yearScan
      .slice(0, YEAR_SCAN_LIMIT)
      .map((row) => row.startedOn?.getUTCFullYear())
      .filter((year): year is number => typeof year === "number" && Number.isFinite(year))
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Validate. Anything unrecognised is ignored AND named — see the header.
  // ───────────────────────────────────────────────────────────────────────────

  const ignored: string[] = [];

  const state = isProjectStatus(requestedState) ? requestedState : null;
  if (requestedState && !state) {
    ignored.push(`“${requestedState}” is not a project stage, so the stage filter has been ignored.`);
  }

  const areaSlug = requestedArea && areaTitleBySlug.has(requestedArea) ? requestedArea : null;
  if (requestedArea && !areaSlug) {
    ignored.push(
      `No published research area has the address “${requestedArea}”, so the area filter has been ignored.`
    );
  }

  const parsedYear = Number.parseInt(requestedYear, 10);
  const year = Number.isFinite(parsedYear) && years.includes(parsedYear) ? parsedYear : null;
  if (requestedYear && year === null) {
    ignored.push(
      `No project on this list started in “${requestedYear}”, so the year filter has been ignored.`
    );
  }

  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const where: Prisma.ProjectWhereInput = {
    ...live,
    ...(state ? { state } : {}),
    ...(areaSlug ? { researchArea: { slug: areaSlug } } : {}),
    ...(year !== null
      ? {
          startedOn: {
            gte: new Date(Date.UTC(year, 0, 1)),
            lt: new Date(Date.UTC(year + 1, 0, 1))
          }
        }
      : {}),
    ...(query
      ? {
          // Three columns, because a reader searching "Bagru" may be remembering the tagline rather
          // than the title. `liveStatusWhere()` contributes no `OR`, so this one cannot collide with it.
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { tagline: { contains: query, mode: "insensitive" } },
            { summary: { contains: query, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [total, projects] = await prerenderSafe(
    "projects",
    () =>
      Promise.all([
          prisma.project.count({ where }),
          prisma.project.findMany({
            where,
            // Featured first, then most recently started. `nulls: "last"` is load-bearing: Postgres sorts
            // NULLs FIRST on a DESC order, so a project with no start date would otherwise head a list
            // ordered by recency. `id` last makes the sort TOTAL, so page 2 never repeats a row from page 1.
            orderBy: [
              { isFeatured: "desc" },
              { startedOn: { sort: "desc", nulls: "last" } },
              { publishedAt: { sort: "desc", nulls: "last" } },
              { id: "asc" }
            ],
            skip: (page - 1) * PAGE_SIZE,
            take: PAGE_SIZE,
            select: projectCardSelect
          })
      ]),
    [0, []]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  /** A stale bookmark, not an empty result set. See the header. */
  const pastTheEnd = total > 0 && projects.length === 0 && page > totalPages;

  const hasFilters = Boolean(state || areaSlug || year !== null || query);

  // Every parameter this page owns, in one canonical order, minus `page` — `Pagination` adds that
  // itself. Built from the VALIDATED values, so a link out of here never carries a filter that was
  // ignored on the way in.
  const carried = new URLSearchParams();
  if (query) carried.set("q", query);
  if (state) carried.set("state", state);
  if (areaSlug) carried.set("area", areaSlug);
  if (year !== null) carried.set("year", String(year));
  const baseHref = carried.toString().length > 0 ? `/projects?${carried.toString()}` : "/projects";

  const groups: FilterGroup[] = [
    {
      key: "state",
      label: "Stage",
      control: "chips",
      allLabel: "Any stage",
      options: STAGE_ORDER.map((value) => ({ value, label: STAGE[value].label }))
    },
    {
      key: "area",
      label: "Research area",
      control: "select",
      placeholder: "All research areas",
      options: areas.map((area) => ({ value: area.slug, label: area.title }))
    },
    {
      key: "year",
      // The semantics, on screen. See the header.
      label: "Start year",
      control: "select",
      placeholder: "Any start year",
      options: years.map((value) => ({ value: String(value), label: String(value) }))
    }
  ];

  return (
    <>
      <PageHero
        eyebrow="Projects"
        title="Projects"
        description="Funded and in-house research at the Centre, from proposals through to completed work. Filter by stage, research area or the year a project began."
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Projects", href: "/projects" }
        ]}
      />

      <section className="shell pb-20 md:pb-28">
        <FilterBar
          search={{
            key: "q",
            // A search box's only accessible name. "Search projects", never "Search".
            label: "Search projects",
            placeholder: "Title, tagline or summary"
          }}
          groups={groups}
          label="Filter projects"
          className="mb-8"
        />

        {ignored.length > 0 ? (
          // Every ignored parameter, named. A filter that was silently dropped leaves the reader
          // looking at a list that does not match the controls beside it.
          <div className="mb-8 flex items-start gap-2.5 rounded-md border border-line-200 bg-surface-50 px-3.5 py-2.5 text-sm leading-relaxed text-ink-700">
            <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warn-800" />
            <span>
              {ignored.map((sentence, index) => (
                // The sentences are generated here and never reordered, so the index is a stable key.
                <span key={index} className="block">
                  {sentence}
                </span>
              ))}
            </span>
          </div>
        ) : null}

        {areaOptionsTruncated ? (
          <p className="mb-8 text-sm text-ink-500">
            The research area filter lists the first {AREA_OPTION_LIMIT} areas. Any beyond that can
            still be reached from the research page.
          </p>
        ) : null}

        {yearScanTruncated ? (
          <p className="mb-8 text-sm text-ink-500">
            The start year filter is built from the {YEAR_SCAN_LIMIT} most recently started projects, so
            years earlier than the oldest one listed may be missing from it.
          </p>
        ) : null}

        {pastTheEnd ? (
          <div className="rounded-lg border border-line-200 bg-card p-8 text-center">
            <h2 className="display-title text-xl">Page {page} is past the end of this list</h2>
            <p className="prose-measure mx-auto mt-2 text-sm leading-relaxed text-ink-500">
              There {total === 1 ? "is" : "are"} {total} {total === 1 ? "project" : "projects"} here,
              which {totalPages === 1 ? "fits on one page" : `runs to ${totalPages} pages`}. Nothing has
              been removed — this link simply points beyond the last page.
            </p>
            <div className="mt-6 flex justify-center">
              <LinkButton href={baseHref} variant="secondary">
                Back to the first page
              </LinkButton>
            </div>
          </div>
        ) : (
          <>
            <CardGrid
              columns={3}
              stagger
              empty={{
                icon: FolderKanban,
                // The cards are the page's top-level content, so this heading sits directly under the
                // `<h1>` at level 2. Levels never skip (contract §11).
                headingLevel: 2,
                title: hasFilters ? "No projects match these filters" : "No projects have been published yet",
                description: hasFilters
                  ? "Every filter narrows the list further. Clearing one or two of them will widen it again."
                  : "Projects appear here as soon as one is published in the studio.",
                action: hasFilters ? (
                  <LinkButton href="/projects" variant="secondary">
                    Clear all filters
                  </LinkButton>
                ) : undefined
              }}
            >
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </CardGrid>

            {/* Pagination renders the range sentence itself ("Showing 13–24 of 137 projects"), which is
                why there is no `ResultSummary` beside it: two statements of one fact, and one of them
                inside a status region, is one announcement too many.

                The margin moves to the wrapper, which is now the element the grid is spaced from —
                same arrangement as /news, /gallery and /events, so the four pagers are one component
                wrapped one way rather than four near-misses. */}
            <Reveal as="div" className="mt-12">
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                totalItems={total}
                baseHref={baseHref}
                label="Projects"
                itemNoun={{ singular: "project", plural: "projects" }}
              />
            </Reveal>
          </>
        )}

        {areas.length > 0 ? (
          <p className="mt-12 text-sm text-ink-500">
            Projects are grouped into the Centre’s research areas.{" "}
            <Link href="/research" className="font-medium text-purple-700 hover:text-purple-800">
              Browse the areas instead
            </Link>
            .
          </p>
        ) : null}
      </section>
    </>
  );
}

/**
 * A year range as a person would write it.
 *
 * UTC for the reason given above: these are calendar dates, and a local-zone read moves a January
 * start into the previous year.
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
      eyebrow={project.researchArea?.title ?? undefined}
      title={project.title}
      headingLevel={2}
      // Truncated on the SERVER: a CSS line clamp hides text from sighted readers while leaving it in
      // the accessibility tree, so the two disagree about what the card says.
      description={summary ? truncateWords(summary, 170) : undefined}
      meta={
        <>
          <Badge tone={stage.tone} icon={stage.icon} size="sm">
            {stage.label}
          </Badge>
          {period ? <span className="tabular-nums">{period}</span> : null}
          {project.isFeatured ? <Badge size="sm">Featured</Badge> : null}
        </>
      }
      footer={
        // Nothing at all when progress is 0: "not tracked" and "not started" are different claims and
        // a reader cannot tell them apart from an empty bar (components/site/ProjectProgress.tsx).
        <ProjectProgress progress={project.progress} projectTitle={project.title} size="sm" />
      }
    />
  );
}
