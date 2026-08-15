import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/env";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { PublicationEditor, type PublicationFormValue } from "./PublicationEditor";

/**
 * One publication — the editor's shell.
 *
 * `/studio/publications/new` is this same route: the id `new` means "nothing has been created yet",
 * which is what the dashboard's quick-create link already points at.
 *
 * THE GUARD IS THE FIRST STATEMENT and it throws rather than rendering (contract §1.8).
 *
 * THE PROJECTS A PUBLICATION BELONGS TO ARE READ HERE BUT NOT EDITED HERE. That link is owned by the
 * project's own screen, where the whole list of a project's outputs is visible at once. Offering the
 * same relation from both ends would give two screens the power to disagree about it, so this one
 * states the fact and says where to change it.
 *
 * ⚠ NO `loading.tsx` MAY BE ADDED ABOVE THIS SEGMENT: it would turn the `notFound()` below into a
 * `200 OK` carrying 404 content, and a citation pointing at a withdrawn publication would appear to
 * resolve to every machine that checked (contract §13a).
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Publication"
};

function blankValue(): PublicationFormValue {
  return {
    title: "",
    slug: "",
    kind: "JOURNAL_ARTICLE",
    abstract: "",
    authorLine: "",
    venue: "",
    publisher: "",
    volume: "",
    issue: "",
    pages: "",
    // The current year, because that is the answer nine times out of ten. Held as text — a half-typed
    // year is a real state.
    year: String(new Date().getUTCFullYear()),
    month: "",
    doi: "",
    isbn: "",
    issn: "",
    patentNumber: "",
    arxivId: "",
    url: "",
    bibtex: "",
    keywordsText: "",
    pdfFileIds: [],
    researchAreaIds: [],
    authorPersonIds: [],
    isFeatured: false,
    status: "DRAFT",
    publishedAt: null,
    // On by default: a citation that stops resolving is worse than an unnecessary redirect, and the
    // server only acts on this when a published address actually changes.
    createRedirect: true
  };
}

export default async function StudioPublicationPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireStudioCapability(
    canManageResearch,
    "Publications need researcher access or higher. An administrator can raise yours."
  );

  const { id } = await params;
  const isNew = id === "new";

  const publication = isNew
    ? null
    : await prisma.publication.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          title: true,
          slug: true,
          kind: true,
          abstract: true,
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
          url: true,
          bibtex: true,
          pdfFileId: true,
          keywords: true,
          researchAreaId: true,
          isFeatured: true,
          status: true,
          publishedAt: true,
          authors: { select: { personId: true }, orderBy: { position: "asc" } },
          projects: {
            where: { deletedAt: null },
            select: { id: true, title: true },
            orderBy: { title: "asc" }
          }
        }
      });

  if (!isNew && !publication) notFound();

  const initialValue: PublicationFormValue = publication
    ? {
        title: publication.title,
        slug: publication.slug,
        kind: publication.kind,
        abstract: publication.abstract ?? "",
        authorLine: publication.authorLine,
        venue: publication.venue ?? "",
        publisher: publication.publisher ?? "",
        volume: publication.volume ?? "",
        issue: publication.issue ?? "",
        pages: publication.pages ?? "",
        year: String(publication.year),
        month: publication.month === null ? "" : String(publication.month),
        doi: publication.doi ?? "",
        isbn: publication.isbn ?? "",
        issn: publication.issn ?? "",
        patentNumber: publication.patentNumber ?? "",
        arxivId: publication.arxivId ?? "",
        url: publication.url ?? "",
        bibtex: publication.bibtex ?? "",
        // One per line, which is how the field asks for them and how it shows them back.
        keywordsText: publication.keywords.join("\n"),
        pdfFileIds: publication.pdfFileId ? [publication.pdfFileId] : [],
        researchAreaIds: publication.researchAreaId ? [publication.researchAreaId] : [],
        authorPersonIds: publication.authors.map((author) => author.personId),
        isFeatured: publication.isFeatured,
        status: publication.status,
        publishedAt: publication.publishedAt?.toISOString() ?? null,
        createRedirect: true
      }
    : blankValue();

  return (
    <div className="mx-auto w-full max-w-[76rem]">
      <StudioPageHeader
        title={isNew ? "New publication" : (publication?.title ?? "Publication")}
        description={
          isNew
            ? "The title, the author line and the year are the three fields a citation cannot do without. Everything else can be filled in later."
            : "Every field here appears in the citations other people copy from the public page, so a mistake in one is a mistake in their bibliography."
        }
        back={{ href: "/studio/publications", label: "Publications" }}
        breadcrumb={[
          { label: "Publications", href: "/studio/publications" },
          { label: isNew ? "New" : (publication?.title ?? "Publication") }
        ]}
        meta={publication ? <StatusBadge status={publication.status} size="sm" /> : null}
        actions={
          publication && publication.status === "PUBLISHED" ? (
            <LinkButton
              href={`/publications/${publication.slug}`}
              variant="secondary"
              icon={ExternalLink}
              newTab
            >
              View on the site
            </LinkButton>
          ) : null
        }
      />

      <PublicationEditor
        publicationId={publication?.id ?? null}
        initialValue={initialValue}
        siteUrl={siteUrl()}
        projects={publication?.projects ?? []}
        canPublish={canPublish(user)}
        canDelete={canManageResearch(user)}
      />
    </div>
  );
}
