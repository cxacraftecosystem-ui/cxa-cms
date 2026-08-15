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
import { canManageResearch, canPublish } from "@/lib/permissions";
import { indexDocument, removeDocument, searchDocFromPublication, searchUrlFor } from "@/lib/search/index";
import { unique } from "@/lib/utils";

/**
 * One publication: read it, save it, or move it to the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ RENAMING A PUBLISHED PUBLICATION MATTERS MORE HERE THAN ANYWHERE ELSE IN THE STUDIO. Its address is
 * what appears in somebody else's bibliography, and a citation that stops resolving makes the institution
 * look careless. So a rename of a live record leaves a redirect behind by default, re-points any redirect
 * that already aimed at the old address, and removes a redirect that would make the new address bounce off
 * itself — all in the same transaction as the rename.
 *
 * ⚠ `authorLine` AND THE LINKED PEOPLE STAY SEPARATE. The line is the printed credit and is authoritative;
 * the links are the subset who work here. Deleting or unlinking a person NEVER changes the line, which is
 * exactly the property that stops an external co-author disappearing from a citation (schema).
 *
 * ⚠ `bibtex` IS NEVER GENERATED AND STORED. An empty column is normal and means "generate one at read
 * time" (lib/citation.ts). Writing a generated entry into the column would freeze today's output into the
 * record and, for an imported publication, replace a canonical citation key other people already cite.
 *
 * `PATCH` IS PARTIAL: the editor sends the whole payload on every autosave, the list screen's Archive
 * button sends `{ status: "ARCHIVED" }` alone, and both must work.
 *
 * ⚠ THE VALIDATION RULES BELOW ARE DUPLICATED FROM THE SIBLING COLLECTION ROUTE, DELIBERATELY: a
 * `route.ts` is validated by Next against the shape of a route module, so importing shared code out of one
 * is a dependency on behaviour Next does not promise. If a rule changes in one, change it in the other in
 * the same commit.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const MAX_AUTHOR_LINKS = 100;
const MAX_KEYWORDS = 40;
const MIN_YEAR = 1500;

const CONTENT_STATUSES = ["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"] as const;

const PUBLICATION_KINDS = [
  "JOURNAL_ARTICLE",
  "CONFERENCE_PAPER",
  "BOOK",
  "BOOK_CHAPTER",
  "PATENT",
  "DATASET",
  "SOFTWARE",
  "PREPRINT",
  "THESIS",
  "REPORT"
] as const;

const slugField = z
  .string()
  .trim()
  .min(1, "The web address is empty. It is the part after /publications/ and it cannot be blank.")
  .max(96, "Keep the web address to 96 characters or fewer.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "A web address can only use lower-case letters, numbers and single hyphens — “sharma-2024-bagru”, not “Sharma 2024”."
  );

const idField = z.string().trim().min(1).max(64);

const PatchBody = z.object({
  title: z.string().trim().min(1, "The publication needs a title.").max(500).optional(),
  slug: slugField.optional(),
  kind: z.enum(PUBLICATION_KINDS).optional(),
  abstract: z.string().trim().max(8000).nullable().optional(),
  authorLine: z
    .string()
    .trim()
    .min(1, "The author line is what every citation prints. It cannot be empty.")
    .max(4000)
    .optional(),
  venue: z.string().trim().max(500).nullable().optional(),
  publisher: z.string().trim().max(300).nullable().optional(),
  volume: z.string().trim().max(40).nullable().optional(),
  issue: z.string().trim().max(40).nullable().optional(),
  pages: z.string().trim().max(60).nullable().optional(),
  year: z
    .number()
    .int("A year has to be a whole number.")
    .min(MIN_YEAR, `A year before ${MIN_YEAR} is almost always a typing mistake. Check it.`)
    .max(new Date().getUTCFullYear() + 1, "A year more than one year ahead is almost always a typing mistake.")
    .optional(),
  month: z.number().int().min(1, "A month is 1 to 12.").max(12, "A month is 1 to 12.").nullable().optional(),
  doi: z.string().trim().max(300).nullable().optional(),
  isbn: z.string().trim().max(40).nullable().optional(),
  issn: z.string().trim().max(40).nullable().optional(),
  patentNumber: z.string().trim().max(80).nullable().optional(),
  arxivId: z.string().trim().max(60).nullable().optional(),
  url: z.string().trim().max(1000).nullable().optional(),
  bibtex: z.string().trim().max(20000).nullable().optional(),
  keywords: z.array(z.string().trim().min(1).max(80)).max(MAX_KEYWORDS).optional(),
  pdfFileId: idField.nullable().optional(),
  researchAreaId: idField.nullable().optional(),
  authorIds: z.array(idField).max(MAX_AUTHOR_LINKS).optional(),
  isFeatured: z.boolean().optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  /** Defaults to true where it applies. A broken citation is never the safer default. */
  createRedirect: z.boolean().optional()
});

type PublicationInput = z.infer<typeof PatchBody>;

const INDEX_SELECT = {
  id: true,
  slug: true,
  title: true,
  kind: true,
  abstract: true,
  authorLine: true,
  venue: true,
  publisher: true,
  year: true,
  doi: true,
  arxivId: true,
  keywords: true,
  status: true,
  publishedAt: true,
  deletedAt: true,
  researchArea: { select: { title: true } }
} satisfies Prisma.PublicationSelect;

/** Bare and lower-cased: DOIs are case-insensitive by specification, and a stored URL renders twice over. */
function normaliseDoi(value: string | null | undefined): string | null {
  if (!value) return null;
  const bare = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim()
    .toLowerCase();
  return bare.length > 0 ? bare : null;
}

function normaliseArxiv(value: string | null | undefined): string | null {
  if (!value) return null;
  const bare = value.trim().replace(/^arxiv:\s*/i, "").trim();
  return bare.length > 0 ? bare : null;
}

async function assertPublicationReferences(body: PublicationInput): Promise<void> {
  if (body.researchAreaId) {
    const area = await prisma.researchArea.findFirst({
      where: { id: body.researchAreaId, deletedAt: null },
      select: { id: true }
    });
    if (!area) throw badRequest("The research area this was filed under no longer exists. Choose another.");
  }

  if (body.pdfFileId) {
    const file = await prisma.fileAsset.findFirst({
      where: { id: body.pdfFileId, deletedAt: null },
      select: { id: true }
    });
    if (!file) {
      throw badRequest("The attached document is no longer in the file store. Choose another, or take it off.");
    }
  }

  const authorIds = unique(body.authorIds ?? []);
  if (authorIds.length > 0) {
    const people = await prisma.person.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, name: true, deletedAt: true }
    });
    const byId = new Map(people.map((person) => [person.id, person]));
    const binned = authorIds.map((id) => byId.get(id)).filter((row) => row?.deletedAt);
    const missing = authorIds.filter((id) => !byId.has(id));

    if (binned.length > 0) {
      throw badRequest(
        `${binned.length === 1 ? "One linked author is" : `${binned.length} linked authors are`} in the recycle bin: ` +
          `${binned.map((row) => row?.name).join(", ")}. Restore them, or unlink them — the printed author line is a ` +
          "separate field and is not affected either way."
      );
    }
    if (missing.length > 0) {
      throw badRequest(
        `${missing.length === 1 ? "One linked author no longer exists" : `${missing.length} linked authors no longer exist`}. ` +
          "Reload the page and save again. The printed author line is a separate field and is unaffected."
      );
    }
  }
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

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
  const source = searchUrlFor("publication", fromSlug);
  const destination = searchUrlFor("publication", toSlug);
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
    canManageResearch,
    "Publications need researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const publication = await prisma.publication.findFirst({
    where: { id, deletedAt: null },
    include: {
      researchArea: { select: { id: true, title: true } },
      // In stored order, so the editor opens on exactly what the profile pages will show.
      authors: {
        orderBy: { position: "asc" },
        select: { personId: true, position: true, person: { select: { id: true, name: true, slug: true } } }
      },
      projects: { select: { id: true, title: true }, orderBy: { title: "asc" } }
    }
  });

  if (!publication) throw notFound("That publication");
  return ok(publication);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Editing a publication needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseJson(request, PatchBody);

  const before = await prisma.publication.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw notFound("That publication");

  assertMayChangeStatus(user, body.status, before);

  if (body.slug && body.slug !== before.slug) {
    const taken = await prisma.publication.findUnique({
      where: { slug: body.slug },
      select: { id: true, title: true, deletedAt: true }
    });
    if (taken && taken.id !== id) {
      throw conflict(
        taken.deletedAt
          ? `The address /publications/${body.slug} belongs to “${taken.title}”, which is in the recycle bin.`
          : `The address /publications/${body.slug} is already used by “${taken.title}”. Choose a different one.`
      );
    }
  }

  await assertPublicationReferences(body);

  const doi = "doi" in body ? normaliseDoi(body.doi) : undefined;
  if (doi) {
    const sameDoi = await prisma.publication.findFirst({
      where: { doi, deletedAt: null, id: { not: id } },
      select: { title: true, year: true }
    });
    if (sameDoi) {
      throw conflict(
        `“${sameDoi.title}” (${sameDoi.year}) already has the DOI ${doi}. If these really are two different ` +
          "records — a preprint and the published version, for instance — clear the DOI on one of them first."
      );
    }
  }

  // The UNCHECKED variant: it is the one that exposes the raw `researchAreaId` and `pdfFileId` columns.
  const data: Prisma.PublicationUncheckedUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.kind !== undefined) data.kind = body.kind;
  if ("abstract" in body) data.abstract = body.abstract?.trim() || null;
  if (body.authorLine !== undefined) data.authorLine = body.authorLine;
  if ("venue" in body) data.venue = body.venue?.trim() || null;
  if ("publisher" in body) data.publisher = body.publisher?.trim() || null;
  if ("volume" in body) data.volume = body.volume?.trim() || null;
  if ("issue" in body) data.issue = body.issue?.trim() || null;
  if ("pages" in body) data.pages = body.pages?.trim() || null;
  if (body.year !== undefined) data.year = body.year;
  if ("month" in body) data.month = body.month ?? null;
  if ("doi" in body) data.doi = doi ?? null;
  if ("isbn" in body) data.isbn = body.isbn?.trim() || null;
  if ("issn" in body) data.issn = body.issn?.trim() || null;
  if ("patentNumber" in body) data.patentNumber = body.patentNumber?.trim() || null;
  if ("arxivId" in body) data.arxivId = normaliseArxiv(body.arxivId);
  if ("url" in body) data.url = body.url?.trim() || null;
  // Whatever the editor typed, verbatim, or empty. Never a generated entry — see the header.
  if ("bibtex" in body) data.bibtex = body.bibtex?.trim() || null;
  if (body.keywords) {
    data.keywords = unique(body.keywords.map((keyword) => keyword.trim()).filter(Boolean));
  }
  if ("pdfFileId" in body) data.pdfFileId = body.pdfFileId ?? null;
  if ("researchAreaId" in body) data.researchAreaId = body.researchAreaId ?? null;
  if (body.isFeatured !== undefined) data.isFeatured = body.isFeatured;

  if (body.status !== undefined) {
    data.status = body.status;
    // Stamped once. It is the record's own publication date as far as the site is concerned, not a mirror
    // of the status column, so it is never cleared on unpublishing.
    if (body.status === "PUBLISHED" && before.publishedAt === null) data.publishedAt = new Date();
  }

  const renamed = body.slug !== undefined && body.slug !== before.slug;
  const shouldRedirect = renamed && body.createRedirect !== false && isLive(before);
  const authorIds = body.authorIds ? unique(body.authorIds) : null;

  const updated = await mutateWithHistory<Prisma.PublicationGetPayload<{ select: typeof INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action:
        body.status === "PUBLISHED" && before.status !== "PUBLISHED"
          ? "PUBLISH"
          : body.status === "ARCHIVED" && before.status !== "ARCHIVED"
            ? "ARCHIVE"
            : "UPDATE",
      entityType: "Publication",
      entityLabel: body.title ?? before.title,
      before,
      summary: renamed ? `Address changed from ${before.slug}` : "Edited"
    },
    async (tx) => {
      if (Object.keys(data).length > 0) await tx.publication.update({ where: { id }, data });

      if (authorIds) {
        // Replaced whole, with positions from the array order. `@@id([publicationId, personId])` means one
        // row per person, so the list is de-duplicated before it gets here.
        await tx.publicationAuthor.deleteMany({ where: { publicationId: id } });
        if (authorIds.length > 0) {
          await tx.publicationAuthor.createMany({
            data: authorIds.map((personId, position) => ({ publicationId: id, personId, position }))
          });
        }
      }

      if (shouldRedirect) await recordRename(tx, before.slug, body.slug ?? before.slug);

      const row = await tx.publication.findUniqueOrThrow({ where: { id }, select: INDEX_SELECT });
      await indexDocument(tx, searchDocFromPublication(row));
      return row;
    }
  );

  return ok({
    ...updated,
    ...(shouldRedirect
      ? {
          redirectCreated: {
            from: searchUrlFor("publication", before.slug),
            to: searchUrlFor("publication", updated.slug)
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
    "Removing a publication needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const publication = await prisma.publication.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      year: true,
      status: true,
      doi: true,
      _count: { select: { authors: true, projects: true } }
    }
  });
  if (!publication) throw notFound("That publication");

  const wasLive = isLive({ status: publication.status, publishedAt: null });

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "Publication",
      entityLabel: publication.title,
      before: {
        slug: publication.slug,
        title: publication.title,
        year: publication.year,
        doi: publication.doi
      },
      revise: false
    },
    async (tx) => {
      const row = await tx.publication.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true }
      });
      // The author links and project links are left attached: they cascade only on a REAL delete, which is
      // the purge job's business, so a restore brings the whole record back rather than a stripped one.
      await removeDocument(tx, "publication", id);
      return row;
    }
  );

  return ok({
    deleted: true,
    id: publication.id,
    title: publication.title,
    linkedAuthors: publication._count.authors,
    linkedProjects: publication._count.projects,
    message:
      `“${publication.title}” is in the recycle bin and has gone from the site. ` +
      (wasLive
        ? `The address /publications/${publication.slug} now answers “not found”, so anything citing it — ` +
          "including a printed bibliography — stops resolving. Restoring it brings the address back. "
        : "") +
      (publication._count.authors > 0
        ? `${publication._count.authors === 1 ? "1 person" : `${publication._count.authors} people`} linked to it ` +
          "will no longer show it on their profile; their records are untouched, and the printed author line " +
          "was never derived from those links. "
        : "") +
      (publication._count.projects > 0
        ? `${publication._count.projects === 1 ? "1 project lists it" : `${publication._count.projects} projects list it`} ` +
          "and will now show one fewer."
        : "")
  });
});
