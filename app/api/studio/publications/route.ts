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
import { mutateWithHistory, type AuditContext } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { indexDocument, searchDocFromPublication } from "@/lib/search/index";
import { unique } from "@/lib/utils";

/**
 * Publications: the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ `authorLine` AND `authorIds` ARE TWO DIFFERENT LISTS AND NEITHER IS DERIVED FROM THE OTHER.
 *
 *   • `authorLine` is the AUTHORITATIVE printed credit, in order, exactly as it appears on the work.
 *     Every citation on the public site is built from this string and nothing else.
 *   • `authorIds` links the subset of those authors who have a profile at the Centre, which is what puts
 *     the publication on their profile page and makes it findable by the author filter.
 *
 * Deriving the line from the links would drop every external co-author and misattribute somebody else's
 * work under this institution's name (schema, `Publication`). So `authorLine` is REQUIRED and the links
 * are optional, and this route never writes one from the other.
 *
 * ⚠ `bibtex` IS AUTHORITATIVE WHEN PRESENT AND EMPTY IS NORMAL. An imported record carries a canonical
 * citation key that other people's manuscripts already `\cite{}`, so a stored string is kept verbatim and
 * `lib/citation.ts` generates one only when the column is empty. Nothing here generates and stores one:
 * that would freeze today's output into the record for ever.
 *
 * THE DOI IS NORMALISED TO ITS BARE FORM. Editors paste it three ways — bare, as a doi.org URL, and with
 * a `doi:` prefix — and a record that stores the URL renders
 * "https://doi.org/https://doi.org/10.1234/x" in every citation. Stored bare, it is also comparable,
 * which is what makes the import's duplicate check work.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_AUTHOR_LINKS = 100;
const MAX_KEYWORDS = 40;

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

/**
 * The earliest year a publication may claim.
 *
 * 1500 rather than 0: a year typed as "20" or "202" is a typo, not a Roman treatise, and refusing it here
 * is the only place the mistake is catchable before it appears in a citation. The ceiling is next year,
 * because a paper accepted for the coming volume is a real and common case.
 */
const MIN_YEAR = 1500;

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

const PublicationBody = z.object({
  title: z.string().trim().min(1, "The publication needs a title.").max(500).optional(),
  slug: slugField.optional(),
  kind: z.enum(PUBLICATION_KINDS).optional(),
  abstract: z.string().trim().max(8000).nullable().optional(),
  authorLine: z
    .string()
    .trim()
    .min(1, "The author line is what every citation prints. It cannot be empty.")
    .max(4000, "Keep the author line to 4 000 characters or fewer.")
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
  /** Centre people, in printed order. NOT the author line — see the header. */
  authorIds: z.array(idField).max(MAX_AUTHOR_LINKS).optional(),
  isFeatured: z.boolean().optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  createRedirect: z.boolean().optional()
});

type PublicationInput = z.infer<typeof PublicationBody>;

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

/**
 * A DOI reduced to its bare form. See the header for why the column may not hold what was pasted.
 *
 * Lower-cased as well: DOIs are case-insensitive by specification, and comparing them case-sensitively is
 * what lets the same paper be imported twice.
 */
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

/** The arXiv identifier without the prefix editors include about half the time. */
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
  kind: z.enum(PUBLICATION_KINDS).optional(),
  year: boundedInt("The year", MIN_YEAR, 9999),
  area: z.string().trim().max(64).optional(),
  page: boundedInt("The page number", 1, 100000),
  pageSize: boundedInt("The page size", 1, MAX_PAGE_SIZE)
});

export const GET = route(async (request: Request) => {
  await requireCapability(
    canManageResearch,
    "Publications need researcher access or higher. An administrator can raise yours."
  );

  const raw = parseQuery(request, ListQuery);
  const page = toInt(raw.page, 1);
  const pageSize = toInt(raw.pageSize, DEFAULT_PAGE_SIZE);

  const where: Prisma.PublicationWhereInput = { deletedAt: null };
  if (raw.status) where.status = raw.status;
  if (raw.kind) where.kind = raw.kind;
  if (raw.year !== undefined) where.year = toInt(raw.year, 0);
  if (raw.area) where.researchAreaId = raw.area;
  if (raw.q) {
    where.OR = [
      { title: { contains: raw.q, mode: "insensitive" } },
      { authorLine: { contains: raw.q, mode: "insensitive" } },
      { venue: { contains: raw.q, mode: "insensitive" } },
      { doi: { contains: raw.q, mode: "insensitive" } },
      { slug: { contains: raw.q, mode: "insensitive" } }
    ];
  }

  const [items, total] = await Promise.all([
    prisma.publication.findMany({
      where,
      // Newest first, then the title. Total and stable, so the list never reshuffles between requests.
      orderBy: [{ year: "desc" }, { title: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        slug: true,
        title: true,
        kind: true,
        authorLine: true,
        venue: true,
        year: true,
        month: true,
        doi: true,
        isFeatured: true,
        status: true,
        publishedAt: true,
        updatedAt: true,
        researchArea: { select: { id: true, title: true } },
        _count: { select: { authors: true, projects: true } }
      }
    }),
    prisma.publication.count({ where })
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
    "Creating a publication needs researcher access or higher. An administrator can raise yours."
  );

  const body = await parseJson(request, PublicationBody);

  // Required on create, even though the schema is partial so `PATCH` can share it. Spelled out rather
  // than split into two schemas, so the two paths cannot drift on a field's rules.
  if (!body.title) throw badRequest("The publication needs a title before it can be created.");
  if (!body.slug) throw badRequest("The publication needs a web address before it can be created.");
  if (!body.authorLine) {
    throw badRequest(
      "The author line cannot be empty — it is what every citation on the site prints, exactly as typed."
    );
  }
  if (body.year === undefined) throw badRequest("The publication needs a year.");

  const status = body.status ?? "DRAFT";
  if ((status === "PUBLISHED" || status === "SCHEDULED") && !canPublish(user)) {
    throw forbidden(
      "Publishing needs editor access, or permission to publish granted by an administrator. " +
        "Save it as a draft and ask an editor to publish it."
    );
  }

  const taken = await prisma.publication.findUnique({
    where: { slug: body.slug },
    select: { id: true, title: true, deletedAt: true }
  });
  if (taken) {
    throw conflict(
      taken.deletedAt
        ? `The address /publications/${body.slug} belongs to “${taken.title}”, which is in the recycle bin. Restore it, or choose a different address.`
        : `The address /publications/${body.slug} is already used by “${taken.title}”. Choose a different one.`
    );
  }

  await assertPublicationReferences(body);

  const doi = normaliseDoi(body.doi);
  if (doi) {
    // Warned about, not refused. Two records with one DOI is occasionally correct — a preprint and the
    // published version — and refusing it outright would make that impossible to record. The import
    // screen is where duplicates are decided; here the conflict is only reported if the SAME slug clashes.
    const sameDoi = await prisma.publication.findFirst({
      where: { doi, deletedAt: null },
      select: { id: true, title: true, year: true }
    });
    if (sameDoi) {
      // A 409 with the record named, so the reader can go and look before deciding.
      throw conflict(
        `“${sameDoi.title}” (${sameDoi.year}) already has the DOI ${doi}. If this really is a different ` +
          "record — a preprint and the published version, for instance — clear the DOI on one of them first."
      );
    }
  }

  const title = body.title;
  const slug = body.slug;
  const authorLine = body.authorLine;
  const year = body.year;
  const authorIds = unique(body.authorIds ?? []);

  const created = await mutateWithHistory<Prisma.PublicationGetPayload<{ select: typeof INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    { action: "CREATE", entityType: "Publication", entityLabel: title, summary: "Created" },
    async (tx) => {
      const publication = await tx.publication.create({
        data: {
          title,
          slug,
          kind: body.kind ?? "JOURNAL_ARTICLE",
          abstract: body.abstract?.trim() || null,
          authorLine,
          venue: body.venue?.trim() || null,
          publisher: body.publisher?.trim() || null,
          volume: body.volume?.trim() || null,
          issue: body.issue?.trim() || null,
          pages: body.pages?.trim() || null,
          year,
          month: body.month ?? null,
          doi,
          isbn: body.isbn?.trim() || null,
          issn: body.issn?.trim() || null,
          patentNumber: body.patentNumber?.trim() || null,
          arxivId: normaliseArxiv(body.arxivId),
          url: body.url?.trim() || null,
          // Stored verbatim, or left empty. Never generated here — see the header.
          bibtex: body.bibtex?.trim() || null,
          keywords: unique((body.keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean)),
          pdfFileId: body.pdfFileId ?? null,
          researchAreaId: body.researchAreaId ?? null,
          isFeatured: body.isFeatured ?? false,
          status,
          publishedAt: status === "PUBLISHED" ? new Date() : null
        },
        select: { id: true }
      });

      if (authorIds.length > 0) {
        // The position is the PRINTED order of the linked people, taken from the array rather than from a
        // number on the wire — the array is what the editor dragged.
        await tx.publicationAuthor.createMany({
          data: authorIds.map((personId, position) => ({
            publicationId: publication.id,
            personId,
            position
          }))
        });
      }

      const row = await tx.publication.findUniqueOrThrow({
        where: { id: publication.id },
        select: INDEX_SELECT
      });
      await indexDocument(tx, searchDocFromPublication(row));
      return row;
    }
  );

  return ok(created, { status: 201 });
});
