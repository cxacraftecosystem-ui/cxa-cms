/**
 * /projects/[slug] — the whole of one project: what it is, who paid for it, who is doing it, what it
 * has produced, and what a reader can take away.
 *
 * A SERVER COMPONENT reading Prisma directly (contract §9). Three client pieces are mounted inside it —
 * `Reveal`, the `MediaLightboxProvider`/`LightboxTrigger` pair, and the FAQ `Accordion` — and each is a
 * wrapper around markup that stays on the server: the gallery thumbnails are rendered here and passed
 * through as children, so `next/image` and every caption are not shipped to the browser for the sake of
 * one click handler.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `fundingAmount` IS A STRING AND IS NEVER PARSED.
 *
 * The column is a string with `fundingCurrency` beside it, and the schema says why: a numeric column
 * would have to pick a currency, and every grant that is not in it becomes wrong by exactly the
 * exchange rate on an unknown day. So the two are rendered TOGETHER, exactly as recorded — no
 * `Number()`, no `Intl.NumberFormat`, no grouping separators inserted or removed. "₹1.2 crore",
 * "48,00,000" and "500 000" are all things an editor may legitimately have typed, and all three survive
 * this page unchanged.
 *
 * EVERY NESTED LIST IS CAPPED AND EVERY CAP IS STATED. The counts come from filtered `_count`
 * aggregates in the same query, so the sentence is "showing 12 of 27" rather than "there may be more" —
 * a list that quietly stops is indistinguishable from a project with twelve people on it (contract
 * §1.6). The counts carry the same publication filters as the lists, so no figure advertises a draft.
 *
 * THE RELATED BLOCK AT THE FOOT COSTS EXACTLY ONE QUERY, and it is the page's only query besides the
 * project itself. It cannot be folded into that one — it needs the team's ids, which are part of the
 * answer — but it must never become a query per team member. See the comment above it.
 *
 * BREADCRUMB JSON-LD IS EMITTED BY `PageHero` from its `breadcrumbs` prop, which is also what draws the
 * visible trail. One array, so the two cannot disagree, and it must not be emitted a second time here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `revalidate` IS SET DELIBERATELY. This page reads no request-scoped input, so without it Next would
 * render it once on first request and serve that copy for the life of the deployment — a project moved
 * from "under way" to "completed", or retired altogether, would keep telling readers the old story.
 * Publication state is resolved at read time (lib/content.ts), so the window below is also the longest
 * anything here can be stale.
 */

import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { MediaKind, Prisma, ProjectStatus, PublicationKind } from "@prisma/client";
import {
  Building2,
  CalendarClock,
  CircleCheckBig,
  CircleDashed,
  CirclePause,
  CirclePlay,
  Download,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  Lightbulb,
  ListChecks,
  Presentation,
  Users,
  type LucideIcon
} from "lucide-react";

import { Reveal } from "@/components/motion/Reveal";
import { CardGrid } from "@/components/site/CardGrid";
import { DefinitionList, type DefinitionItem } from "@/components/site/DefinitionList";
import { EntityCard } from "@/components/site/EntityCard";
import {
  LightboxTrigger,
  MediaLightboxProvider,
  type LightboxItem
} from "@/components/site/MediaLightbox";
import { PageHero } from "@/components/site/PageHero";
import { ProjectProgress } from "@/components/site/ProjectProgress";
import { RelatedContent, type RelatedItem } from "@/components/site/RelatedContent";
import { ProseArticle } from "@/components/site/ProseArticle";
import { SectionHeading } from "@/components/site/SectionHeading";
import { Accordion, AccordionItem } from "@/components/ui/Accordion";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { MediaImage } from "@/components/ui/MediaImage";
import { publicationDisplayVenue } from "@/lib/citation";
import { liveStatusWhere } from "@/lib/content";
import { prisma } from "@/lib/db";
import { publicObjectUrl } from "@/lib/media/url";
import { parseRichText, richTextExcerpt } from "@/lib/richtext";
import { pageMetadata } from "@/lib/seo";
import { formatBytes, truncateWords } from "@/lib/utils";

/** Five minutes. Long enough to be worth caching, short enough that a correction is not a mystery. */
export const revalidate = 300;

/** Caps. Each is stated on screen at the place it applies. */
const TEAM_LIMIT = 16;
const MILESTONE_LIMIT = 24;
const MEDIA_LIMIT = 24;
const FILE_LIMIT = 12;
const PUBLICATION_LIMIT = 12;
const PARTNER_LIMIT = 16;
const FAQ_LIMIT = 20;
/**
 * How many other projects the related block shows — two full rows of the three-column grid.
 *
 * Its query takes one MORE than this, so "is that all of them?" is answered by a row that came back
 * rather than guessed, and the block can say so on screen (contract §1.6).
 */
const RELATED_LIMIT = 6;

const FMT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  // `startedOn`, `endedOn`, `dueOn` and `completedOn` are calendar dates, not instants. Formatting a
  // stored midnight in the server's local zone moves it back a day in every zone west of UTC.
  timeZone: "UTC"
});

function formatDate(value: Date | null): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return FMT_DATE.format(value);
}

/**
 * Everything `<MediaImage>` needs.
 *
 * `variants` is not optional: without it `pickVariant` has nothing to choose from and every image falls
 * back to the full-size ORIGINAL — a 6 MB photograph inside a 320px card.
 */
const mediaSelect = {
  objectKey: true,
  width: true,
  height: true,
  altText: true,
  blurDataUrl: true,
  variants: { select: { label: true, format: true, objectKey: true, width: true } }
} satisfies Prisma.MediaAssetSelect;

const STAGE: Record<ProjectStatus, { label: string; tone: BadgeTone; icon: LucideIcon }> = {
  PROPOSED: { label: "Proposed", tone: "neutral", icon: Lightbulb },
  ACTIVE: { label: "Active", tone: "info", icon: CirclePlay },
  COMPLETED: { label: "Completed", tone: "success", icon: CircleCheckBig },
  ON_HOLD: { label: "On hold", tone: "warn", icon: CirclePause }
};

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
 * The glyph for a download, chosen from the EXTENSION rather than the MIME type.
 *
 * A MIME type is often `application/octet-stream` for exactly the files whose shape matters most — a
 * dataset, a 3D model, an archive — whereas the extension is what an editor actually named.
 */
const EXTENSION_ICON: Record<string, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  docx: FileText,
  txt: FileText,
  md: FileText,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  zip: FileArchive,
  gz: FileArchive,
  tar: FileArchive,
  "7z": FileArchive,
  ppt: Presentation,
  pptx: Presentation,
  json: FileCode,
  xml: FileCode,
  geojson: FileCode,
  glb: FileCode,
  gltf: FileCode
};

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index <= 0 || index === fileName.length - 1) return "";
  return fileName.slice(index + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Which attachments this page can DRAW, as opposed to merely count. */
const GALLERY_KINDS: readonly MediaKind[] = ["IMAGE", "PANORAMA"];

/**
 * The project, memoised for the duration of ONE request.
 *
 * `generateMetadata` and the page both need it, and React's `cache()` is what makes that one query
 * rather than two. It is per-render and not time-based, so an editor who publishes a change sees it on
 * the very next request with no revalidation call.
 */
const loadProject = cache(async (slug: string) => {
  const live = liveStatusWhere();
  const now = new Date();
  /** The download gate, written once and used by both the list and its count. */
  const publicFile: Prisma.FileAssetWhereInput = {
    deletedAt: null,
    isPublic: true,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
  };
  const publishedPerson: Prisma.PersonWhereInput = { ...live, isVisible: true };
  const visiblePartner: Prisma.PartnerWhereInput = { deletedAt: null, isVisible: true };
  const presentAsset: Prisma.MediaAssetWhereInput = { deletedAt: null };

  return prisma.project.findFirst({
    // Never hand-rolled (contract §9). A draft project must 404 rather than be readable by anyone who
    // guesses its address.
    where: { ...live, slug },
    select: {
      id: true,
      slug: true,
      title: true,
      tagline: true,
      summary: true,
      body: true,
      state: true,
      progress: true,
      fundingBody: true,
      fundingAmount: true,
      fundingCurrency: true,
      startedOn: true,
      endedOn: true,
      publishedAt: true,
      updatedAt: true,
      cover: { select: mediaSelect },
      // The id as well as the relation: the related block filters other projects by it, and a filter
      // written as `researchArea: { slug }` would join the areas table again to reach a column this
      // row already carries.
      researchAreaId: true,
      researchArea: { select: { slug: true, title: true } },

      members: {
        where: { person: publishedPerson },
        orderBy: [{ position: "asc" }, { personId: "asc" }],
        take: TEAM_LIMIT,
        select: {
          role: true,
          person: {
            select: {
              id: true,
              slug: true,
              name: true,
              designation: true,
              photo: { select: mediaSelect }
            }
          }
        }
      },

      milestones: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        take: MILESTONE_LIMIT,
        select: { id: true, title: true, detail: true, dueOn: true, completedOn: true }
      },

      media: {
        where: { asset: presentAsset },
        orderBy: [{ position: "asc" }, { assetId: "asc" }],
        take: MEDIA_LIMIT,
        select: {
          caption: true,
          asset: {
            select: {
              id: true,
              kind: true,
              // The stored type, so a `<source>` element can declare it. Without it the browser has to
              // sniff the container, and a codec it cannot play is discovered only after the fetch.
              mimeType: true,
              caption: true,
              credit: true,
              ...mediaSelect
            }
          }
        }
      },

      files: {
        where: { file: publicFile },
        orderBy: [{ position: "asc" }, { fileId: "asc" }],
        take: FILE_LIMIT,
        select: {
          file: {
            select: {
              id: true,
              title: true,
              slug: true,
              description: true,
              category: true,
              // The NEWEST version only: a downloads list shows what you would get if you pressed it,
              // and the download route resolves the newest version too.
              versions: {
                orderBy: { version: "desc" },
                take: 1,
                select: { version: true, fileName: true, byteSize: true }
              }
            }
          }
        }
      },

      publications: {
        where: live,
        orderBy: [{ year: "desc" }, { month: { sort: "desc", nulls: "last" } }, { title: "asc" }],
        take: PUBLICATION_LIMIT,
        select: {
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
        }
      },

      partners: {
        where: { partner: visiblePartner },
        orderBy: [{ position: "asc" }, { partnerId: "asc" }],
        take: PARTNER_LIMIT,
        select: {
          partner: {
            select: {
              id: true,
              name: true,
              url: true,
              category: true,
              logo: { select: mediaSelect }
            }
          }
        }
      },

      faqs: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        take: FAQ_LIMIT,
        select: { id: true, question: true, answer: true }
      },

      // FILTERED counts, carrying the identical predicates to the lists above, so "showing 12 of 27"
      // counts the same 27 rows the list is drawn from and never advertises a draft or a private file.
      _count: {
        select: {
          members: { where: { person: publishedPerson } },
          milestones: true,
          media: { where: { asset: presentAsset } },
          files: { where: { file: publicFile } },
          publications: { where: live },
          partners: { where: { partner: visiblePartner } },
          faqs: true
        }
      }
    }
  });
});

type ProjectRow = NonNullable<Awaited<ReturnType<typeof loadProject>>>;
type PublicationRow = ProjectRow["publications"][number];
type MilestoneRow = ProjectRow["milestones"][number];

interface ProjectPageProps {
  /** Next 15 hands route params in as a promise. */
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: ProjectPageProps): Promise<Metadata> {
  const { slug } = await params;
  const project = await loadProject(slug);

  if (!project) {
    // The page itself calls `notFound()`. Metadata is still produced, because a 404 whose `<head>`
    // carries the previous page's title is worse than a plain one — and there is nothing to index.
    return pageMetadata({ title: "Project not found", path: `/projects/${slug}`, noIndex: true });
  }

  return pageMetadata({
    title: project.title,
    description:
      project.summary?.trim() ||
      project.tagline?.trim() ||
      richTextExcerpt(parseRichText(project.body), 200) ||
      null,
    path: `/projects/${project.slug}`,
    image: project.cover,
    type: "article",
    publishedTime: project.publishedAt,
    modifiedTime: project.updatedAt
  });
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { slug } = await params;
  const project = await loadProject(slug);
  if (!project) notFound();

  const stage = STAGE[project.state];
  const started = formatDate(project.startedOn);
  const ended = formatDate(project.endedOn);

  /**
   * The rest of the graph this project sits in, in ONE query: the other projects published in its
   * research area, and the other published projects the people on its team are on.
   *
   * ⚠ IT IS NOT AN N+1. The team's ids come from the members loaded with the project above, so the
   * "other work by these people" half costs nothing extra. Asking each person in turn for their
   * projects would turn a block at the FOOT of the page into seventeen queries on a page that is
   * otherwise one — which is the way this feature usually gets built and the reason it usually has to
   * be taken out again.
   *
   * ⚠ THE CLAUSES ARE AN EXPLICIT ARRAY. `{}` inside an `OR` matches every published project, so a
   * project with neither an area nor a team would relate itself to the whole Centre; `OR: []` is the
   * opposite and matches nothing, which is why the query is SKIPPED rather than run empty.
   *
   * ⚠ `id: { not: project.id }` — a project listed under its own "related work" heading is the classic
   * version of this bug, and it is invisible on a test database with one project in it.
   */
  const teamIds = project.members.map((member) => member.person.id);

  const relatedClauses: Prisma.ProjectWhereInput[] = [];
  if (project.researchAreaId) relatedClauses.push({ researchAreaId: project.researchAreaId });
  if (teamIds.length > 0) relatedClauses.push({ members: { some: { personId: { in: teamIds } } } });

  const relatedPool =
    relatedClauses.length > 0
      ? await prisma.project.findMany({
          // The same filter this project was loaded with, never a hand-rolled one: a draft project
          // must not become readable by sharing a researcher with a published one.
          where: { ...liveStatusWhere(), id: { not: project.id }, OR: relatedClauses },
          // The projects index's ordering, so a project does not sit in a different place on the two
          // pages. `nulls: "last"` is load-bearing: Postgres sorts NULLs FIRST on a DESC order, so a
          // project with no start date would otherwise head a list ordered by recency.
          orderBy: [
            { isFeatured: "desc" },
            { startedOn: { sort: "desc", nulls: "last" } },
            { id: "asc" }
          ],
          // One MORE than the cap. See RELATED_LIMIT.
          take: RELATED_LIMIT + 1,
          select: { slug: true, title: true, tagline: true, summary: true }
        })
      : [];

  const relatedTruncated = relatedPool.length > RELATED_LIMIT;

  const relatedItems: RelatedItem[] = relatedPool.slice(0, RELATED_LIMIT).map((entry) => {
    // The tagline is the sentence written to introduce a project; the summary is the fallback for one
    // that has no tagline. Truncated on the SERVER — a CSS line clamp hides the tail from sighted
    // readers while leaving it in the accessibility tree.
    const line = entry.tagline?.trim() || entry.summary?.trim() || "";
    return {
      href: `/projects/${entry.slug}`,
      kind: "Project",
      title: entry.title,
      summary: line ? truncateWords(line, 140) : undefined
    };
  });

  /**
   * What that list is, in the words of the query that produced it.
   *
   * "The people listed above" and not "the team": the ids came from the team section, which is itself
   * capped at TEAM_LIMIT and says so. Claiming the whole team here would be a wider promise than the
   * page can keep.
   */
  const relatedDescription =
    project.researchAreaId && teamIds.length > 0
      ? "Other work published in this research area, and other projects the people listed above are on."
      : project.researchAreaId
        ? "Other work published in this research area."
        : "Other published projects the people listed above are on.";

  /** Where the rest of them are — the area's own filtered listing when there is an area to filter by. */
  const relatedMoreTarget = project.researchArea
    ? {
        href: `/projects?area=${encodeURIComponent(project.researchArea.slug)}`,
        label: `Every project in ${project.researchArea.title}`
      }
    : { href: "/projects", label: "Every project at the Centre" };

  // Attachments, split by what this page can actually draw. Anything else is COUNTED and named rather
  // than dropped: a 3D model attached to a project is a real thing, and a page that silently ignores it
  // tells the editor nothing.
  const gallery = project.media.filter((row) => GALLERY_KINDS.includes(row.asset.kind));
  const videos = project.media.filter((row) => row.asset.kind === "VIDEO");
  const otherAttachments = project.media.length - gallery.length - videos.length;
  const mediaHidden = Math.max(0, project._count.media - project.media.length);

  const lightboxItems: LightboxItem[] = gallery.map((row) => ({
    id: row.asset.id,
    objectKey: row.asset.objectKey,
    width: row.asset.width,
    height: row.asset.height,
    altText: row.asset.altText,
    blurDataUrl: row.asset.blurDataUrl,
    variants: row.asset.variants,
    // The PLACEMENT's caption wins over the asset's: the same photograph legitimately says something
    // different on a project page than it does in an album.
    caption: row.caption ?? row.asset.caption,
    credit: row.asset.credit
  }));

  /**
   * The at-a-glance panel.
   *
   * `DefinitionList` drops any row whose value is empty, so an absent funding body is ABSENT rather
   * than a row reading "Funding body —", which would tell a reader this project has one that the site
   * has failed to show them.
   */
  const facts: DefinitionItem[] = [
    {
      term: "Stage",
      value: (
        <Badge tone={stage.tone} icon={stage.icon} size="sm">
          {stage.label}
        </Badge>
      )
    },
    {
      term: "Research area",
      value: project.researchArea?.title,
      href: project.researchArea ? `/research/${project.researchArea.slug}` : undefined
    },
    { term: "Funding body", value: project.fundingBody?.trim() || undefined },
    {
      term: "Funding awarded",
      // The string and its currency, together and untouched. See the header before "improving" this.
      value: fundingLine(project.fundingAmount, project.fundingCurrency),
      note: project.fundingAmount?.trim()
        ? "As recorded in the award. Not converted to any other currency."
        : undefined
    },
    { term: "Started", value: started },
    {
      // A date in `endedOn` means one thing on a completed project and another on one still running —
      // "Completed" against an active project would be a claim the stage chip contradicts two rows up.
      term: project.state === "COMPLETED" ? "Completed" : "Runs until",
      // A project with no end date is open-ended; `DefinitionList` drops the row rather than printing
      // an em dash that reads as a date the site failed to show.
      value: ended
    }
  ];

  return (
    <>
      {/* The hero also emits the breadcrumb JSON-LD from this one array — see the header. */}
      <PageHero
        tone={project.cover ? "dark" : "light"}
        eyebrow={project.researchArea?.title ?? "Project"}
        title={project.title}
        description={project.tagline?.trim() || project.summary?.trim() || undefined}
        media={project.cover}
        breadcrumbs={[
          { name: "Home", href: "/" },
          { name: "Projects", href: "/projects" },
          { name: project.title, href: `/projects/${project.slug}` }
        ]}
        meta={
          <>
            <Badge tone={stage.tone} icon={stage.icon} size="sm">
              {stage.label}
            </Badge>
            {started ? (
              <span>
                Started <time dateTime={project.startedOn?.toISOString()}>{started}</time>
              </span>
            ) : null}
            {ended ? (
              <span>
                Completed <time dateTime={project.endedOn?.toISOString()}>{ended}</time>
              </span>
            ) : null}
          </>
        }
      />

      <div className="shell grid gap-12 py-12 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-16">
        <div className="min-w-0">
          <h2 className="display-title text-2xl sm:text-3xl">Overview</h2>

          {project.summary?.trim() && project.tagline?.trim() ? (
            // The tagline is in the hero, so the summary only appears here when the two are different
            // pieces of writing. Otherwise it would be the same sentence twice, 200px apart.
            <p className="prose-measure mt-4 text-lg leading-relaxed text-ink-700">
              {project.summary.trim()}
            </p>
          ) : null}

          <div className="mt-6">
            <ProseArticle
              value={project.body}
              fallback={
                <p className="text-base leading-relaxed text-ink-500">
                  A fuller description of this project has not been published yet. The facts recorded
                  against it are listed beside this note.
                </p>
              }
            />
          </div>
        </div>

        <aside aria-labelledby="at-a-glance" className="min-w-0">
          <div className="panel p-6">
            <h2 id="at-a-glance" className="display-title text-base">
              At a glance
            </h2>

            <DefinitionList items={facts} className="mt-5" />

            {/* Renders NOTHING when progress is 0 — "not tracked" and "not started" are different
                claims (components/site/ProjectProgress.tsx). */}
            <ProjectProgress
              progress={project.progress}
              projectTitle={project.title}
              hint="As last recorded by the project team."
              className="mt-6"
            />
          </div>
        </aside>
      </div>

      {project.milestones.length > 0 ? (
        <section id="milestones" data-anchor="" className="shell py-16 md:py-24">
          <Reveal>
            <SectionHeading
              eyebrow="Progress"
              title="Milestones"
              description="The plan of work as the team recorded it, in their own order."
              className="mb-12"
            />
          </Reveal>

          {/* The spine is STATIC: a track and a dot per entry, both drawn in CSS with no motion. A
              scroll-linked fill would be a signal a reduced-motion reader never gets. */}
          <ol className="relative border-l border-line-200 pl-8">
            {project.milestones.map((milestone, index) => (
              <MilestoneItem key={milestone.id} milestone={milestone} index={index} />
            ))}
          </ol>

          {project._count.milestones > project.milestones.length ? (
            <p className="mt-8 text-sm text-ink-500">
              Showing the first {project.milestones.length} of {project._count.milestones} milestones
              recorded against this project.
            </p>
          ) : null}
        </section>
      ) : null}

      <section id="team" data-anchor="" className="shell py-16 md:py-24">
        <Reveal>
          <SectionHeading
            title="The team"
            description="Everyone working on this project whose own page is published, in the order the project records them."
            className="mb-10"
          />
        </Reveal>

        <CardGrid
          columns={4}
          stagger
          empty={{
            icon: Users,
            headingLevel: 3,
            title: "No team members are listed for this project yet",
            description:
              "People appear here once they are added to the project in the studio and their own page is published."
          }}
        >
          {project.members.map((member) => (
            <EntityCard
              key={member.person.id}
              href={`/people/${member.person.slug}`}
              media={member.person.photo}
              variant="portrait"
              // The role ON THIS PROJECT, which is not the same thing as their designation at the
              // Centre — "Principal investigator" is a job on a grant, not a job title.
              eyebrow={member.role?.trim() || undefined}
              title={member.person.name}
              description={member.person.designation?.trim() || undefined}
            />
          ))}
        </CardGrid>

        {project._count.members > project.members.length ? (
          <p className="mt-8 text-sm text-ink-500">
            Showing {project.members.length} of {project._count.members} people on this project.
          </p>
        ) : null}
      </section>

      {gallery.length > 0 ? (
        <section id="gallery" data-anchor="" className="shell py-16 md:py-24">
          <Reveal>
            <SectionHeading
              eyebrow="From the field"
              title="Gallery"
              description="Press a photograph to open it full screen. The arrow keys move between them."
              className="mb-10"
            />
          </Reveal>

          {/*
            The PROVIDER wraps a grid rendered on the SERVER: React serialises the already-rendered
            tree and passes it through, so nothing inside becomes client code by being wrapped here.
          */}
          <MediaLightboxProvider items={lightboxItems} label={`${project.title} — gallery`}>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
              {gallery.map((row, index) => {
                const description = row.asset.altText?.trim() || row.caption?.trim() || "";
                return (
                  <figure key={row.asset.id} className="min-w-0">
                    {/*
                      THE TRIGGER IS AN OVERLAY AND THE DOM ORDER IS LOAD-BEARING: the picture first,
                      the button after it. `MediaImage` renders a `position: relative` frame and nothing
                      here carries a z-index (contract §6), so a button declared BEFORE the picture
                      would be painted over by it and a press would hit nothing.
                    */}
                    <div className="group relative overflow-hidden rounded-md bg-surface-100">
                      <MediaImage
                        media={row.asset}
                        aspect="4 / 3"
                        rounded="none"
                        sizes="(min-width: 768px) 28vw, 46vw"
                        className="w-full"
                        imageClassName="transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                      />
                      <LightboxTrigger
                        index={index}
                        label={
                          description
                            ? `Open image ${index + 1} of ${gallery.length} full screen: ${description}`
                            : `Open image ${index + 1} of ${gallery.length} full screen`
                        }
                        className="absolute inset-0 h-full w-full"
                      />
                    </div>

                    {row.caption?.trim() ? (
                      <figcaption className="mt-2 text-xs leading-relaxed text-ink-500">
                        {row.caption.trim()}
                        {row.asset.credit ? (
                          <span className="text-ink-300"> — {row.asset.credit}</span>
                        ) : null}
                      </figcaption>
                    ) : null}
                  </figure>
                );
              })}
            </div>
          </MediaLightboxProvider>
        </section>
      ) : null}

      {videos.length > 0 ? (
        <section id="videos" data-anchor="" className="shell py-16 md:py-24">
          <Reveal>
            <SectionHeading
              eyebrow="Watch"
              title="Video"
              className="mb-10"
            />
          </Reveal>

          <div className="grid gap-8 md:grid-cols-2">
            {videos.map((row) => {
              const src = publicObjectUrl(row.asset.objectKey);
              const caption = row.caption?.trim() || row.asset.caption?.trim() || "";

              return (
                <figure key={row.asset.id} className="min-w-0">
                  {src ? (
                    // A native player: `controls` is a full keyboard-operable transport in every
                    // browser, and `preload="metadata"` fetches the duration without pulling the file
                    // down for a reader who never presses play.
                    <video
                      controls
                      preload="metadata"
                      className="w-full rounded-md border border-line-200 bg-ink-900"
                      // An empty `aria-label` would leave the player nameless; the caption is the only
                      // description this record carries.
                      aria-label={caption ? `Video: ${caption}` : `Video from ${project.title}`}
                    >
                      <source src={src} type={row.asset.mimeType} />
                      {/* The last resort in a browser that cannot play the container. It is a real
                          sentence, because "your browser does not support video" tells a reader
                          nothing they can act on. */}
                      <p className="p-4 text-sm text-white">
                        This video cannot be played in this browser.{" "}
                        <a href={src} className="underline">
                          Download the file instead
                        </a>
                        .
                      </p>
                    </video>
                  ) : (
                    // SAY SO RATHER THAN LEAVE A GAP (contract §1.6): an editor finding out that the
                    // media base URL is unset is worth more than a page that silently looks fine.
                    <p className="rounded-md border border-dashed border-line-200 bg-surface-50 px-4 py-6 text-sm text-ink-500">
                      This video is attached to the project but cannot be played, because no public
                      media address is configured for this deployment.
                    </p>
                  )}

                  {caption ? (
                    <figcaption className="mt-2 text-sm leading-relaxed text-ink-500">
                      {caption}
                      {row.asset.credit ? (
                        <span className="text-ink-300"> — {row.asset.credit}</span>
                      ) : null}
                    </figcaption>
                  ) : null}
                </figure>
              );
            })}
          </div>
        </section>
      ) : null}

      {mediaHidden > 0 || otherAttachments > 0 ? (
        <div className="shell">
          <p className="text-sm text-ink-500">
            {mediaHidden > 0
              ? `This page shows the first ${project.media.length} of ${project._count.media} attachments on this project. `
              : null}
            {otherAttachments > 0
              ? `${otherAttachments} ${otherAttachments === 1 ? "attachment is" : "attachments are"} of a kind this page cannot display — an audio file, a document or a 3D model — and ${otherAttachments === 1 ? "is" : "are"} not shown above.`
              : null}
          </p>
        </div>
      ) : null}

      {project.files.length > 0 ? (
        <section id="downloads" data-anchor="" className="shell py-16 md:py-24">
          <Reveal>
            <SectionHeading
              eyebrow="Take it with you"
              title="Downloads"
              description="Datasets, reports and material published with this project. The size is shown so nobody starts a large download by accident."
              className="mb-10"
            />
          </Reveal>

          <ul className="grid gap-3">
            {project.files.map((row) => {
              const file = row.file;
              // `take: 1` on a descending version order, so index 0 is the version a press would
              // fetch. Under `noUncheckedIndexedAccess` this is `| undefined`, which is also the real
              // state of a file whose upload never completed.
              const latest = file.versions[0];
              const extension = latest ? extensionOf(latest.fileName) : "";
              const Icon = EXTENSION_ICON[extension] ?? FileText;

              return (
                <li key={file.id}>
                  {/*
                    EVERY LINK GOES TO THE COUNTED ROUTE, and it is a plain `<a>`:
                      • the route, because the download is recorded server-side as the bytes are served,
                        and because `isPublic`/`expiresAt` are enforced there — hiding a link is not an
                        access control (contract §1.7);
                      • a plain anchor and never `next/link`, because the destination answers with a
                        file and the client router would ask it for an RSC payload and get a PDF.
                  */}
                  <a
                    href={`/api/public/files/${file.slug}`}
                    className="group flex items-start gap-4 rounded-md border border-line-200 bg-card p-4 transition duration-200 ease-out hover:-translate-y-0.5 hover:border-purple-200 hover:shadow-md active:translate-y-0 active:shadow-sm"
                  >
                    <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-purple-50 text-purple-700">
                      <Icon aria-hidden="true" className="h-5 w-5" />
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="display-title block text-balance text-base leading-snug transition-colors group-hover:text-purple-700">
                        {file.title}
                      </span>

                      {file.description?.trim() ? (
                        <span className="mt-1 block text-sm leading-relaxed text-ink-500">
                          {truncateWords(file.description, 180)}
                        </span>
                      ) : null}

                      <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-500">
                        {extension ? <Badge size="sm">{extension.toUpperCase()}</Badge> : null}
                        {latest ? (
                          <span className="tabular-nums">{formatBytes(latest.byteSize)}</span>
                        ) : (
                          // "We do not know" and "it is small" must not look the same.
                          <span>Size not recorded</span>
                        )}
                        {latest ? (
                          <span className="tabular-nums">Version {latest.version}</span>
                        ) : null}
                        {file.category?.trim() ? <span>{file.category.trim()}</span> : null}
                      </span>
                    </span>

                    <Download
                      aria-hidden="true"
                      className="mt-1 h-5 w-5 shrink-0 text-ink-300 transition-colors group-hover:text-purple-700"
                    />
                  </a>
                </li>
              );
            })}
          </ul>

          {project._count.files > project.files.length ? (
            <p className="mt-6 text-sm text-ink-500">
              Showing {project.files.length} of {project._count.files} published files attached to this
              project.
            </p>
          ) : null}
        </section>
      ) : null}

      {project.publications.length > 0 ? (
        <section id="publications" data-anchor="" className="shell py-16 md:py-24">
          <Reveal>
            <SectionHeading
              eyebrow="Outputs"
              title="Publications from this project"
              className="mb-10"
            />
          </Reveal>

          <ul className="divide-y divide-line-200 border-y border-line-200">
            {project.publications.map((publication) => (
              <li key={publication.id}>
                <PublicationRowItem publication={publication} />
              </li>
            ))}
          </ul>

          {project._count.publications > project.publications.length ? (
            <p className="mt-6 text-sm text-ink-500">
              Showing the {project.publications.length} most recent of{" "}
              {project._count.publications} publications from this project.{" "}
              <Link href="/publications" className="font-medium text-purple-700 hover:text-purple-800">
                Search the full bibliography
              </Link>
              .
            </p>
          ) : null}
        </section>
      ) : null}

      {project.partners.length > 0 ? (
        <section id="partners" data-anchor="" className="shell py-16 md:py-24">
          <Reveal>
            <SectionHeading
              eyebrow="With"
              title="Partners"
              className="mb-10"
            />
          </Reveal>

          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {project.partners.map((row) => {
              const partner = row.partner;
              const external = partner.url?.trim() || "";

              const body = (
                <>
                  <MediaImage
                    media={partner.logo}
                    alt={partner.logo ? partner.name : ""}
                    aspect="3 / 2"
                    rounded="sm"
                    sizes="(min-width: 1024px) 22vw, 44vw"
                    className="w-full bg-card"
                    // A logo must never be cropped, so `object-contain` — and it needs the `!` because
                    // `cn()` is a plain join and MediaImage's own `object-cover` would otherwise win on
                    // Tailwind's source order (contract §5).
                    imageClassName="!object-contain p-3"
                  />
                  <span className="mt-3 block text-sm font-medium leading-snug text-ink-900">
                    {partner.name}
                  </span>
                  {partner.category?.trim() ? (
                    <span className="mt-0.5 block text-xs text-ink-500">
                      {partner.category.trim().toLowerCase()}
                    </span>
                  ) : null}
                </>
              );

              return (
                <li
                  key={partner.id}
                  className="rounded-lg border border-line-200 bg-card p-4 text-center"
                >
                  {external ? (
                    <a
                      href={external}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-md transition-colors hover:text-purple-700"
                    >
                      {body}
                      {/* A reader whose focus lands in a new tab with no warning has lost their place
                          in the document and their Back button with it. */}
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  ) : (
                    // No address recorded, so this is a statement rather than a link. A control that
                    // looks pressable and does nothing costs a keyboard user a tab stop for nothing.
                    <span className="block">{body}</span>
                  )}
                </li>
              );
            })}
          </ul>

          {project._count.partners > project.partners.length ? (
            <p className="mt-6 text-sm text-ink-500">
              Showing {project.partners.length} of {project._count.partners} partners on this project.
            </p>
          ) : null}
        </section>
      ) : null}

      {project.faqs.length > 0 ? (
        <section id="faqs" data-anchor="" className="shell-narrow py-16 md:py-24">
          <Reveal>
            <SectionHeading
              title="Questions about this project"
              className="mb-10"
            />
          </Reveal>

          {/* Each item keeps its own state and starts closed. ⚠ The panel UNMOUNTS its children when
              closed (components/ui/Accordion.tsx) — harmless here, because an answer is plain text. */}
          <Accordion>
            {project.faqs.map((faq) => (
              <AccordionItem key={faq.id} title={faq.question}>
                <p className="leading-relaxed">{faq.answer}</p>
              </AccordionItem>
            ))}
          </Accordion>

          {project._count.faqs > project.faqs.length ? (
            <p className="mt-6 text-sm text-ink-500">
              Showing {project.faqs.length} of {project._count.faqs} questions recorded for this
              project.
            </p>
          ) : null}
        </section>
      ) : null}

      {/*
        Rendered unconditionally: `RelatedContent` returns null when nothing connects to this project,
        so a lone piece of work ends on its own last section rather than under a "Related work" heading
        with an apology under it.
      */}
      <RelatedContent
        className="shell py-16 md:py-24"
        heading="Related work"
        description={relatedDescription}
        items={relatedItems}
        more={
          relatedTruncated
            ? {
                note: `More than these ${RELATED_LIMIT} projects are connected to this one.`,
                ...relatedMoreTarget
              }
            : undefined
        }
      />

      {/* The way onward. A detail page that ends at its own last section leaves a reader with nowhere
          to go but the Back button. */}
      <section className="shell pb-20 md:pb-28">
        <div className="section-band flex flex-col gap-6 p-8 sm:flex-row sm:items-center sm:justify-between sm:p-10">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-ink-500">
            <Link
              href="/projects"
              className="inline-flex items-center gap-2 font-medium text-purple-700 hover:text-purple-800"
            >
              <ListChecks aria-hidden="true" className="h-4 w-4" />
              All projects
            </Link>
            {project.researchArea ? (
              <Link
                href={`/research/${project.researchArea.slug}`}
                className="inline-flex items-center gap-2 font-medium text-purple-700 hover:text-purple-800"
              >
                <Building2 aria-hidden="true" className="h-4 w-4" />
                More in {project.researchArea.title}
              </Link>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * The funding amount and its currency, together.
 *
 * ⚠ THE AMOUNT IS NEVER PARSED. It is a string because the schema made it one deliberately; the only
 * thing done here is to put the currency in front of it. A currency with no amount beside it is not a
 * fact worth a row, so it renders nothing.
 */
function fundingLine(amount: string | null, currency: string | null): string | undefined {
  const value = amount?.trim() ?? "";
  if (!value) return undefined;
  const unit = currency?.trim() ?? "";
  return unit ? `${unit} ${value}` : value;
}

/**
 * One milestone.
 *
 * COMPLETION IS A WORD AND A GLYPH BEFORE IT IS A COLOUR (contract §11), and it is carried by a
 * `Badge` rather than by tinted text: the status ramps are literal hex that do NOT invert (contract
 * §3), so `text-success-600` on the page canvas is dark green on near-black in the dark theme. Badge's
 * tones are fill-and-ink PAIRS that read the same in both.
 *
 * The dot on the spine is a SHAPE difference — filled for done, hollow for not — so the two states are
 * distinguishable without reading a colour at all.
 *
 * "Completed on 4 June" and "Due 30 September" are different sentences, and a milestone with neither
 * date says so rather than showing an em dash that reads as data the site failed to display.
 */
function MilestoneItem({ milestone, index }: { milestone: MilestoneRow; index: number }) {
  const completed = formatDate(milestone.completedOn);
  const due = formatDate(milestone.dueOn);

  return (
    <Reveal as="li" delay={Math.min(index, 8) * 0.035} className="relative pb-10 last:pb-0">
      {/*
        `-left-10` puts the 16px dot exactly astride the `<ol>`'s hairline: the list pays `pl-8` (32px),
        so an offset of -40px places the dot's centre on the border. An arbitrary value here would be
        one more number to keep in step with that padding.
      */}
      <span
        aria-hidden="true"
        className="absolute -left-10 top-1 flex h-4 w-4 items-center justify-center rounded-full border border-line-200 bg-card"
      >
        {completed ? <span className="block h-1.5 w-1.5 rounded-full bg-purple-700" /> : null}
      </span>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {completed ? (
          <Badge tone="success" icon={CircleCheckBig} size="sm">
            Completed{" "}
            <time dateTime={milestone.completedOn?.toISOString()} className="tabular-nums">
              {completed}
            </time>
          </Badge>
        ) : due ? (
          <Badge tone="neutral" icon={CalendarClock} size="sm">
            Due{" "}
            <time dateTime={milestone.dueOn?.toISOString()} className="tabular-nums">
              {due}
            </time>
          </Badge>
        ) : (
          <Badge tone="neutral" icon={CircleDashed} size="sm">
            No date recorded
          </Badge>
        )}
      </p>

      <h3 className="display-title mt-2 text-lg leading-snug">{milestone.title}</h3>

      {milestone.detail?.trim() ? (
        <p className="prose-measure mt-2 text-sm leading-relaxed text-ink-500">
          {milestone.detail.trim()}
        </p>
      ) : null}
    </Reveal>
  );
}

/**
 * One publication, as a row.
 *
 * The TITLE is the link and the row is not: the author line and the venue are text a reader copies out
 * of a bibliography, and a whole-row link turns selecting them into a navigation.
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
    </article>
  );
}
