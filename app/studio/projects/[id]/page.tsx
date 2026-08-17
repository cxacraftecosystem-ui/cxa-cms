import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { siteUrl, storageConfigured } from "@/lib/env";
import type { ScreenFraming } from "@/lib/media/screens";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { ProjectEditor, type EditorMedia, type ProjectFormValue } from "./ProjectEditor";

/**
 * One project — the editor's shell.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `/studio/projects/new` IS THIS SAME ROUTE: the id `new` means "nothing has been created yet", which
 * is how the dashboard's quick-create links already work. One screen, one set of rules.
 *
 * THE GUARD IS THE FIRST STATEMENT and it throws rather than rendering (contract §1.8).
 *
 * ONE QUERY WITH EVERY RELATION THE FORM OWNS. A project's screen edits eight related lists — team,
 * milestones, photographs, files, publications, partners, questions — and reading them one at a time
 * would be eight round trips before the first paint.
 *
 * ⚠ WHAT IS *NOT* READ HERE: the names of the chosen people, files, publications and partners. Those
 * lists are `EntityPicker`s, which resolve their own ids to titles through `/api/studio/lookup` — one
 * endpoint that already knows how to show a draft, a deleted record and a truncated search. Reading
 * the names here as well would be a second source of the same strings.
 *
 * DATES CROSS AS `YYYY-MM-DD`, IN UTC. `startedOn` is a day, not an instant, and
 * `new Date("2026-07-30")` is parsed as UTC by the specification while `new Date("2026-07-30T00:00")`
 * is parsed as local time — the two spellings look alike and mean different days either side of
 * midnight. Formatting from `toISOString()` keeps the whole path in UTC.
 *
 * ⚠ NO `loading.tsx` MAY BE ADDED ABOVE THIS SEGMENT — it would turn the `notFound()` below into a
 * `200 OK` with 404 content (contract §13a).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Project"
};

/** The shared image columns plus `fileName`, which the picker prints beside the thumbnail. */
const MEDIA_SELECT = {
  ...MEDIA_IMAGE_SELECT_WITH_ID,
  fileName: true
} as const;

/** A day as a `<input type="date">` wants it. UTC throughout — see the header. */
function toDateInput(value: Date | null): string {
  if (!value) return "";
  return value.toISOString().slice(0, 10);
}

function blankValue(): ProjectFormValue {
  return {
    title: "",
    slug: "",
    tagline: "",
    summary: "",
    body: null,
    state: "ACTIVE",
    researchAreaIds: [],
    fundingBody: "",
    fundingAmount: "",
    // The schema's own default. An editor working in one currency should not have to type it every time.
    fundingCurrency: "INR",
    startedOn: "",
    endedOn: "",
    progress: "0",
    cover: null,
    // Null, never an empty framing: six blank buckets and "nobody has framed this" must look the same
    // to the autosave snapshot, or opening the panel would queue a save (lib/media/screens.ts).
    coverScreens: null,
    members: [],
    milestones: [],
    gallery: [],
    fileIds: [],
    publicationIds: [],
    partnerIds: [],
    faqs: [],
    isFeatured: false,
    sortOrder: "0",
    status: "DRAFT",
    publishedAt: null,
    // On by default: a broken link is worse than an unnecessary redirect, and the server only acts on
    // this when a published address actually changes.
    createRedirect: true
  };
}

export default async function StudioProjectPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireStudioCapability(
    canManageResearch,
    "Projects need researcher access or higher. An administrator can raise yours."
  );

  const { id } = await params;
  const isNew = id === "new";

  const project = isNew
    ? null
    : await prisma.project.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          title: true,
          slug: true,
          tagline: true,
          summary: true,
          body: true,
          state: true,
          researchAreaId: true,
          fundingBody: true,
          fundingAmount: true,
          fundingCurrency: true,
          startedOn: true,
          endedOn: true,
          progress: true,
          isFeatured: true,
          sortOrder: true,
          status: true,
          publishedAt: true,
          cover: { select: MEDIA_SELECT },
          // The stored framing, so the panel opens on what is in force rather than on six empty rows.
          coverScreens: true,
          members: {
            select: { personId: true, role: true },
            orderBy: { position: "asc" }
          },
          milestones: {
            select: { title: true, detail: true, dueOn: true, completedOn: true },
            orderBy: { position: "asc" }
          },
          media: {
            // Each row's own framing beside its picture, for the same reason `coverScreens` is above: the
            // panel has to open on what is stored, or the next save posts null back and clears it.
            select: { caption: true, assetScreens: true, asset: { select: MEDIA_SELECT } },
            orderBy: { position: "asc" }
          },
          files: { select: { fileId: true }, orderBy: { position: "asc" } },
          partners: { select: { partnerId: true }, orderBy: { position: "asc" } },
          faqs: { select: { question: true, answer: true }, orderBy: { position: "asc" } },
          // The implicit many-to-many has no position column of its own, so the order here is the
          // publication's own — newest first, which is the order a reader expects to see them in.
          publications: {
            where: { deletedAt: null },
            select: { id: true },
            orderBy: [{ year: "desc" }, { title: "asc" }]
          }
        }
      });

  if (!isNew && !project) notFound();

  const cover: EditorMedia | null = project?.cover
    ? { ...project.cover, variants: project.cover.variants }
    : null;

  const initialValue: ProjectFormValue = project
    ? {
        title: project.title,
        slug: project.slug,
        tagline: project.tagline ?? "",
        summary: project.summary ?? "",
        body: project.body,
        state: project.state,
        // A single-choice `EntityPicker` still holds an array — one code path for one and for many.
        researchAreaIds: project.researchAreaId ? [project.researchAreaId] : [],
        fundingBody: project.fundingBody ?? "",
        fundingAmount: project.fundingAmount ?? "",
        fundingCurrency: project.fundingCurrency ?? "",
        startedOn: toDateInput(project.startedOn),
        endedOn: toDateInput(project.endedOn),
        progress: String(project.progress),
        cover,
        /**
         * The stored framing, out of its JSONB column.
         *
         * A cast rather than a parse. The API validates it with `screenFramingField()` on the way in, and
         * both the panel and the public renderer read every bucket defensively — so a hand-edited row
         * shows as "nothing framed" rather than breaking the editor (lib/media/screens.ts).
         */
        coverScreens: (project.coverScreens ?? null) as unknown as ScreenFraming | null,
        members: project.members.map((member) => ({
          personId: member.personId,
          role: member.role ?? ""
        })),
        milestones: project.milestones.map((milestone) => ({
          title: milestone.title,
          detail: milestone.detail ?? "",
          dueOn: toDateInput(milestone.dueOn),
          completedOn: toDateInput(milestone.completedOn)
        })),
        gallery: project.media.map((entry) => ({
          asset: { ...entry.asset, variants: entry.asset.variants },
          caption: entry.caption ?? "",
          // A cast rather than a parse, on the same terms as `coverScreens` below it.
          assetScreens: (entry.assetScreens ?? null) as unknown as ScreenFraming | null
        })),
        fileIds: project.files.map((entry) => entry.fileId),
        publicationIds: project.publications.map((entry) => entry.id),
        partnerIds: project.partners.map((entry) => entry.partnerId),
        faqs: project.faqs.map((faq) => ({ question: faq.question, answer: faq.answer })),
        isFeatured: project.isFeatured,
        sortOrder: String(project.sortOrder),
        status: project.status,
        publishedAt: project.publishedAt?.toISOString() ?? null,
        createRedirect: true
      }
    : blankValue();

  return (
    <div className="mx-auto w-full max-w-[76rem]">
      <StudioPageHeader
        title={isNew ? "New project" : (project?.title ?? "Project")}
        description={
          isNew
            ? "Start with the title, the summary and the research area it belongs to. The team, milestones and photographs can be added at any time."
            : "Everything on this screen appears on the project's page on the public site."
        }
        back={{ href: "/studio/projects", label: "Projects" }}
        breadcrumb={[
          { label: "Projects", href: "/studio/projects" },
          { label: isNew ? "New" : (project?.title ?? "Project") }
        ]}
        meta={project ? <StatusBadge status={project.status} size="sm" /> : null}
        actions={
          project && project.status === "PUBLISHED" ? (
            <LinkButton
              href={`/projects/${project.slug}`}
              variant="secondary"
              icon={ExternalLink}
              newTab
            >
              View on the site
            </LinkButton>
          ) : null
        }
      />

      <ProjectEditor
        projectId={project?.id ?? null}
        initialValue={initialValue}
        siteUrl={siteUrl()}
        storageReady={storageConfigured()}
        canPublish={canPublish(user)}
        canDelete={canManageResearch(user)}
      />
    </div>
  );
}
