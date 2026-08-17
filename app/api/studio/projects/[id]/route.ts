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
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { indexDocument, removeDocument, searchDocFromProject, searchUrlFor } from "@/lib/search/index";
import { clamp } from "@/lib/utils";

/**
 * One project: read it, save it, or move it to the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `PATCH` IS PARTIAL, AND EACH REPEATED SET IS ALL-OR-NOTHING. A key that is absent is left alone; a key
 * that is present REPLACES the whole set. That is what lets the list screen's "Archive" button send
 * `{ status: "ARCHIVED" }` without emptying the project's team, and lets the editor send the whole team
 * and have the removals actually happen.
 *
 * ⚠ THE HELPERS BELOW ARE DUPLICATED FROM THE SIBLING COLLECTION ROUTE, DELIBERATELY. A `route.ts` is
 * validated by Next against the shape of a route module, so importing shared code out of one is a
 * dependency on behaviour Next does not promise. The two copies are the same rules written twice: if a
 * validation rule changes in one, change it in the other in the same commit.
 *
 * RENAMING A LIVE PROJECT LEAVES A REDIRECT BEHIND, and re-points any redirect that already aimed at the
 * old address so a second rename does not build a chain. A draft is not redirected — nothing outside the
 * studio ever had that address.
 *
 * PUBLISHING AND UNPUBLISHING ARE THE SAME PERMISSION, checked on the TRANSITION. Editing the prose of a
 * published project needs no publish right; taking it off the site does.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const MAX_MEMBERS = 100;
const MAX_MILESTONES = 100;
const MAX_GALLERY = 200;
const MAX_LINKS = 200;
const MAX_FAQS = 50;

const CONTENT_STATUSES = ["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"] as const;

const slugField = z
  .string()
  .trim()
  .min(1, "The web address is empty. It is the part after /projects/ and it cannot be blank.")
  .max(96, "Keep the web address to 96 characters or fewer.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "A web address can only use lower-case letters, numbers and single hyphens — “bagru-block-printing”, not “Bagru Block Printing”."
  );

const richTextField = z.union([
  z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() }).passthrough(),
  z.null()
]);

const idField = z.string().trim().min(1).max(64);

const PatchBody = z.object({
  title: z.string().trim().min(1, "The project needs a title.").max(300).optional(),
  slug: slugField.optional(),
  tagline: z.string().trim().max(300).nullable().optional(),
  summary: z.string().trim().max(3000).nullable().optional(),
  body: richTextField.optional(),
  state: z.enum(["PROPOSED", "ACTIVE", "COMPLETED", "ON_HOLD"]).optional(),
  researchAreaId: idField.nullable().optional(),
  fundingBody: z.string().trim().max(300).nullable().optional(),
  fundingAmount: z.string().trim().max(80).nullable().optional(),
  fundingCurrency: z.string().trim().max(12).nullable().optional(),
  startedOn: z.coerce.date().nullable().optional(),
  endedOn: z.coerce.date().nullable().optional(),
  progress: z.number().int().nullable().optional(),
  coverId: idField.nullable().optional(),
  members: z
    .array(z.object({ personId: idField, role: z.string().trim().max(160).nullable().optional() }))
    .max(MAX_MEMBERS, `A project can name up to ${MAX_MEMBERS} people.`)
    .optional(),
  milestones: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        detail: z.string().trim().max(2000).nullable().optional(),
        dueOn: z.coerce.date().nullable().optional(),
        completedOn: z.coerce.date().nullable().optional()
      })
    )
    .max(MAX_MILESTONES, `A project can have up to ${MAX_MILESTONES} milestones.`)
    .optional(),
  media: z
    .array(z.object({ assetId: idField, caption: z.string().trim().max(600).nullable().optional() }))
    .max(MAX_GALLERY, `A project gallery can hold up to ${MAX_GALLERY} pictures.`)
    .optional(),
  fileIds: z.array(idField).max(MAX_LINKS).optional(),
  publicationIds: z.array(idField).max(MAX_LINKS).optional(),
  partnerIds: z.array(idField).max(MAX_LINKS).optional(),
  faqs: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(500),
        answer: z.string().trim().min(1).max(4000)
      })
    )
    .max(MAX_FAQS, `A project can have up to ${MAX_FAQS} questions and answers.`)
    .optional(),
  isFeatured: z.boolean().optional(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  /** Defaults to true where it applies: leaving a link broken is never the safer default. */
  createRedirect: z.boolean().optional()
});

type ProjectInput = z.infer<typeof PatchBody>;

const PROJECT_INDEX_SELECT = {
  id: true,
  slug: true,
  title: true,
  tagline: true,
  summary: true,
  body: true,
  state: true,
  fundingBody: true,
  status: true,
  publishedAt: true,
  deletedAt: true,
  researchArea: { select: { title: true } }
} satisfies Prisma.ProjectSelect;

/** A nullable `Json` column takes `Prisma.JsonNull`, never a bare `null` (contract §14). */
function jsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

/** Keep the FIRST occurrence of each id. The editor's order is the printed order, so first wins. */
function dedupeBy<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

async function assertReferencesExist(
  ids: readonly string[],
  noun: string,
  lookup: (ids: string[]) => Promise<{ id: string; label: string; deletedAt: Date | null }[]>
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await lookup([...new Set(ids)]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const missing: string[] = [];
  const binned: string[] = [];
  for (const id of new Set(ids)) {
    const row = byId.get(id);
    if (!row) missing.push(id);
    else if (row.deletedAt) binned.push(row.label);
  }

  if (binned.length > 0) {
    throw badRequest(
      `${binned.length === 1 ? `The ${noun} “${binned[0]}” is` : `${binned.length} of the ${noun}s you chose are`} ` +
        `in the recycle bin: ${binned.join(", ")}. Restore ${binned.length === 1 ? "it" : "them"} or take ` +
        `${binned.length === 1 ? "it" : "them"} off this project.`
    );
  }
  if (missing.length > 0) {
    throw badRequest(
      `${missing.length === 1 ? `One ${noun} on this project no longer exists` : `${missing.length} ${noun}s on this project no longer exist`}. ` +
        "Reload the page to see what is still there, then save again."
    );
  }
}

async function assertProjectReferences(body: ProjectInput): Promise<void> {
  if (body.researchAreaId) {
    const area = await prisma.researchArea.findFirst({
      where: { id: body.researchAreaId, deletedAt: null },
      select: { id: true }
    });
    if (!area) {
      throw badRequest("The research area this project was filed under no longer exists. Choose another.");
    }
  }

  if (body.coverId) {
    const cover = await prisma.mediaAsset.findFirst({
      where: { id: body.coverId, deletedAt: null },
      select: { id: true }
    });
    if (!cover) throw badRequest("The cover picture no longer exists in the media library. Choose another.");
  }

  await assertReferencesExist(
    (body.members ?? []).map((member) => member.personId),
    "person",
    (ids) =>
      prisma.person
        .findMany({ where: { id: { in: ids } }, select: { id: true, name: true, deletedAt: true } })
        .then((rows) => rows.map((row) => ({ id: row.id, label: row.name, deletedAt: row.deletedAt })))
  );

  await assertReferencesExist(
    (body.media ?? []).map((entry) => entry.assetId),
    "picture",
    (ids) =>
      prisma.mediaAsset
        .findMany({ where: { id: { in: ids } }, select: { id: true, fileName: true, deletedAt: true } })
        .then((rows) => rows.map((row) => ({ id: row.id, label: row.fileName, deletedAt: row.deletedAt })))
  );

  await assertReferencesExist(body.fileIds ?? [], "file", (ids) =>
    prisma.fileAsset
      .findMany({ where: { id: { in: ids } }, select: { id: true, title: true, deletedAt: true } })
      .then((rows) => rows.map((row) => ({ id: row.id, label: row.title, deletedAt: row.deletedAt })))
  );

  await assertReferencesExist(body.publicationIds ?? [], "publication", (ids) =>
    prisma.publication
      .findMany({ where: { id: { in: ids } }, select: { id: true, title: true, deletedAt: true } })
      .then((rows) => rows.map((row) => ({ id: row.id, label: row.title, deletedAt: row.deletedAt })))
  );

  await assertReferencesExist(body.partnerIds ?? [], "partner", (ids) =>
    prisma.partner
      .findMany({ where: { id: { in: ids } }, select: { id: true, name: true, deletedAt: true } })
      .then((rows) => rows.map((row) => ({ id: row.id, label: row.name, deletedAt: row.deletedAt })))
  );
}

/** Replace only the sets the payload carried. Positions come from the array order, never from the wire. */
async function replaceProjectSets(tx: TxClient, projectId: string, body: ProjectInput): Promise<void> {
  if (body.members) {
    const members = dedupeBy(body.members, (member) => member.personId);
    await tx.projectMember.deleteMany({ where: { projectId } });
    if (members.length > 0) {
      await tx.projectMember.createMany({
        data: members.map((member, position) => ({
          projectId,
          personId: member.personId,
          role: member.role?.trim() || null,
          position
        }))
      });
    }
  }

  if (body.milestones) {
    await tx.projectMilestone.deleteMany({ where: { projectId } });
    if (body.milestones.length > 0) {
      await tx.projectMilestone.createMany({
        data: body.milestones.map((milestone, position) => ({
          projectId,
          title: milestone.title,
          detail: milestone.detail?.trim() || null,
          dueOn: milestone.dueOn ?? null,
          completedOn: milestone.completedOn ?? null,
          position
        }))
      });
    }
  }

  if (body.media) {
    const media = dedupeBy(body.media, (entry) => entry.assetId);
    await tx.projectMedia.deleteMany({ where: { projectId } });
    if (media.length > 0) {
      await tx.projectMedia.createMany({
        data: media.map((entry, position) => ({
          projectId,
          assetId: entry.assetId,
          caption: entry.caption?.trim() || null,
          position
        }))
      });
    }
  }

  if (body.fileIds) {
    const fileIds = [...new Set(body.fileIds)];
    await tx.projectFile.deleteMany({ where: { projectId } });
    if (fileIds.length > 0) {
      await tx.projectFile.createMany({
        data: fileIds.map((fileId, position) => ({ projectId, fileId, position }))
      });
    }
  }

  if (body.partnerIds) {
    const partnerIds = [...new Set(body.partnerIds)];
    await tx.projectPartner.deleteMany({ where: { projectId } });
    if (partnerIds.length > 0) {
      await tx.projectPartner.createMany({
        data: partnerIds.map((partnerId, position) => ({ projectId, partnerId, position }))
      });
    }
  }

  if (body.faqs) {
    await tx.projectFaq.deleteMany({ where: { projectId } });
    if (body.faqs.length > 0) {
      await tx.projectFaq.createMany({
        data: body.faqs.map((faq, position) => ({
          projectId,
          question: faq.question,
          answer: faq.answer,
          position
        }))
      });
    }
  }

  if (body.publicationIds) {
    await tx.project.update({
      where: { id: projectId },
      data: { publications: { set: [...new Set(body.publicationIds)].map((id) => ({ id })) } }
    });
  }
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

/**
 * Refuse a publication-state CHANGE the reader is not allowed to make. Only a change is governed — saving
 * a published project with its status unchanged is an ordinary edit.
 */
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
      : "Taking something off the public site needs editor access, or permission to publish granted by an administrator."
  );
}

async function recordRename(tx: TxClient, fromSlug: string, toSlug: string): Promise<void> {
  const source = searchUrlFor("project", fromSlug);
  const destination = searchUrlFor("project", toSlug);
  if (source === destination) return;

  // Re-point anything that already aimed at the old address, so a second rename does not build a chain
  // browsers stop following.
  await tx.redirect.updateMany({ where: { destination: source }, data: { destination } });
  await tx.redirect.upsert({
    where: { source },
    create: { source, destination, permanent: true },
    update: { destination }
  });
  // Last, so a rename back to a previous address does not leave the page redirecting away from itself.
  await tx.redirect.deleteMany({ where: { source: destination } });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// `fileName` on top of the shared list: the editor labels the picked asset by its file name.
const EDITOR_MEDIA_SELECT = {
  select: { ...MEDIA_IMAGE_SELECT_WITH_ID, fileName: true }
};

export const GET = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(
    canManageResearch,
    "Projects need researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    include: {
      cover: EDITOR_MEDIA_SELECT,
      researchArea: { select: { id: true, title: true } },
      // Every repeated set comes back IN ITS STORED ORDER, so the editor opens on exactly what the site
      // prints. Sorting them in the browser instead would mean the two could disagree.
      members: {
        orderBy: { position: "asc" },
        select: { personId: true, role: true, position: true, person: { select: { id: true, name: true } } }
      },
      milestones: { orderBy: { position: "asc" } },
      media: {
        orderBy: { position: "asc" },
        select: { assetId: true, caption: true, position: true, asset: EDITOR_MEDIA_SELECT }
      },
      files: {
        orderBy: { position: "asc" },
        select: { fileId: true, position: true, file: { select: { id: true, title: true } } }
      },
      partners: {
        orderBy: { position: "asc" },
        select: { partnerId: true, position: true, partner: { select: { id: true, name: true } } }
      },
      faqs: { orderBy: { position: "asc" } },
      publications: { select: { id: true, title: true, year: true }, orderBy: { year: "desc" } }
    }
  });

  if (!project) throw notFound("That project");
  return ok(project);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Editing a project needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseJson(request, PatchBody);

  const before = await prisma.project.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw notFound("That project");

  assertMayChangeStatus(user, body.status, before);

  // Checked against the values that will actually be stored, not only the ones that were sent: a save
  // that only moves the end date must still be compared against the start date already on the record.
  const startedOn = "startedOn" in body ? (body.startedOn ?? null) : before.startedOn;
  const endedOn = "endedOn" in body ? (body.endedOn ?? null) : before.endedOn;
  if (startedOn && endedOn && endedOn < startedOn) {
    throw badRequest("The end date is before the start date. Check both before saving.");
  }

  if (body.slug && body.slug !== before.slug) {
    const taken = await prisma.project.findUnique({
      where: { slug: body.slug },
      select: { id: true, title: true, deletedAt: true }
    });
    if (taken && taken.id !== id) {
      throw conflict(
        taken.deletedAt
          ? `The address /projects/${body.slug} belongs to “${taken.title}”, which is in the recycle bin.`
          : `The address /projects/${body.slug} is already used by “${taken.title}”. Choose a different one.`
      );
    }
  }

  await assertProjectReferences(body);

  // The UNCHECKED variant: it is the one that exposes the raw `coverId` and `researchAreaId` columns.
  const data: Prisma.ProjectUncheckedUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.slug !== undefined) data.slug = body.slug;
  if ("tagline" in body) data.tagline = body.tagline?.trim() || null;
  if ("summary" in body) data.summary = body.summary?.trim() || null;
  if ("body" in body) data.body = jsonColumn(body.body);
  if (body.state !== undefined) data.state = body.state;
  if ("researchAreaId" in body) data.researchAreaId = body.researchAreaId ?? null;
  if ("fundingBody" in body) data.fundingBody = body.fundingBody?.trim() || null;
  if ("fundingAmount" in body) data.fundingAmount = body.fundingAmount?.trim() || null;
  if ("fundingCurrency" in body) data.fundingCurrency = body.fundingCurrency?.trim() || null;
  if ("startedOn" in body) data.startedOn = body.startedOn ?? null;
  if ("endedOn" in body) data.endedOn = body.endedOn ?? null;
  // Clamped on the server as well as in the editor: a bar that can read 140% is worse than no bar.
  if ("progress" in body) data.progress = clamp(body.progress ?? 0, 0, 100);
  if ("coverId" in body) data.coverId = body.coverId ?? null;
  if (body.isFeatured !== undefined) data.isFeatured = body.isFeatured;
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;

  if (body.status !== undefined) {
    data.status = body.status;
    // Stamped once, the first time it goes public, and never cleared: it is the publication date of the
    // work rather than a mirror of the status column.
    if (body.status === "PUBLISHED" && before.publishedAt === null) data.publishedAt = new Date();
  }

  const renamed = body.slug !== undefined && body.slug !== before.slug;
  const shouldRedirect = renamed && body.createRedirect !== false && isLive(before);

  const updated = await mutateWithHistory<Prisma.ProjectGetPayload<{ select: typeof PROJECT_INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action:
        body.status === "PUBLISHED" && before.status !== "PUBLISHED"
          ? "PUBLISH"
          : body.status === "ARCHIVED" && before.status !== "ARCHIVED"
            ? "ARCHIVE"
            : "UPDATE",
      entityType: "Project",
      entityLabel: body.title ?? before.title,
      before,
      summary: renamed ? `Address changed from ${before.slug}` : "Edited"
    },
    async (tx) => {
      if (Object.keys(data).length > 0) await tx.project.update({ where: { id }, data });
      await replaceProjectSets(tx, id, body);
      if (shouldRedirect) await recordRename(tx, before.slug, body.slug ?? before.slug);

      const row = await tx.project.findUniqueOrThrow({ where: { id }, select: PROJECT_INDEX_SELECT });
      await indexDocument(tx, searchDocFromProject(row));
      return row;
    }
  );

  return ok({
    ...updated,
    ...(shouldRedirect
      ? {
          redirectCreated: {
            from: searchUrlFor("project", before.slug),
            to: searchUrlFor("project", updated.slug)
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
    canManageResearch,
    "Removing a project needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      _count: { select: { members: true, publications: true, media: true, files: true } }
    }
  });
  if (!project) throw notFound("That project");

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "Project",
      entityLabel: project.title,
      before: { slug: project.slug, title: project.title, status: project.status },
      revise: false
    },
    async (tx) => {
      /**
       * `deletedAt` and nothing else. The team, the milestones, the gallery and the linked publications
       * all stay attached — they cascade only on a REAL delete, which is the purge job's business — so a
       * restore puts the project back exactly as it was rather than as an empty shell.
       */
      const row = await tx.project.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true }
      });
      await removeDocument(tx, "project", id);
      return row;
    }
  );

  return ok({
    deleted: true,
    id: project.id,
    title: project.title,
    membersAffected: project._count.members,
    publicationsAffected: project._count.publications,
    message:
      `“${project.title}” is in the recycle bin and has gone from the site. ` +
      (project._count.members > 0
        ? `${project._count.members === 1 ? "1 person" : `${project._count.members} people`} listed on it ` +
          "will no longer show it on their profile, and their own records are untouched. "
        : "") +
      (project._count.publications > 0
        ? `${project._count.publications === 1 ? "1 publication" : `${project._count.publications} publications`} ` +
          "linked to it stay on the site. "
        : "") +
      "Everything attached to it is kept, so restoring it brings the whole project back."
  });
});
