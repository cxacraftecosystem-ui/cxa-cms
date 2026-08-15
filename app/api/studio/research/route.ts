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
import { indexDocument, searchDocFromResearchArea } from "@/lib/search/index";

/**
 * Research areas: the list, and creating one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE BODY IS WHAT `ResearchAreaEditor.toPayload()` SENDS. `POST` answers a row carrying at least
 * `{ id }`, because the editor redirects to `/studio/research/{id}` the moment a new area is created.
 *
 * PUBLISHING IS A SEPARATE PERMISSION FROM EDITING, AND IT IS CHECKED HERE. `StatusControl` only offers
 * Draft and In review to somebody who cannot publish; this handler enforces the same predicate from
 * lib/permissions.ts, because a client guard that only hides a control is not a guard (contract §1.7).
 *
 * THE SEARCH INDEX IS WRITTEN IN THE SAME TRANSACTION as the row. A rolled-back save that had already
 * written its index row leaves a search result pointing at content that does not exist
 * (lib/search/index.ts).
 *
 * THE SLUG IS THE PUBLIC ADDRESS. It is refused rather than silently altered when it is taken — an area
 * that quietly became `natural-dyes-2` is an address nobody typed and nobody can find.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * The slug rule, stated in the message.
 *
 * "Invalid slug" sends the reader guessing; naming the character set and giving an example does not.
 * The word "slug" never appears in anything a reader sees — it is "the web address".
 */
const slugField = z
  .string()
  .trim()
  .min(1, "The web address is empty. It is the part after /research/ and it cannot be blank.")
  .max(96, "Keep the web address to 96 characters or fewer.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "A web address can only use lower-case letters, numbers and single hyphens — “natural-dyes”, not “Natural Dyes”."
  );

/**
 * A Tiptap document, or `null`.
 *
 * Only the ENVELOPE is validated, exactly as lib/sections/schema.ts does it: the node tree is the
 * renderer's business, and `components/RichText.tsx` whitelists the node and mark types it will draw and
 * never uses `dangerouslySetInnerHTML`. A schema here that tried to enumerate every node would be a
 * second, weaker copy of that whitelist — guaranteed to drift, and trusted more than it deserves.
 */
const richTextField = z.union([
  z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() }).passthrough(),
  z.null()
]);

/**
 * A lucide export name, by SHAPE only.
 *
 * The authoritative list is `FEATURE_ICON_NAMES` in components/sections/FeatureGridSection.tsx, which is
 * the closed set the picker offers and the renderer can draw — but that module is a renderer, and
 * pulling a section component (and the icon set behind it) into an API route to check a string is the
 * wrong dependency. It is safe to be lenient here because `featureIcon()` never throws: an unrecognised
 * name draws a neutral glyph rather than leaving a blank square, and payloads outlive the code that
 * wrote them (lucide has renamed whole families of icons before).
 */
const iconField = z
  .string()
  .trim()
  .max(60)
  .regex(/^[A-Z][A-Za-z0-9]*$/, "An icon name looks like “Leaf” or “FlaskConical” — capitalised, no spaces.")
  .nullable();

/**
 * A literal colour for the research diagram ONLY.
 *
 * Accepted as a hex or an `oklch(…)` value and stored verbatim. The pattern refuses anything that could
 * escape a CSS custom property — a value that reaches a `style` attribute has to be a colour and nothing
 * else. It is not a second brand accent: the site has one action colour (contract §1.1) and this is a
 * data-encoding channel in a visualisation.
 */
const accentField = z
  .string()
  .trim()
  .max(64)
  .regex(
    /^(#[0-9a-fA-F]{3,8}|oklch\([0-9.%\s/-]+\)|rgb\([0-9.,\s/%]+\)|hsl\([0-9.,\s/%deg]+\))$/,
    "A colour has to be a hex value like #7C3AED or an oklch(…) value. Anything else is refused because it ends up in a style attribute."
  )
  .nullable();

const AreaBody = z.object({
  title: z
    .string()
    .trim()
    .min(1, "The research area needs a title.")
    .max(200, "Keep the title to 200 characters or fewer."),
  slug: slugField,
  summary: z.string().trim().max(2000).nullable().optional(),
  body: richTextField.optional(),
  icon: iconField.optional(),
  accentColor: accentField.optional(),
  coverId: z.string().trim().min(1).max(64).nullable().optional(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
  status: z.enum(["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"]).optional(),
  /** Only meaningful on a rename; accepted here so the editor can send one payload shape. */
  createRedirect: z.boolean().optional()
});

/** The columns `searchDocFromResearchArea` reads, plus what the index row needs to resolve publication state. */
const INDEX_SELECT = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  body: true,
  status: true,
  publishedAt: true,
  deletedAt: true
} satisfies Prisma.ResearchAreaSelect;

/** A nullable `Json` column takes `Prisma.JsonNull`, never a bare `null` — Prisma refuses to guess (contract §14). */
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

/**
 * A bounded whole number from a query string, VALIDATED AS A STRING and converted at the call site.
 *
 * The house pattern, for the reason app/api/public/search/route.ts sets out: `parseQuery` takes a
 * `ZodSchema<T>`, whose input and output are the same `T`, so a `.default()` or a `.transform()` makes
 * the two differ and the call stops type-checking. `.refine()` does not.
 */
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
  status: z.enum(["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"]).optional(),
  page: boundedInt("The page number", 1, 100000),
  pageSize: boundedInt("The page size", 1, MAX_PAGE_SIZE)
});

export const GET = route(async (request: Request) => {
  await requireCapability(
    canManageResearch,
    "Research areas need researcher access or higher. An administrator can raise yours."
  );

  const raw = parseQuery(request, ListQuery);
  const page = toInt(raw.page, 1);
  const pageSize = toInt(raw.pageSize, DEFAULT_PAGE_SIZE);

  const where: Prisma.ResearchAreaWhereInput = { deletedAt: null };
  if (raw.status) where.status = raw.status;
  if (raw.q) {
    where.OR = [
      { title: { contains: raw.q, mode: "insensitive" } },
      { summary: { contains: raw.q, mode: "insensitive" } },
      { slug: { contains: raw.q, mode: "insensitive" } }
    ];
  }

  const [items, total] = await Promise.all([
    prisma.researchArea.findMany({
      where,
      // `sortOrder` is the editorial order and `title` breaks the ties, so the order is TOTAL and the
      // list never reshuffles between requests — an unstable sort reads as data changing.
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        slug: true,
        title: true,
        summary: true,
        icon: true,
        accentColor: true,
        coverId: true,
        sortOrder: true,
        status: true,
        publishedAt: true,
        updatedAt: true,
        _count: { select: { projects: true, publications: true } }
      }
    }),
    prisma.researchArea.count({ where })
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
    "Creating a research area needs researcher access or higher. An administrator can raise yours."
  );

  const body = await parseJson(request, AreaBody);
  const status = body.status ?? "DRAFT";

  // The same predicate `StatusControl` uses to decide what to offer. Checked here because this is the
  // boundary; the control is only the courtesy.
  if ((status === "PUBLISHED" || status === "SCHEDULED") && !canPublish(user)) {
    throw forbidden(
      "Publishing needs editor access, or permission to publish granted by an administrator. " +
        "Save it as a draft and ask an editor to publish it."
    );
  }

  const taken = await prisma.researchArea.findUnique({
    where: { slug: body.slug },
    select: { id: true, title: true, deletedAt: true }
  });
  if (taken) {
    throw conflict(
      taken.deletedAt
        ? `The address /research/${body.slug} belongs to “${taken.title}”, which is in the recycle bin. ` +
          "Restore it, or choose a different address."
        : `The address /research/${body.slug} is already used by “${taken.title}”. Choose a different one.`
    );
  }

  if (body.coverId) {
    const cover = await prisma.mediaAsset.findFirst({
      where: { id: body.coverId, deletedAt: null },
      select: { id: true }
    });
    if (!cover) throw badRequest("The cover picture no longer exists in the media library. Choose another.");
  }

  const created = await mutateWithHistory<Prisma.ResearchAreaGetPayload<{ select: typeof INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "CREATE",
      entityType: "ResearchArea",
      entityLabel: body.title,
      summary: "Created"
    },
    async (tx) => {
      const row = await tx.researchArea.create({
        data: {
          title: body.title,
          slug: body.slug,
          summary: body.summary?.trim() || null,
          body: jsonColumn(body.body),
          icon: body.icon ?? null,
          accentColor: body.accentColor ?? null,
          coverId: body.coverId ?? null,
          sortOrder: body.sortOrder ?? 0,
          status,
          // Stamped by the SERVER, never taken from the form: "when did this first go public" is a fact
          // about the system, and a client-supplied date is a fact about somebody's laptop clock.
          publishedAt: status === "PUBLISHED" ? new Date() : null
        },
        select: INDEX_SELECT
      });

      await indexDocument(tx, searchDocFromResearchArea(row));
      return row;
    }
  );

  return ok(created, { status: 201 });
});
