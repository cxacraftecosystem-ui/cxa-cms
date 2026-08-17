import type { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma, type PersonKind } from "@prisma/client";
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
import { canManageContent, canPublish } from "@/lib/permissions";
import { indexDocument, searchDocFromPerson } from "@/lib/search/index";
import { unique } from "@/lib/utils";

/**
 * People: the list, and creating a profile.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * PEOPLE ARE AN EDITOR-LEVEL TABLE, so the capability is `canManageContent` and not
 * `canManageResearch` — the same predicate `app/studio/people/page.tsx` calls before it renders
 * anything. A researcher owns the research tables; a profile speaks for a colleague.
 *
 * TWO SWITCHES DECIDE WHERE SOMEBODY APPEARS AND THEY ARE INDEPENDENT.
 *   • `status` decides whether the profile page exists on the public site at all.
 *   • `isVisible` decides whether they are listed on /people.
 * The combination that matters is published-but-not-listed: a visiting researcher linked from a project,
 * or an alumnus somebody's paper still cites, without either appearing in the current roster. Both feed
 * the search index's `isPublished`, because search is a public listing too (lib/search/index.ts).
 *
 * EVERYTHING IN THE CONTACT BLOCK IS PUBLIC, so the email address is validated rather than stored as
 * typed. A broken `mailto:` on a public profile is a defect every reader can see, and the field is
 * optional — so the remedy is always available: correct it, or clear it.
 *
 * THE ORCID IS NOT REFUSED FOR ITS SHAPE, deliberately. The editor already warns about a malformed one
 * and it is the reader's decision whether to fix it now; a 422 here would block every other change on the
 * profile — including the autosave — until the identifier was right.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MAX_INTERESTS = 40;

const CONTENT_STATUSES = ["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"] as const;

/**
 * Every `PersonKind`, as a tuple, for the Zod field below.
 *
 * `satisfies` rather than a bare `as const`: a group added to the Prisma enum and forgotten here would
 * otherwise be a SILENT gap — Prisma still accepts the value, so nothing fails to compile and nothing
 * throws; the studio simply cannot save a profile into the new group, and the only symptom is a picker
 * option that hits a 422. The clause makes that a compile error instead. (The same tuple, for the same
 * reason, is in ./[id]/route.ts and ./reorder/route.ts.)
 */
const PERSON_KINDS = [
  "FACULTY",
  "SCIENTIST",
  "RESEARCHER",
  "STUDENT",
  "STAFF",
  "VISITOR",
  "ALUMNUS",
  "DC_HANDICRAFTS"
] as const satisfies readonly PersonKind[];

const slugField = z
  .string()
  .trim()
  .min(1, "The web address is empty. It is the part after /people/ and it cannot be blank.")
  .max(96, "Keep the web address to 96 characters or fewer.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "A web address can only use lower-case letters, numbers and single hyphens — “anita-sharma”, not “Anita Sharma”."
  );

/** Envelope only; the node tree belongs to `components/RichText.tsx`. See lib/sections/schema.ts. */
const richTextField = z.union([
  z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() }).passthrough(),
  z.null()
]);

/** A full address, so a link on the profile actually goes somewhere. A bare domain is refused with the reason. */
const urlField = z
  .string()
  .trim()
  .max(1000)
  .regex(/^https?:\/\/\S+$/i, "A web address has to begin with https:// so the link works from the profile page.")
  .nullable();

const PersonBody = z.object({
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
  /** Stored as typed. See the header for why the shape is not enforced. */
  orcid: z.string().trim().max(40).nullable().optional(),
  /** A username or a full address — the profile page copes with either, so both are accepted. */
  github: z.string().trim().max(200).nullable().optional(),
  photoId: z.string().trim().min(1).max(64).nullable().optional(),
  startedOn: z.coerce.date().nullable().optional(),
  endedOn: z.coerce.date().nullable().optional(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
  isVisible: z.boolean().optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  createRedirect: z.boolean().optional()
});

/** The columns `searchDocFromPerson` reads, plus what the index row needs to resolve publication state. */
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

/** A nullable `Json` column takes `Prisma.JsonNull`, never a bare `null` (contract §14). */
function jsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
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
  kind: z.enum(PERSON_KINDS).optional(),
  status: z.enum(CONTENT_STATUSES).optional(),
  page: boundedInt("The page number", 1, 100000),
  pageSize: boundedInt("The page size", 1, MAX_PAGE_SIZE)
});

export const GET = route(async (request: Request) => {
  await requireCapability(
    canManageContent,
    "People need editor access or higher. An administrator can raise yours."
  );

  const raw = parseQuery(request, ListQuery);
  const page = toInt(raw.page, 1);
  const pageSize = toInt(raw.pageSize, DEFAULT_PAGE_SIZE);

  const where: Prisma.PersonWhereInput = { deletedAt: null };
  if (raw.kind) where.kind = raw.kind;
  if (raw.status) where.status = raw.status;
  if (raw.q) {
    where.OR = [
      { name: { contains: raw.q, mode: "insensitive" } },
      { designation: { contains: raw.q, mode: "insensitive" } },
      { department: { contains: raw.q, mode: "insensitive" } },
      { slug: { contains: raw.q, mode: "insensitive" } }
    ];
  }

  const [items, total] = await Promise.all([
    prisma.person.findMany({
      where,
      // The group, then the manual order inside it, then the name. Ties break on the name so the order is
      // TOTAL and stable — an unstable sort renders a different roster on every request (schema, `Person`).
      orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        slug: true,
        name: true,
        kind: true,
        designation: true,
        department: true,
        photoId: true,
        sortOrder: true,
        isVisible: true,
        status: true,
        publishedAt: true,
        startedOn: true,
        endedOn: true,
        updatedAt: true,
        _count: { select: { projects: true, publications: true, events: true } }
      }
    }),
    prisma.person.count({ where })
  ]);

  return ok({ items, total, page, pageSize });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Creating a profile needs editor access or higher. An administrator can raise yours."
  );

  const body = await parseJson(request, PersonBody);

  // Required on create even though the schema is partial for `PATCH`'s sake, so the two paths cannot drift
  // on a field's rules.
  if (!body.name) throw badRequest("The profile needs a name before it can be created.");
  if (!body.slug) throw badRequest("The profile needs a web address before it can be created.");

  const status = body.status ?? "DRAFT";
  if ((status === "PUBLISHED" || status === "SCHEDULED") && !canPublish(user)) {
    throw forbidden(
      "Publishing needs editor access, or permission to publish granted by an administrator. " +
        "Save it as a draft and ask an editor to publish it."
    );
  }

  if (body.startedOn && body.endedOn && body.endedOn < body.startedOn) {
    throw badRequest("The leaving date is before the joining date. Check both before saving.");
  }

  const taken = await prisma.person.findUnique({
    where: { slug: body.slug },
    select: { id: true, name: true, deletedAt: true }
  });
  if (taken) {
    throw conflict(
      taken.deletedAt
        ? `The address /people/${body.slug} belongs to ${taken.name}, whose profile is in the recycle bin. Restore it, or choose a different address.`
        : `The address /people/${body.slug} is already used by ${taken.name}. Add a middle initial or a second name to tell them apart.`
    );
  }

  if (body.photoId) {
    const photo = await prisma.mediaAsset.findFirst({
      where: { id: body.photoId, deletedAt: null },
      select: { id: true }
    });
    if (!photo) throw badRequest("The photograph is no longer in the media library. Choose another.");
  }

  const name = body.name;
  const slug = body.slug;

  const created = await mutateWithHistory<Prisma.PersonGetPayload<{ select: typeof INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    { action: "CREATE", entityType: "Person", entityLabel: name, summary: "Created" },
    async (tx) => {
      const row = await tx.person.create({
        data: {
          name,
          slug,
          kind: body.kind ?? "STAFF",
          designation: body.designation?.trim() || null,
          department: body.department?.trim() || null,
          bio: body.bio?.trim() || null,
          bioRich: jsonColumn(body.bioRich),
          researchInterests: unique(
            (body.researchInterests ?? []).map((interest) => interest.trim()).filter(Boolean)
          ),
          email: body.email?.trim().toLowerCase() || null,
          phone: body.phone?.trim() || null,
          website: body.website?.trim() || null,
          linkedin: body.linkedin?.trim() || null,
          googleScholar: body.googleScholar?.trim() || null,
          orcid: body.orcid?.trim() || null,
          github: body.github?.trim() || null,
          photoId: body.photoId ?? null,
          startedOn: body.startedOn ?? null,
          endedOn: body.endedOn ?? null,
          sortOrder: body.sortOrder ?? 0,
          isVisible: body.isVisible ?? true,
          status,
          // Stamped by the server: it is a fact about the system, not about somebody's laptop clock.
          publishedAt: status === "PUBLISHED" ? new Date() : null
        },
        select: INDEX_SELECT
      });

      await indexDocument(tx, searchDocFromPerson(row));
      return row;
    }
  );

  return ok(created, { status: 201 });
});
