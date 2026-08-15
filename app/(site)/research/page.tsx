/**
 * /research — the research areas index, and the graph of how they connect.
 *
 * A SERVER COMPONENT that reads Prisma directly (contract §9). The only client code on the page is
 * `Reveal` and `ResearchGraph`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE COUNTS ARE `_count` WITH A FILTER, NOT A LOADED RELATION.
 *
 * Every card states how many projects and publications its area carries. Loading the relations to
 * count them would fetch every project and every paper on the page — hundreds of rows to render two
 * numbers — so the counts are aggregated in the database.
 *
 * And they are FILTERED counts. A bare `_count: { projects: true }` counts drafts, rows in the recycle
 * bin and embargoed papers, so a public page would advertise work that is not public: a number that
 * disagrees with the list it sits above, and a small disclosure of what is in the studio. Every count
 * here carries the same `liveStatusWhere()` the listings use.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE GRAPH IS ASSEMBLED HERE, NOT FETCHED BY THE GRAPH. `ResearchGraph` is a pure drawing component
 * that knows nothing about publication state; this page decides what is live, caps the picture so it
 * stays legible, and hands over the sentence that says what was left out. A diagram that quietly draws
 * forty of ninety projects is indistinguishable from a Centre with forty (contract §1.6).
 */

import type { Metadata } from "next";
import Link from "next/link";
import * as LucideIcons from "lucide-react";
import { ArrowRight, Microscope, type LucideIcon } from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { CardGrid } from "@/components/site/CardGrid";
import { PageHero } from "@/components/site/PageHero";
import {
  ResearchGraph,
  type ResearchGraphEdge,
  type ResearchGraphNode
} from "@/components/site/ResearchGraph";
import { ResultSummary } from "@/components/site/ResultSummary";
import { SectionHeading } from "@/components/site/SectionHeading";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { pageMetadata } from "@/lib/seo";
import { cn, stableHash, truncateWords } from "@/lib/utils";
import { prerenderSafe } from "@/lib/prerender";

/**
 * Caps, every one of which is stated on screen where it bites.
 *
 * `AREA_LIMIT` is far above any plausible number of research areas — it exists so a mistake in the
 * studio (a bulk import gone wrong) cannot render a page of nine hundred cards, and so the sentence
 * above the grid is always the truth rather than an assumption.
 */
const AREA_LIMIT = 48;
/** How many projects the diagram may draw. Past this the picture stops being readable. */
const GRAPH_PROJECT_LIMIT = 40;
/** How many people of one project become nodes. A twelve-author project would otherwise be a fan. */
const GRAPH_COLLABORATORS_PER_PROJECT = 4;

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({
    title: "Research areas",
    description:
      "The areas the Centre works in, the projects running inside each, and the people who work across them.",
    path: "/research"
  });
}

/**
 * The whole lucide export map, resolved by NAME ON THE SERVER.
 *
 * `ResearchArea.icon` is a free-text lucide name chosen in the studio's picker, so a curated shortlist
 * here would render the fallback for a perfectly valid choice — a wrongness the editor cannot see. This
 * is a Server Component, so the namespace import costs the browser nothing: the icon is already an
 * inline `<svg>` in the HTML by the time it reaches a reader. Same approach, same reasons, as
 * components/sections/ResearchShowcaseSection.tsx.
 */
const ICON_SET = LucideIcons as unknown as Record<string, LucideIcon | undefined>;

function resolveIcon(name: string | null): LucideIcon {
  const key = name?.trim() ?? "";
  // lucide also exports helpers and objects; only a PascalCase function is an icon.
  if (!/^[A-Z][A-Za-z0-9]*$/.test(key)) return Microscope;
  const candidate = ICON_SET[key];
  return typeof candidate === "function" ? candidate : Microscope;
}

/**
 * Accept a value that plausibly IS a colour, and nothing else.
 *
 * Permissive about the colour space — the studio stores OKLCH and editors paste hex, both correct — and
 * strict about the characters, so a pasted stylesheet fragment becomes "no accent" rather than a broken
 * rule. Identical to the guard in ResearchShowcaseSection, because the value is the same column.
 */
const COLOUR_SHAPE =
  /^(?:#[0-9a-f]{3,8}|(?:oklch|oklab|lab|lch|rgb|rgba|hsl|hsla|color)\([^;{}()]*\)|[a-z]{3,20})$/i;

function accentOf(value: string | null): string | null {
  const colour = value?.trim() ?? "";
  return colour && COLOUR_SHAPE.test(colour) ? colour : null;
}

interface AreaCardRow {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  icon: string | null;
  accentColor: string | null;
  _count: { projects: number; publications: number };
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

export default async function ResearchIndexPage() {
  const live = liveStatusWhere();

  const [areas, areaTotal, graphProjects, graphProjectTotal] = await prerenderSafe(
    "research",
    () =>
      Promise.all([
        prisma.researchArea.findMany({
          where: live,
          // The editor's curated order, with a total tiebreak so the page is identical between two
          // requests — an unstable sort reads as data changing by itself.
          orderBy: [{ sortOrder: "asc" }, { title: "asc" }, { id: "asc" }],
          take: AREA_LIMIT,
          select: {
            id: true,
            slug: true,
            title: true,
            summary: true,
            icon: true,
            accentColor: true,
            _count: { select: { projects: { where: live }, publications: { where: live } } }
          }
        }),
        prisma.researchArea.count({ where: live }),
        prisma.project.findMany({
          // A project with no area cannot be an edge between one and its collaborators, so it is not part
          // of this picture. It is still on /projects, which is where the note below points.
          where: { ...live, researchAreaId: { not: null } },
          orderBy: [
            { isFeatured: "desc" },
            { startedOn: { sort: "desc", nulls: "last" } },
            { id: "asc" }
          ],
          take: GRAPH_PROJECT_LIMIT,
          select: {
            id: true,
            title: true,
            researchAreaId: true,
            members: {
              where: { person: { ...live, isVisible: true } },
              orderBy: [{ position: "asc" }, { personId: "asc" }],
              take: GRAPH_COLLABORATORS_PER_PROJECT,
              select: {
                person: { select: { id: true, slug: true, name: true, designation: true } }
              }
            },
            // How many people the project ACTUALLY has, so the per-project cap can be stated rather than
            // guessed at. Filtered to the same people the nodes are drawn from.
            _count: { select: { members: { where: { person: { ...live, isVisible: true } } } } }
          }
        }),
        prisma.project.count({ where: { ...live, researchAreaId: { not: null } } })
      ]),
    [[], 0, [], 0]
  );

  const areasTruncated = areaTotal > areas.length;

  // ───────────────────────────────────────────────────────────────────────────
  // The graph
  //
  // Areas are nodes; a project is an edge from its area to each person on it. Only areas that are on
  // this page can be endpoints — an edge into an area the cap left out would be a line to nowhere.
  // ───────────────────────────────────────────────────────────────────────────

  const areaIds = new Set(areas.map((area) => area.id));
  const collaboratorNodes = new Map<string, ResearchGraphNode>();
  const edges: ResearchGraphEdge[] = [];
  const edgesByArea = new Map<string, number>();
  let collaboratorsOmitted = 0;
  /** Projects whose area was cut by `AREA_LIMIT` — an edge into it would be a line to nowhere. */
  let projectsOutsideDrawnAreas = 0;

  for (const project of graphProjects) {
    const areaId = project.researchAreaId;
    if (!areaId || !areaIds.has(areaId)) {
      projectsOutsideDrawnAreas += 1;
      continue;
    }

    collaboratorsOmitted += Math.max(0, project._count.members - project.members.length);

    for (const member of project.members) {
      const person = member.person;
      const existing = collaboratorNodes.get(person.id);
      if (existing) {
        existing.weight += 1;
      } else {
        collaboratorNodes.set(person.id, {
          id: person.id,
          label: person.name,
          href: `/people/${person.slug}`,
          kind: "collaborator",
          weight: 1,
          detail: person.designation?.trim() || null
        });
      }

      edges.push({
        // Unique per (project, person): the same project appears once per collaborator, and two edges
        // sharing an id would collide as React keys and as layout seeds.
        id: `${project.id}:${person.id}`,
        from: areaId,
        to: person.id,
        label: project.title
      });
      edgesByArea.set(areaId, (edgesByArea.get(areaId) ?? 0) + 1);
    }
  }

  const areaNodes: ResearchGraphNode[] = areas.map((area) => ({
    id: area.id,
    label: area.title,
    href: `/research/${area.slug}`,
    kind: "area",
    accent: accentOf(area.accentColor),
    // Weight is what the DIAGRAM carries, not the area's whole corpus: the node's size has to be
    // honest about the lines drawn from it. The real corpus figures are in `detail` and on the card.
    weight: edgesByArea.get(area.id) ?? 0,
    detail: `${countPhrase(area._count.projects, "project")}, ${countPhrase(area._count.publications, "publication")}`
  }));

  const graphNote = buildGraphNote({
    projectsDrawn: graphProjects.length - projectsOutsideDrawnAreas,
    projectTotal: graphProjectTotal,
    collaboratorsOmitted,
    areasDrawn: areas.length,
    areaTotal
  });

  return (
    <>
      <PageHero
        eyebrow="Research"
        title="Research areas"
        description="The strands the Centre's work is organised into. Each area gathers its own projects, publications and people; the diagram below shows where those strands meet."
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Research", href: "/research" }
        ]}
      />

      <section className="shell pb-8">
        {/* Only when there is something to summarise: with no areas at all, the grid's own empty state
            says so properly, and "No research areas to show" above it would be the same fact stated
            twice and more weakly. */}
        {areas.length > 0 ? (
          <ResultSummary
            shown={areas.length}
            total={areaTotal}
            noun={{ singular: "research area", plural: "research areas" }}
            truncated={areasTruncated}
            cap={areasTruncated ? AREA_LIMIT : undefined}
            omitted={areasTruncated ? areaTotal - areas.length : undefined}
            remedy={areasTruncated ? "The rest are reachable from the studio." : undefined}
            className="mb-8"
          />
        ) : null}

        <CardGrid
          columns={3}
          stagger
          empty={{
            icon: Microscope,
            // The cards are the page's top-level content, so this heading sits directly under the
            // `<h1>` at level 2. Levels never skip (contract §11).
            headingLevel: 2,
            title: "No research areas have been published yet",
            description:
              "Research areas appear here as soon as one is published in the studio. Until then there is nothing on this page to browse."
          }}
        >
          {areas.map((area) => (
            <ResearchAreaCard key={area.id} area={area} />
          ))}
        </CardGrid>
      </section>

      <section className="shell py-16 md:py-24">
        <Reveal>
          <SectionHeading
            eyebrow="The shape of the work"
            title="How the areas connect"
            description="Every research area is a node; every line is a project, joining an area to one of the people working on it. A person sitting between two areas works across both — which is the fact this diagram exists to show."
            className="mb-10"
          />
        </Reveal>

        <ResearchGraph
          nodes={[...areaNodes, ...collaboratorNodes.values()]}
          edges={edges}
          note={graphNote}
          label="How the research areas connect"
        />
      </section>
    </>
  );
}

/** "1 project" / "4 projects" — pluralised once, used in three places. */
function countPhrase(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * The sentence that owns every cap the diagram applied.
 *
 * Assembled from whatever was actually established, and it says nothing at all when nothing was left
 * out — a permanent "this may be incomplete" disclaimer teaches a reader to ignore the one occasion it
 * matters.
 */
function buildGraphNote(facts: {
  projectsDrawn: number;
  projectTotal: number;
  collaboratorsOmitted: number;
  areasDrawn: number;
  areaTotal: number;
}): string | null {
  const sentences: string[] = [];

  if (facts.projectTotal > facts.projectsDrawn) {
    sentences.push(
      `The diagram draws ${facts.projectsDrawn} of ${facts.projectTotal} published projects that belong to an area, chosen featured-first and then most recently started. Every project is listed on the projects page.`
    );
  }
  if (facts.collaboratorsOmitted > 0) {
    sentences.push(
      `Each project shows at most ${GRAPH_COLLABORATORS_PER_PROJECT} of its team, so ${countPhrase(facts.collaboratorsOmitted, "person")} working on these projects ${facts.collaboratorsOmitted === 1 ? "is" : "are"} not drawn. Each project page lists its full team.`
    );
  }
  if (facts.areaTotal > facts.areasDrawn) {
    sentences.push(
      `${facts.areasDrawn} of ${facts.areaTotal} research areas are drawn.`
    );
  }

  return sentences.length > 0 ? sentences.join(" ") : null;
}

/**
 * One area, as a card.
 *
 * BESPOKE RATHER THAN AN `EntityCard`, and for the same reason ResearchShowcaseSection's card is: an
 * icon above the title and an accent rail are particular to research areas, and `EntityCard` is
 * documented as the card for projects, people, publications, news, events, crafts and albums. The link
 * OVERLAY, and the DOM ordering it depends on, are copied from it verbatim — the two obvious
 * alternatives (an `<a>` wrapping the card, or two links) are both wrong for the reasons set out there.
 */
function ResearchAreaCard({ area }: { area: AreaCardRow }) {
  const Icon = resolveIcon(area.icon);
  const accent = accentOf(area.accentColor);
  // A deterministic id: a Server Component has no `useId`, and `aria-labelledby` needs one.
  const titleId = `research-area-${stableHash(area.slug).toString(36)}`;

  return (
    <article
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-lg border border-line-200 bg-card",
        "transition duration-200 ease-out hover:-translate-y-0.5 hover:border-purple-200 hover:shadow-md",
        "active:translate-y-0 active:shadow-sm"
      )}
    >
      {/* The accent rail. Decorative — the area's name is what identifies it. */}
      <span
        aria-hidden="true"
        style={accent ? { backgroundColor: accent } : undefined}
        className={cn("h-1 w-full", accent ? undefined : "bg-purple-200")}
      />

      {/* THE ONE LINK, as an overlay. Declared after the rail and before the content: positioned
          elements paint in DOM order and nothing here carries a z-index (contract §6). */}
      <Link
        href={`/research/${area.slug}`}
        aria-labelledby={titleId}
        className="absolute inset-0 rounded-lg"
      />

      <div className="flex flex-1 flex-col p-6">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-purple-50 text-purple-700">
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>

        <h2
          id={titleId}
          className="display-title mt-5 text-balance text-lg leading-snug transition-colors group-hover:text-purple-700"
        >
          {area.title}
        </h2>

        {area.summary ? (
          // Truncated on the SERVER. A CSS line clamp hides text from sighted readers while leaving it
          // in the accessibility tree, so the two disagree about what the card says.
          <p className="mt-2 text-sm leading-relaxed text-ink-500">
            {truncateWords(area.summary, 160)}
          </p>
        ) : null}

        <dl className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="field-label">Projects</dt>
            <dd className="mt-0.5 font-display text-lg font-semibold tabular-nums text-ink-900">
              {area._count.projects}
            </dd>
          </div>
          <div>
            <dt className="field-label">Publications</dt>
            <dd className="mt-0.5 font-display text-lg font-semibold tabular-nums text-ink-900">
              {area._count.publications}
            </dd>
          </div>
        </dl>

        <p className="mt-auto flex items-center gap-2 pt-6 text-sm font-medium text-purple-700">
          <span
            aria-hidden="true"
            style={accent ? { backgroundColor: accent } : undefined}
            className={cn("h-2 w-2 shrink-0 rounded-full", accent ? undefined : "bg-purple-300")}
          />
          Explore this area
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </p>
      </div>
    </article>
  );
}
