import type { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  assertSameOrigin,
  badRequest,
  clientIp,
  conflict,
  forbidden,
  ok,
  parseJson,
  parseQuery,
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { indexDocument, searchDocFromProject } from "@/lib/search/index";
import { clamp } from "@/lib/utils";

/**
 * Projects: the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A PROJECT IS SEVEN TABLES, AND ALL OF THEM ARE WRITTEN IN ONE TRANSACTION. The team, the milestones,
 * the gallery, the linked files, the linked publications, the partners and the FAQs are sent WHOLE, with
 * explicit positions, and each set is replaced rather than merged. Two reasons:
 *
 *   • THE POSITION IS THE ORDER THE SITE PRINTS. Merging would need a per-row diff, and a diff that gets
 *     one row wrong leaves two members claiming position 3 — which renders differently on every request
 *     because the sort is no longer total.
 *   • A FAILED SAVE MUST CHANGE NOTHING. `mutateWithHistory` opens the transaction; a partial write here
 *     would leave a project with the new team and the old milestones and no way to tell which save it
 *     came from.
 *
 * THE POSITIONS ARE RE-NUMBERED FROM THE ARRAY ORDER, not taken from the `position` the browser sent.
 * The array order is what the editor dragged; a number is a claim about it that can disagree.
 *
 * A CHOSEN RECORD THAT NO LONGER EXISTS IS A REFUSAL, NOT A SILENT OMISSION. An editor who picked six
 * people and finds four on the page has been lied to by the save (contract §1.6). So every referenced id
 * is checked, and the message names what is wrong.
 *
 * ⚠ `fundingAmount` IS TEXT AND STAYS TEXT. A numeric column would have to pick a currency and every
 * grant that is not in it becomes wrong by exactly the exchange rate on an unknown day (schema).
 * "£450,000" and "1.2 crore" are both valid and both appear exactly as typed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Caps on the repeated sets. A cap that is checked beats a payload that takes a minute to write. */
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

/** Envelope only; the node tree is `components/RichText.tsx`'s business. See lib/sections/schema.ts. */
const richTextField = z.union([
  z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() }).passthrough(),
  z.null()
]);

const idField = z.string().trim().min(1).max(64);

const ProjectBody = z.object({
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
  /** Clamped rather than refused: a bar that can read 140% is worse than no bar (schema). */
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
  createRedirect: z.boolean().optional()
});

type ProjectInput = z.infer<typeof ProjectBody>;

/** The columns `searchDocFromProject` reads, plus the research area's title it folds into the keywords. */
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

/**
 * Refuse a save that references records which are gone, and NAME them where a name survives.
 *
 * A soft-deleted row still has its title, so "Anita Sharma is in the recycle bin" is possible and is far
 * more use than a count. An id that matches nothing at all can only be counted — but it can at least be
 * distinguished from the recoverable case, which leads to a different next step.
 */
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

/**
 * Validate every id the payload points at, in one place so `POST` and `PATCH` cannot disagree.
 */
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

/**
 * Replace the repeated sets. Only the ones the payload actually carried are touched, so a row action
 * that sends `{ status }` cannot empty a project's team.
 *
 * Positions are assigned from the array index — see the header.
 */
async function replaceProjectSets(
  tx: TxClient,
  projectId: string,
  body: ProjectInput
): Promise<void> {
  if (body.members) {
    // `@@id([projectId, personId])` means one row per person; a duplicated pick would fail the insert
    // and roll the whole save back, so the same person named twice keeps their first position.
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
    // An implicit many-to-many, so `set` replaces the whole join in one statement. It carries no
    // position column — publications are listed by year and never by hand.
    await tx.project.update({
      where: { id: projectId },
      data: { publications: { set: [...new Set(body.publicationIds)].map((id) => ({ id })) } }
    });
  }
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const boundedInt = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,6}$/, `${label} has to be a whole number.`)
    .refine((value) => {
      const parsed = Number.parseInt(value, 10);
      return parsed >= min && parsed <= max;
    }, `${label} has to be between ${min} and ${max}.`)
    .optional();

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  state: z.enum(["PROPOSED", "ACTIVE", "COMPLETED", "ON_HOLD"]).optional(),
  area: z.string().trim().max(64).optional(),
  page: boundedInt("The page number", 1, 100000),
  pageSize: boundedInt("The page size", 1, MAX_PAGE_SIZE)
});

export const GET = route(async (request: Request) => {
  await requireCapability(
    canManageResearch,
    "Projects need researcher access or higher. An administrator can raise yours."
  );

  const raw = parseQuery(request, ListQuery);
  const page = toInt(raw.page, 1);
  const pageSize = toInt(raw.pageSize, DEFAULT_PAGE_SIZE);

  const where: Prisma.ProjectWhereInput = { deletedAt: null };
  if (raw.status) where.status = raw.status;
  if (raw.state) where.state = raw.state;
  if (raw.area) where.researchAreaId = raw.area;
  if (raw.q) {
    where.OR = [
      { title: { contains: raw.q, mode: "insensitive" } },
      { tagline: { contains: raw.q, mode: "insensitive" } },
      { summary: { contains: raw.q, mode: "insensitive" } },
      { slug: { contains: raw.q, mode: "insensitive" } },
      { fundingBody: { contains: raw.q, mode: "insensitive" } }
    ];
  }

  const [items, total] = await Promise.all([
    prisma.project.findMany({
      where,
      // Featured first, then the editorial order, then the title. Total and stable, so the list never
      // reshuffles between two requests.
      orderBy: [{ isFeatured: "desc" }, { sortOrder: "asc" }, { title: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        slug: true,
        title: true,
        tagline: true,
        state: true,
        progress: true,
        startedOn: true,
        endedOn: true,
        fundingBody: true,
        isFeatured: true,
        sortOrder: true,
        status: true,
        publishedAt: true,
        updatedAt: true,
        coverId: true,
        researchArea: { select: { id: true, title: true } },
        _count: { select: { members: true, milestones: true, publications: true } }
      }
    }),
    prisma.project.count({ where })
  ]);

  return ok({ items, total, page, pageSize });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Creating a project needs researcher access or higher. An administrator can raise yours."
  );

  const body = await parseJson(request, ProjectBody);

  // Required on create even though the schema is partial for `PATCH`'s sake. Spelled out rather than
  // split into two schemas, so the two paths cannot drift on a field's rules.
  if (!body.title) throw badRequest("The project needs a title before it can be created.");
  if (!body.slug) throw badRequest("The project needs a web address before it can be created.");

  const status = body.status ?? "DRAFT";
  if ((status === "PUBLISHED" || status === "SCHEDULED") && !canPublish(user)) {
    throw forbidden(
      "Publishing needs editor access, or permission to publish granted by an administrator. " +
        "Save it as a draft and ask an editor to publish it."
    );
  }

  if (body.startedOn && body.endedOn && body.endedOn < body.startedOn) {
    throw badRequest("The end date is before the start date. Check both before saving.");
  }

  const taken = await prisma.project.findUnique({
    where: { slug: body.slug },
    select: { id: true, title: true, deletedAt: true }
  });
  if (taken) {
    throw conflict(
      taken.deletedAt
        ? `The address /projects/${body.slug} belongs to “${taken.title}”, which is in the recycle bin. Restore it, or choose a different address.`
        : `The address /projects/${body.slug} is already used by “${taken.title}”. Choose a different one.`
    );
  }

  await assertProjectReferences(body);

  const slug = body.slug;
  const title = body.title;

  const created = await mutateWithHistory<Prisma.ProjectGetPayload<{ select: typeof PROJECT_INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    { action: "CREATE", entityType: "Project", entityLabel: title, summary: "Created" },
    async (tx) => {
      const project = await tx.project.create({
        data: {
          title,
          slug,
          tagline: body.tagline?.trim() || null,
          summary: body.summary?.trim() || null,
          body: jsonColumn(body.body),
          state: body.state ?? "ACTIVE",
          researchAreaId: body.researchAreaId ?? null,
          fundingBody: body.fundingBody?.trim() || null,
          fundingAmount: body.fundingAmount?.trim() || null,
          fundingCurrency: body.fundingCurrency?.trim() || null,
          startedOn: body.startedOn ?? null,
          endedOn: body.endedOn ?? null,
          progress: clamp(body.progress ?? 0, 0, 100),
          coverId: body.coverId ?? null,
          isFeatured: body.isFeatured ?? false,
          sortOrder: body.sortOrder ?? 0,
          status,
          // Stamped by the server: "when did this first go public" is a fact about the system, not about
          // somebody's laptop clock.
          publishedAt: status === "PUBLISHED" ? new Date() : null
        },
        select: { id: true }
      });

      await replaceProjectSets(tx, project.id, body);

      const row = await tx.project.findUniqueOrThrow({
        where: { id: project.id },
        select: PROJECT_INDEX_SELECT
      });
      // The index row joins the same transaction as the write it describes (lib/search/index.ts).
      await indexDocument(tx, searchDocFromProject(row));
      return row;
    }
  );

  return ok(created, { status: 201 });
});
