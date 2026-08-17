import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { siteUrl, storageConfigured } from "@/lib/env";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canManageContent, canPublish } from "@/lib/permissions";
import { LinkButton } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { PersonEditor, type EditorMedia, type PersonFormValue } from "./PersonEditor";

/**
 * One person's profile — the editor's shell.
 *
 * `requireStudioCapability(canManageContent)` IS THE FIRST STATEMENT: people are an editor-level table
 * because a profile speaks for a person. It throws rather than rendering (contract §1.8).
 *
 * `/studio/people/new` is this same route — the id `new` means "nothing has been created yet".
 *
 * ⚠ NO `loading.tsx` MAY BE ADDED ABOVE THIS SEGMENT: it would turn the `notFound()` below into a
 * `200 OK` carrying 404 content (contract §13a).
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Person"
};

/** A day as `<input type="date">` wants it. UTC throughout, so a date never shifts by one. */
function toDateInput(value: Date | null): string {
  if (!value) return "";
  return value.toISOString().slice(0, 10);
}

function blankValue(): PersonFormValue {
  return {
    name: "",
    slug: "",
    kind: "FACULTY",
    designation: "",
    department: "",
    bio: "",
    bioRich: null,
    interestsText: "",
    email: "",
    phone: "",
    website: "",
    linkedin: "",
    googleScholar: "",
    orcid: "",
    github: "",
    photo: null,
    startedOn: "",
    endedOn: "",
    sortOrder: "0",
    isVisible: true,
    status: "DRAFT",
    publishedAt: null,
    // On by default: a broken link is worse than an unnecessary redirect, and the server only acts on
    // this when a published address actually changes.
    createRedirect: true
  };
}

export default async function StudioPersonPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireStudioCapability(
    canManageContent,
    "People need editor access or higher. An administrator can raise yours."
  );

  const { id } = await params;
  const isNew = id === "new";

  const person = isNew
    ? null
    : await prisma.person.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          name: true,
          slug: true,
          kind: true,
          designation: true,
          department: true,
          bio: true,
          bioRich: true,
          researchInterests: true,
          email: true,
          phone: true,
          website: true,
          linkedin: true,
          googleScholar: true,
          orcid: true,
          github: true,
          startedOn: true,
          endedOn: true,
          sortOrder: true,
          isVisible: true,
          status: true,
          publishedAt: true,
          // `fileName` on top of the shared fragment: the media picker shows it beside the thumbnail.
          photo: { select: { ...MEDIA_IMAGE_SELECT_WITH_ID, fileName: true } },
          _count: { select: { projects: true, publications: true, events: true } }
        }
      });

  if (!isNew && !person) notFound();

  const photo: EditorMedia | null = person?.photo
    ? { ...person.photo, variants: person.photo.variants }
    : null;

  const initialValue: PersonFormValue = person
    ? {
        name: person.name,
        slug: person.slug,
        kind: person.kind,
        designation: person.designation ?? "",
        department: person.department ?? "",
        bio: person.bio ?? "",
        bioRich: person.bioRich,
        // One per line, which is how the field asks for them and shows them back.
        interestsText: person.researchInterests.join("\n"),
        email: person.email ?? "",
        phone: person.phone ?? "",
        website: person.website ?? "",
        linkedin: person.linkedin ?? "",
        googleScholar: person.googleScholar ?? "",
        orcid: person.orcid ?? "",
        github: person.github ?? "",
        photo,
        startedOn: toDateInput(person.startedOn),
        endedOn: toDateInput(person.endedOn),
        sortOrder: String(person.sortOrder),
        isVisible: person.isVisible,
        status: person.status,
        publishedAt: person.publishedAt?.toISOString() ?? null,
        createRedirect: true
      }
    : blankValue();

  const attached = person ? person._count.projects + person._count.publications : 0;

  return (
    <div className="mx-auto w-full max-w-[72rem]">
      <StudioPageHeader
        title={isNew ? "New profile" : (person?.name ?? "Person")}
        description={
          isNew
            ? "A profile for somebody shown on the public site. The name and the group are the only two things needed to start."
            : "Everything on this screen appears on this person's page and in the people listings."
        }
        back={{ href: "/studio/people", label: "People" }}
        breadcrumb={[
          { label: "People", href: "/studio/people" },
          { label: isNew ? "New" : (person?.name ?? "Person") }
        ]}
        meta={
          person ? (
            <>
              <StatusBadge status={person.status} size="sm" />
              <span className="text-xs tabular-nums text-ink-500">
                {attached === 0
                  ? "Not named on any project or publication"
                  : `Named on ${attached === 1 ? "1 record" : `${attached} records`}`}
              </span>
            </>
          ) : null
        }
        actions={
          person && person.status === "PUBLISHED" ? (
            <LinkButton
              href={`/people/${person.slug}`}
              variant="secondary"
              icon={ExternalLink}
              newTab
            >
              View on the site
            </LinkButton>
          ) : null
        }
      />

      <PersonEditor
        personId={person?.id ?? null}
        initialValue={initialValue}
        siteUrl={siteUrl()}
        storageReady={storageConfigured()}
        canPublish={canPublish(user)}
        canDelete={canManageContent(user)}
      />
    </div>
  );
}
