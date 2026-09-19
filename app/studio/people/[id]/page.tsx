import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { canonicalDepartmentLabels } from "@/lib/people/departments";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { siteUrl, storageConfigured } from "@/lib/env";
import type { ScreenFraming } from "@/lib/media/screens";
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

/**
 * How many departments are offered under the "Department or unit" field.
 *
 * There has to be a number — the query is `distinct` over a free-text column and an institute may have
 * hundreds — and past a few dozen a suggestion list stops being a help and becomes a second problem.
 * When it IS reached the editor says so on screen rather than stopping silently (contract §1.6).
 *
 * ⚠ THE CAP IS APPLIED BEFORE THE DEDUPLICATION, NOT AFTER, AND IT CANNOT BE OTHERWISE: `distinct` and
 * `take` are one query, and which spellings mean the same unit is a question only JavaScript can answer
 * (lib/people/departments.ts). So the list may hold FEWER than this many suggestions — the near
 * duplicates collapse into one another — and the sentence on screen says "spellings", not "departments".
 */
const DEPARTMENT_SUGGESTION_LIMIT = 200;

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
    // Null, never an empty framing: six empty buckets would be written into the column on the next save
    // for a decision nobody made (lib/media/framing-schema.ts).
    photoScreens: null,
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

  /**
   * The departments already in use, for the suggestion list on the field below.
   *
   * ⚠ READ HERE RATHER THAN FETCHED BY THE EDITOR, which is the house rule for a vocabulary list and
   * also contract §9: a Server Component reads the database directly, and only an interactive screen
   * whose list can change under the reader fetches over HTTP. The album editor's category list is the
   * same shape (app/studio/gallery/[id]/page.tsx).
   *
   * ⚠ NOT FILTERED TO PUBLISHED OR VISIBLE PEOPLE. This is the vocabulary an editor has been using, and a
   * colleague still in draft is exactly whose spelling the next editor should be offered. Soft-deleted
   * rows ARE excluded: a department that only survives in the recycle bin is not one anybody should be
   * nudged towards.
   *
   * It runs for `/studio/people/new` too, where it matters most — a new profile is where a fifth
   * spelling of one Centre gets typed.
   */
  const [person, departmentRows] = await Promise.all([
    isNew
    ? null
    : prisma.person.findFirst({
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
          // The portrait's per-screen framing, so the panel opens on what is actually stored. Fetched with
          // the photograph it frames — a form handed the picture and not the framing would show an empty
          // panel over a framed portrait and invite an editor to set it again.
          photoScreens: true,
          // `fileName` on top of the shared fragment: the media picker shows it beside the thumbnail.
          photo: { select: { ...MEDIA_IMAGE_SELECT_WITH_ID, fileName: true } },
          _count: { select: { projects: true, publications: true, events: true } }
        }
      }),
    prisma.person.findMany({
      where: { deletedAt: null, NOT: { department: null } },
      select: { department: true },
      distinct: ["department"],
      orderBy: { department: "asc" },
      take: DEPARTMENT_SUGGESTION_LIMIT + 1
    })
  ]);

  if (!isNew && !person) notFound();

  /**
   * One suggestion per real unit, not one per spelling.
   *
   * `canonicalDepartmentLabels` groups the spellings that mean the same department and returns the most
   * descriptive of each (lib/people/departments.ts). Offering the raw `distinct` list instead is what
   * produced four spellings of this Centre's own name in the first place: every editor picked whichever
   * of them the list happened to show first.
   */
  const departmentSuggestions = canonicalDepartmentLabels(
    departmentRows.slice(0, DEPARTMENT_SUGGESTION_LIMIT).map((row) => row.department)
  );

  // `take: LIMIT + 1`, so "there are more" is a fact rather than a guess about whether the cap was hit.
  const departmentSuggestionsTruncated = departmentRows.length > DEPARTMENT_SUGGESTION_LIMIT;

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
        /**
         * The stored framing, typed.
         *
         * A cast rather than a parse: Prisma answers a JSONB column as `JsonValue`, and nothing
         * downstream trusts the shape — the panel reads each bucket through `storedCrop` and the API
         * validates the value with `screenFramingField()` on the way back in.
         */
        photoScreens: (person.photoScreens ?? null) as unknown as ScreenFraming | null,
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
        departmentSuggestions={departmentSuggestions}
        departmentSuggestionsTruncated={departmentSuggestionsTruncated}
      />
    </div>
  );
}
