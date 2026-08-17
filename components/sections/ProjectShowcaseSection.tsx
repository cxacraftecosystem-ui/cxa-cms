/**
 * ProjectShowcaseSection — projects from the studio, as cards or as a denser list.
 *
 * ⚠ A PROGRESS BAR IS DRAWN ONLY WHEN `progress > 0`. `Project.progress` defaults to 0 and most
 * projects never have it filled in, so a bar on every card would say "0% — stalled" about work that
 * is simply not tracked that way. Absence of a bar means "not tracked"; an empty bar would be a
 * claim, and the wrong one. There is no way for a reader to tell those two apart from a 0% bar, which
 * is exactly why it is not rendered.
 *
 * THE STAGE IS A WORD AND A GLYPH, never a colour alone (contract §11). "On hold" in amber reads the
 * same to a reader who cannot separate amber from green as it does to anyone else, because the chip
 * says "On hold".
 *
 * A Server Component; `Reveal` inside `CardGrid` is the only client piece.
 *
 * ⚠ IT QUERIES NOTHING, AND IT USED TO. An earlier version called `framingAssets` here to fetch the
 * alternate photographs a cover's framing can name, on the argument that those ids arrive in a JSONB column
 * no relation joins — true of the ids, and not a reason to read them from a renderer. `SectionRenderer.tsx`
 * states the rule it broke: "NO RENDERER QUERIES … a renderer receives plain rows and stays pure and
 * testable", and every one of the six sibling showcases obeys it. The cost was a round trip PER BLOCK, so a
 * page with three project showcases paid three where the siblings pay none.
 *
 * `attachProjectFraming` in lib/sections/resolve.ts is where that read belongs and now lives — the same
 * second pass the people, news, craft, event, album and partner showcases already had. Everything this
 * renderer needs is in `resolved.media` by the time it is called.
 *
 * It stays `async` with nothing to await, which is deliberate rather than left over: `SECTION_RENDERERS`
 * types every entry the same way, and a Server Component returning a value instead of a promise is
 * indistinguishable to React. Making this one alone synchronous would buy nothing and would make the next
 * reader wonder which of the two shapes is the intended one.
 */

import Link from "next/link";
import type { PageSection, ProjectStatus } from "@prisma/client";
import {
  ArrowRight,
  CircleCheckBig,
  CirclePause,
  CirclePlay,
  FolderKanban,
  Lightbulb,
  type LucideIcon
} from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { SectionHeading } from "@/components/site/SectionHeading";
import { CardGrid } from "@/components/site/CardGrid";
import { EntityCard } from "@/components/site/EntityCard";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { withBaseAsset } from "@/lib/media/framing";
import { pictureFromMap, type Picture, type ScreenFraming } from "@/lib/media/screens";
import { pickShowcase, type ProjectRow, type ResolvedSectionData } from "@/lib/sections/resolve";
import type { ProjectShowcaseSectionData } from "@/lib/sections/schema";
import { truncateWords } from "@/lib/utils";

export interface ProjectShowcaseSectionProps {
  data: ProjectShowcaseSectionData;
  section: PageSection;
  /** The whole batched read from `lib/sections/resolve.ts`; this block's rows are pulled out by id. */
  resolved?: ResolvedSectionData;
  /** The rows directly, for a studio preview or a bespoke page. Wins over `resolved` when given. */
  rows?: ProjectRow[];
  total?: number;
  droppedIds?: number;
}

/** The stage, as a word, a glyph and a tone — in that order of importance. */
const STAGE: Record<ProjectStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  PROPOSED: { label: "Proposed", tone: "neutral", icon: Lightbulb },
  ACTIVE: { label: "Active", tone: "info", icon: CirclePlay },
  COMPLETED: { label: "Completed", tone: "success", icon: CircleCheckBig },
  ON_HOLD: { label: "On hold", tone: "warn", icon: CirclePause }
};

/**
 * A year range as a person would write it.
 *
 * Rendered in UTC: `startedOn` and `endedOn` are calendar dates rather than instants, and formatting
 * a stored midnight in a zone west of UTC moves it back a day — which for a January start moves it
 * back a YEAR.
 */
function yearOf(value: Date | null): string | null {
  if (!value) return null;
  const year = value.getUTCFullYear();
  return Number.isFinite(year) ? String(year) : null;
}

/**
 * A cover's stored framing, out of its JSONB column.
 *
 * A cast rather than a parse. `Prisma.JsonValue` carries no shape, and the render side is built to
 * tolerate that: every bucket is read through optional access and `storedCrop`, so a hand-edited row
 * degrades to "nothing framed" rather than drawing a broken frame (lib/media/screens.ts). The studio's
 * route is what keeps a row this site wrote honest, with `screenFramingField()`.
 */
function coverFraming(value: ProjectRow["coverScreens"]): ScreenFraming | null {
  return (value ?? null) as unknown as ScreenFraming | null;
}

function periodOf(project: ProjectRow): string | null {
  const from = yearOf(project.startedOn);
  const to = yearOf(project.endedOn);
  if (from && to) return from === to ? from : `${from}–${to}`;
  if (from) return project.state === "COMPLETED" ? from : `${from}–`;
  return to;
}

export async function ProjectShowcaseSection({
  data,
  section,
  resolved,
  rows: given,
  total: givenTotal,
  droppedIds: givenDropped
}: ProjectShowcaseSectionProps) {
  const { rows, total: matched, droppedIds } = pickShowcase(resolved?.projects, section.id, {
    rows: given,
    total: givenTotal,
    droppedIds: givenDropped
  });

  /**
   * Every cover's framing, resolved once, keyed by project.
   *
   * Keyed rather than positional because the two layouts below iterate `rows` separately and only one of
   * them carries an index — a second `map` producing pictures in a parallel array is one reordering away
   * from a project wearing another project's crop.
   *
   * `withBaseAsset` puts the record's OWN cover into the map beside the alternates, because
   * `pictureFromMap` looks the base photograph up by id exactly like a bucket that names a different one.
   * The page's `resolved.media` is folded in too: a cover an editor also used in a block on this page is
   * already there, and merging costs nothing.
   */
  const pictures = new Map<string, Picture | null>(
    // The tuple is annotated because `map` would otherwise widen it to an ARRAY of the union, which the
    // `Map` constructor does not accept.
    rows.map((project): [string, Picture | null] => [
      project.id,
      pictureFromMap(
        project.coverId,
        coverFraming(project.coverScreens),
        withBaseAsset(resolved?.media ?? {}, project.coverId, project.cover)
      )
    ])
  );

  const heading = data.heading.trim();
  const eyebrow = data.eyebrow.trim();
  const body = data.body.trim();
  const label = data.ctaLabel.trim();
  const href = data.ctaHref.trim();
  const link = label && href ? { href, label } : undefined;
  const showsHeader = Boolean(heading || eyebrow || body || link);
  const hidden = Math.max(0, matched - rows.length);
  const dense = data.layout === "list";

  const empty = {
    icon: FolderKanban,
    title: data.state ? "No projects at this stage yet" : "No projects to show yet",
    description: data.state
      ? "Projects appear here once one at this stage is published in the studio."
      : "Projects appear here once they are published in the studio.",
    headingLevel: 3 as const
  };

  return (
    <section id={`block-${section.id}`} className="py-20 md:py-28">
      <div className="shell">
        <Reveal>
          <SectionHeading
            eyebrow={eyebrow || undefined}
            // A cleared heading means no heading ON SCREEN, not a nameless region in the outline.
            title={heading || "Projects"}
            titleClassName={heading ? undefined : "sr-only"}
            description={body || undefined}
            // ⚠ Withheld when the heading is off screen: `SectionHeading` gates its trailing link on
            // the link alone, so an `sr-only` title still paints it — and the row below would draw
            // the same call to action a second time. Exactly one of the two ever renders.
            link={heading ? link : undefined}
          />
        </Reveal>

        <div className={showsHeader ? "mt-12" : undefined}>
          {dense ? (
            rows.length === 0 ? (
              <EmptyState {...empty} />
            ) : (
              <ul className="grid gap-4">
                {rows.map((project, index) => (
                  <li key={project.id}>
                    <Reveal delay={Math.min(index, 8) * 0.05}>
                      <ProjectCard
                        project={project}
                        picture={pictures.get(project.id) ?? null}
                        dense
                      />
                    </Reveal>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <CardGrid columns={3} stagger empty={empty}>
              {rows.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  picture={pictures.get(project.id) ?? null}
                />
              ))}
            </CardGrid>
          )}
        </div>

        <ShowcaseNote hidden={hidden} matched={matched} dropped={droppedIds} link={link} />

        {/* The CTA's one copy when the heading is off screen — see the note beside `SectionHeading`. */}
        {!heading && link ? (
          <div className="mt-10">
            <LinkButton href={link.href} variant="secondary" icon={ArrowRight} iconPosition="end">
              {link.label}
            </LinkButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ProjectCard({
  project,
  picture,
  dense = false
}: {
  project: ProjectRow;
  /** Already resolved by the section above — see the note there for why it is not computed per card. */
  picture?: Picture | null;
  dense?: boolean;
}) {
  const stage = STAGE[project.state];
  const period = periodOf(project);
  const summary = project.tagline?.trim() || project.summary?.trim() || "";

  return (
    <EntityCard
      href={`/projects/${project.slug}`}
      media={project.cover}
      picture={picture ?? null}
      variant={dense ? "compact" : "cover"}
      eyebrow={project.researchArea?.title ?? undefined}
      title={project.title}
      description={summary ? truncateWords(summary, dense ? 140 : 180) : undefined}
      meta={
        <>
          <Badge tone={stage.tone} icon={stage.icon} size="sm">
            {stage.label}
          </Badge>
          {period ? <span className="tabular-nums">{period}</span> : null}
        </>
      }
      footer={
        // See the header: no bar at all rather than a bar reading zero.
        project.progress > 0 ? (
          <ProgressBar
            value={project.progress}
            size="sm"
            // The project's name is in the bar's accessible name because a page of eight cards would
            // otherwise announce eight controls all called "Progress".
            label={`Progress — ${project.title}`}
          />
        ) : undefined
      }
    />
  );
}

/**
 * The honest footnote — see contract §1.6. A list that quietly stops is indistinguishable from a
 * place with no more records, and a hand-picked list that lost two items looks like a deliberate
 * choice of four.
 */
function ShowcaseNote({
  hidden,
  matched,
  dropped,
  link
}: {
  hidden: number;
  matched: number;
  dropped: number;
  link?: { href: string; label: string };
}) {
  if (hidden === 0 && dropped === 0) return null;

  return (
    <p className="mt-8 text-sm text-ink-500">
      {hidden > 0 ? (
        <>
          Showing {matched - hidden} of {matched} projects.{" "}
          {link ? (
            <Link href={link.href} className="font-medium text-purple-700 hover:text-purple-800">
              {link.label}
            </Link>
          ) : null}
        </>
      ) : null}
      {dropped > 0 ? (
        <>
          {hidden > 0 ? " " : null}
          {dropped} chosen {dropped === 1 ? "project is" : "projects are"} no longer published and{" "}
          {dropped === 1 ? "is" : "are"} not shown.
        </>
      ) : null}
    </p>
  );
}
