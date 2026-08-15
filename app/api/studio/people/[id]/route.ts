import type { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma, type ContentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  conflict,
  forbidden,
  notFound,
  ok,
  parseJson,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { requireCapability, type SessionUser } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { canManageContent, canPublish } from "@/lib/permissions";
import { indexDocument, removeDocument, searchDocFromPerson, searchUrlFor } from "@/lib/search/index";
import { unique } from "@/lib/utils";

/**
 * One profile: read it, save it, or move it to the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * DELETING A PROFILE CHANGES NO PRINTED CREDIT. `Publication.authorLine` is the authoritative author
 * string and is a separate column from the `PublicationAuthor` links — so a deleted profile leaves every
 * citation exactly as it was (schema). The links themselves are left attached, because they cascade only
 * on a REAL delete and leaving them is what makes a restore put the profile back where it was.
 *
 * THE USUAL ADVICE IS TO CHANGE THE GROUP TO ALUMNUS, NOT TO DELETE, and the answer says so: somebody who
 * has left keeps their years, their profile page and every link pointing at it.
 *
 * RENAMING A LIVE PROFILE LEAVES A REDIRECT BEHIND, re-points any redirect that already aimed at the old
 * address, and removes one that would make the new address bounce off itself. A person's page is linked
 * from projects, from publications and from other institutions' pages.
 *
 * `PATCH` IS PARTIAL: the editor sends the whole payload on every autosave and the people board's row
 * actions send `{ status: "ARCHIVED" }` alone. Both have to work.
 *
 * ⚠ THE VALIDATION RULES BELOW ARE DUPLICATED FROM THE SIBLING COLLECTION ROUTE, DELIBERATELY: a
 * `route.ts` is validated by Next against the shape of a route module, so importing shared code out of one
 * is a dependency on behaviour Next does not promise. Change both in the same commit.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const MAX_INTERESTS = 40;

const CONTENT_STATUSES = ["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"] as const;

const PERSON_KINDS = [
  "FACULTY",
  "SCIENTIST",
  "RESEARCH_ASSISTANT",
  "STUDENT",
  "STAFF",
  "VISITOR",
  "ALUMNUS"
] as const;

const slugField = z
  .string()
  .trim()
  .min(1, "The web address is empty. It is the part after /people/ and it cannot be blank.")
  .max(96, "Keep the web address to 96 characters or fewer.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "A web address can only use lower-case letters, numbers and single hyphens — “anita-sharma”, not “Anita Sharma”."
  );

const richTextField = z.union([
  z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() }).passthrough(),
  z.null()
]);

const urlField = z
  .string()
  .trim()
  .max(1000)
  .regex(/^https?:\/\/\S+$/i, "A web address has to begin with https:// so the link works from the profile page.")
  .nullable();

const PatchBody = z.object({
  name: z.string().trim().min(1, "The profile needs a name.").max(200).optional(),
  slug: slugField.optional(),
  kind: z.enum(PERSON_KINDS).optional(),
  designation: z.string().trim().max(200).nullable().optional(),
  department: z.string().trim().max(200).nullable().optional(),
  bio: z.string().trim().max(3000).nullable().optional(),
  bioRich: richTextField.optional(),
  researchInterests: z.array(z.string().trim().min(1).max(120)).max(MAX_INTERESTS).optional(),
  email: z
    .string()
    .trim()
    .max(254)
    .email("That does not look like an email address. Check for a missing @ or a typo in the domain — it is shown publicly.")
    .nullable()
    .optional(),
  phone: z.string().trim().max(60).nullable().optional(),
  website: urlField.optional(),
  linkedin: urlField.optional(),
  googleScholar: urlField.optional(),
  /** Stored as typed — the editor warns about a malformed one rather than blocking every other change. */
  orcid: z.string().trim().max(40).nullable().optional(),
  github: z.string().trim().max(200).nullable().optional(),
  photoId: z.string().trim().min(1).max(64).nullable().optional(),
  startedOn: z.coerce.date().nullable().optional(),
  endedOn: z.coerce.date().nullable().optional(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
  isVisible: z.boolean().optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  /** Defaults to true where it applies: leaving a link broken is never the safer default. */
  createRedirect: z.boolean().optional()
});

const INDEX_SELECT = {
  id: true,
  slug: true,
  name: true,
  kind: true,
  designation: true,
  department: true,
  bio: true,
  bioRich: true,
  researchInterests: true,
  isVisible: true,
  status: true,
  publishedAt: true,
  deletedAt: true
} satisfies Prisma.PersonSelect;

function jsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

/** Only a CHANGE of publication state is governed; saving a live profile's prose is an ordinary edit. */
function assertMayChangeStatus(
  user: SessionUser,
  next: ContentStatus | undefined,
  before: { status: ContentStatus; publishedAt: Date | null }
): void {
  if (next === undefined || next === before.status) return;
  if (canPublish(user)) return;

  const goingLive = next === "PUBLISHED" || next === "SCHEDULED";
  if (!goingLive && !isLive(before)) return;

  throw forbidden(
    goingLive
      ? "Publishing needs editor access, or permission to publish granted by an administrator. Leave it as a draft and ask an editor."
      : "Taking a profile off the public site needs editor access, or permission to publish granted by an administrator."
  );
}

async function recordRename(tx: TxClient, fromSlug: string, toSlug: string): Promise<void> {
  const source = searchUrlFor("person", fromSlug);
  const destination = searchUrlFor("person", toSlug);
  if (source === destination) return;

  await tx.redirect.updateMany({ where: { destination: source }, data: { destination } });
  await tx.redirect.upsert({
    where: { source },
    create: { source, destination, permanent: true },
    update: { destination }
  });
  await tx.redirect.deleteMany({ where: { source: destination } });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(
    canManageContent,
    "People need editor access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const person = await prisma.person.findFirst({
    where: { id, deletedAt: null },
    include: {
      photo: {
        select: {
          id: true,
          fileName: true,
          altText: true,
          objectKey: true,
          width: true,
          height: true,
          blurDataUrl: true,
          variants: {
            select: { label: true, format: true, objectKey: true, width: true },
            orderBy: { width: "asc" }
          }
        }
      },
      projects: {
        orderBy: { position: "asc" },
        select: { role: true, project: { select: { id: true, title: true, status: true } } }
      },
      publications: {
        orderBy: { position: "asc" },
        select: { publication: { select: { id: true, title: true, year: true, status: true } } }
      },
      events: {
        select: { role: true, event: { select: { id: true, title: true, startsAt: true } } }
      }
    }
  });

  if (!person) throw notFound("That profile");
  return ok(person);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Editing a profile needs editor access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseJson(request, PatchBody);

  const before = await prisma.person.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw notFound("That profile");

  assertMayChangeStatus(user, body.status, before);

  // Compared against the values that will actually be stored, so a save that only moves the leaving date
  // is still checked against the joining date already on the record.
  const startedOn = "startedOn" in body ? (body.startedOn ?? null) : before.startedOn;
  const endedOn = "endedOn" in body ? (body.endedOn ?? null) : before.endedOn;
  if (startedOn && endedOn && endedOn < startedOn) {
    throw badRequest("The leaving date is before the joining date. Check both before saving.");
  }

  if (body.slug && body.slug !== before.slug) {
    const taken = await prisma.person.findUnique({
      where: { slug: body.slug },
      select: { id: true, name: true, deletedAt: true }
    });
    if (taken && taken.id !== id) {
      throw conflict(
        taken.deletedAt
          ? `The address /people/${body.slug} belongs to ${taken.name}, whose profile is in the recycle bin.`
          : `The address /people/${body.slug} is already used by ${taken.name}. Add a middle initial or a second name to tell them apart.`
      );
    }
  }

  if (body.photoId) {
    const photo = await prisma.mediaAsset.findFirst({
      where: { id: body.photoId, deletedAt: null },
      select: { id: true }
    });
    if (!photo) throw badRequest("The photograph is no longer in the media library. Choose another.");
  }

  // The UNCHECKED variant: it is the one that exposes the raw `photoId` column.
  const data: Prisma.PersonUncheckedUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.kind !== undefined) data.kind = body.kind;
  if ("designation" in body) data.designation = body.designation?.trim() || null;
  if ("department" in body) data.department = body.department?.trim() || null;
  if ("bio" in body) data.bio = body.bio?.trim() || null;
  if ("bioRich" in body) data.bioRich = jsonColumn(body.bioRich);
  if (body.researchInterests) {
    data.researchInterests = unique(
      body.researchInterests.map((interest) => interest.trim()).filter(Boolean)
    );
  }
  if ("email" in body) data.email = body.email?.trim().toLowerCase() || null;
  if ("phone" in body) data.phone = body.phone?.trim() || null;
  if ("website" in body) data.website = body.website?.trim() || null;
  if ("linkedin" in body) data.linkedin = body.linkedin?.trim() || null;
  if ("googleScholar" in body) data.googleScholar = body.googleScholar?.trim() || null;
  if ("orcid" in body) data.orcid = body.orcid?.trim() || null;
  if ("github" in body) data.github = body.github?.trim() || null;
  if ("photoId" in body) data.photoId = body.photoId ?? null;
  if ("startedOn" in body) data.startedOn = body.startedOn ?? null;
  if ("endedOn" in body) data.endedOn = body.endedOn ?? null;
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;
  if (body.isVisible !== undefined) data.isVisible = body.isVisible;

  if (body.status !== undefined) {
    data.status = body.status;
    // Stamped once, the first time the profile goes public, and never cleared afterwards.
    if (body.status === "PUBLISHED" && before.publishedAt === null) data.publishedAt = new Date();
  }

  if (Object.keys(data).length === 0) return ok(before);

  const renamed = body.slug !== undefined && body.slug !== before.slug;
  const shouldRedirect = renamed && body.createRedirect !== false && isLive(before);

  const updated = await mutateWithHistory<Prisma.PersonGetPayload<{ select: typeof INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action:
        body.status === "PUBLISHED" && before.status !== "PUBLISHED"
          ? "PUBLISH"
          : body.status === "ARCHIVED" && before.status !== "ARCHIVED"
            ? "ARCHIVE"
            : "UPDATE",
      entityType: "Person",
      entityLabel: body.name ?? before.name,
      before,
      summary: renamed ? `Address changed from ${before.slug}` : "Edited"
    },
    async (tx) => {
      const row = await tx.person.update({ where: { id }, data, select: INDEX_SELECT });
      if (shouldRedirect) await recordRename(tx, before.slug, row.slug);
      await indexDocument(tx, searchDocFromPerson(row));
      return row;
    }
  );

  return ok({
    ...updated,
    ...(shouldRedirect
      ? {
          redirectCreated: {
            from: searchUrlFor("person", before.slug),
            to: searchUrlFor("person", updated.slug)
          }
        }
      : {})
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — soft, always
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Removing a profile needs editor access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const person = await prisma.person.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      slug: true,
      name: true,
      kind: true,
      status: true,
      _count: { select: { projects: true, publications: true, events: true } }
    }
  });
  if (!person) throw notFound("That profile");

  const wasLive = isLive({ status: person.status, publishedAt: null });

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "Person",
      entityLabel: person.name,
      before: { slug: person.slug, name: person.name, kind: person.kind, status: person.status },
      revise: false
    },
    async (tx) => {
      const row = await tx.person.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true }
      });
      /**
       * The project, publication and event links are left attached. They cascade only on a REAL delete,
       * which is the purge job's business, so a restore puts the profile back on every project and paper
       * it was on. No printed author line changes either way — that is a separate column.
       */
      await removeDocument(tx, "person", id);
      return row;
    }
  );

  return ok({
    deleted: true,
    id: person.id,
    name: person.name,
    projectsAffected: person._count.projects,
    publicationsAffected: person._count.publications,
    eventsAffected: person._count.events,
    message:
      `${person.name}'s profile is in the recycle bin and has gone from the site. ` +
      (wasLive ? `The address /people/${person.slug} now answers “not found”. ` : "") +
      (person._count.projects + person._count.publications + person._count.events > 0
        ? `They were named on ${person._count.projects} project(s), ${person._count.publications} publication(s) ` +
          `and ${person._count.events} event(s). Those records are untouched and stay on the site — and no printed ` +
          "author line changes, because that credit is a separate field and never comes from a profile. "
        : "") +
      "If they have simply left the Centre, restoring this and changing their group to Alumni keeps the record " +
      "and every link to it."
  });
});
