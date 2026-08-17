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
  route,
  userAgent
} from "@/lib/api";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { requireCapability, type SessionUser } from "@/lib/auth/current-user";
import { isLive } from "@/lib/content";
import { MEDIA_IMAGE_SELECT_WITH_ID } from "@/lib/media/select";
import { canManageResearch, canPublish } from "@/lib/permissions";
import { indexDocument, removeDocument, searchDocFromResearchArea, searchUrlFor } from "@/lib/search/index";
import { parseStudioJson, screenFramingField } from "@/lib/studio/crud";

/**
 * One research area: read it, save it, or move it to the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `PATCH` IS PARTIAL, AND IT HAS TO BE. The editor sends the whole payload on every autosave, but the
 * list screen's "Archive" button sends `{ status: "ARCHIVED" }` and nothing else. A schema that required
 * the full record would answer 422 to the row action, and one that treated an absent key as `null` would
 * blank the summary of everything anybody archived.
 *
 * RENAMING A PUBLISHED AREA LEAVES A REDIRECT BEHIND. The `Redirect` table exists so that moving a page
 * never has to break an existing link (schema), and a research area is linked from projects, from
 * publications and from other institutions' pages. Three things happen, in one transaction with the
 * rename:
 *   • the old address redirects to the new one;
 *   • any redirect that already pointed at the OLD address is retargeted at the new one, so a second
 *     rename does not build a chain that browsers stop following;
 *   • a redirect whose source is the NEW address is removed, because a page that redirects away from
 *     itself is a loop.
 * A DRAFT is not redirected: nothing outside the studio ever had that address.
 *
 * PUBLISHING AND UNPUBLISHING ARE THE SAME PERMISSION. Moving a live area to Draft is unpublishing it,
 * which is the very thing `canPublish` governs — so the check is on the TRANSITION, not on the
 * destination. Editing the prose of a published area needs no publish right at all.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const slugField = z
  .string()
  .trim()
  .min(1, "The web address is empty. It is the part after /research/ and it cannot be blank.")
  .max(96, "Keep the web address to 96 characters or fewer.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "A web address can only use lower-case letters, numbers and single hyphens — “natural-dyes”, not “Natural Dyes”."
  );

/** Envelope only — see the note in the sibling collection route. */
const richTextField = z.union([
  z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() }).passthrough(),
  z.null()
]);

const PatchBody = z.object({
  title: z.string().trim().min(1, "The research area needs a title.").max(200).optional(),
  slug: slugField.optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  body: richTextField.optional(),
  icon: z
    .string()
    .trim()
    .max(60)
    .regex(/^[A-Z][A-Za-z0-9]*$/, "An icon name looks like “Leaf” or “FlaskConical” — capitalised, no spaces.")
    .nullable()
    .optional(),
  accentColor: z
    .string()
    .trim()
    .max(64)
    .regex(
      /^(#[0-9a-fA-F]{3,8}|oklch\([0-9.%\s/-]+\)|rgb\([0-9.,\s/%]+\)|hsl\([0-9.,\s/%deg]+\))$/,
      "A colour has to be a hex value like #7C3AED or an oklch(…) value."
    )
    .nullable()
    .optional(),
  coverId: z.string().trim().min(1).max(64).nullable().optional(),
  /**
   * Per-screen framing for the cover. `.nullable().optional()` — the two are different statements and both
   * are needed: absent means "the form did not send it, leave the column alone", null means "the editor
   * cleared it". See `screenFramingField` in lib/studio/crud.ts.
   */
  coverScreens: screenFramingField(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
  status: z.enum(["DRAFT", "IN_REVIEW", "SCHEDULED", "PUBLISHED", "ARCHIVED"]).optional(),
  /** Defaults to true where it applies: leaving a link broken is never the safer default. */
  createRedirect: z.boolean().optional()
});

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

function jsonColumn(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function auditContext(request: NextRequest, actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: clientIp(request), userAgent: userAgent(request) };
}

/**
 * Refuse a publication-state CHANGE the reader is not allowed to make.
 *
 * Only a change is governed. Saving a published area with its status unchanged is an ordinary edit, and
 * requiring the publish right for it would stop a researcher fixing a typo on their own live page.
 */
function assertMayChangeStatus(
  user: SessionUser,
  next: ContentStatus | undefined,
  before: { status: ContentStatus; publishedAt: Date | null }
): void {
  if (next === undefined || next === before.status) return;
  if (canPublish(user)) return;

  const goingLive = next === "PUBLISHED" || next === "SCHEDULED";
  const wasLive = isLive(before);
  if (!goingLive && !wasLive) return;

  throw forbidden(
    goingLive
      ? "Publishing needs editor access, or permission to publish granted by an administrator. Leave it as a draft and ask an editor."
      : "Taking something off the public site needs editor access, or permission to publish granted by an administrator."
  );
}

/**
 * Record a rename so the old address keeps working. See the header for why all three writes are needed.
 */
async function recordRename(tx: TxClient, fromSlug: string, toSlug: string): Promise<void> {
  const source = searchUrlFor("research-area", fromSlug);
  const destination = searchUrlFor("research-area", toSlug);
  if (source === destination) return;

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

export const GET = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(
    canManageResearch,
    "Research areas need researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const area = await prisma.researchArea.findFirst({
    where: { id, deletedAt: null },
    include: {
      // `fileName` on top of the shared list: the editor labels the picked cover by its file name.
      cover: { select: { ...MEDIA_IMAGE_SELECT_WITH_ID, fileName: true } },
      _count: { select: { projects: true, publications: true } }
    }
  });

  if (!area) throw notFound("That research area");
  return ok(area);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PATCH = route(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageResearch,
    "Editing a research area needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, PatchBody);

  const before = await prisma.researchArea.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw notFound("That research area");

  assertMayChangeStatus(user, body.status, before);

  if (body.slug && body.slug !== before.slug) {
    const taken = await prisma.researchArea.findUnique({
      where: { slug: body.slug },
      select: { id: true, title: true, deletedAt: true }
    });
    if (taken && taken.id !== id) {
      throw conflict(
        taken.deletedAt
          ? `The address /research/${body.slug} belongs to “${taken.title}”, which is in the recycle bin.`
          : `The address /research/${body.slug} is already used by “${taken.title}”. Choose a different one.`
      );
    }
  }

  if (body.coverId) {
    const cover = await prisma.mediaAsset.findFirst({
      where: { id: body.coverId, deletedAt: null },
      select: { id: true }
    });
    if (!cover) throw badRequest("The cover picture no longer exists in the media library. Choose another.");
  }

  // The UNCHECKED variant: it is the one that exposes the raw `coverId` column, which the checked input
  // only offers as `cover: { connect | disconnect }`.
  const data: Prisma.ResearchAreaUncheckedUpdateInput = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.slug !== undefined) data.slug = body.slug;
  if ("summary" in body) data.summary = body.summary?.trim() || null;
  if ("body" in body) data.body = jsonColumn(body.body);
  if ("icon" in body) data.icon = body.icon ?? null;
  if ("accentColor" in body) data.accentColor = body.accentColor ?? null;
  if ("coverId" in body) data.coverId = body.coverId ?? null;
  // Written through beside the picture it frames. A framing the route accepted and then dropped would be
  // a control in the studio that silently does nothing.
  if ("coverScreens" in body) data.coverScreens = jsonColumn(body.coverScreens);
  if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;

  if (body.status !== undefined) {
    data.status = body.status;
    // Stamped once, the first time it goes public, and never cleared afterwards: it is the publication
    // DATE of the work, which is what a reader cites, not a mirror of the status column.
    if (body.status === "PUBLISHED" && before.publishedAt === null) data.publishedAt = new Date();
  }

  if (Object.keys(data).length === 0) return ok(before);

  const renamed = body.slug !== undefined && body.slug !== before.slug;
  // A draft has never had a public address, so there is nothing to redirect from. `createRedirect`
  // defaults to true because leaving a citation broken is never the safer default.
  const shouldRedirect = renamed && body.createRedirect !== false && isLive(before);

  const updated = await mutateWithHistory<Prisma.ResearchAreaGetPayload<{ select: typeof INDEX_SELECT }>>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action:
        body.status === "PUBLISHED" && before.status !== "PUBLISHED"
          ? "PUBLISH"
          : body.status === "ARCHIVED" && before.status !== "ARCHIVED"
            ? "ARCHIVE"
            : "UPDATE",
      entityType: "ResearchArea",
      entityLabel: body.title ?? before.title,
      before,
      summary: renamed ? `Address changed from ${before.slug}` : "Edited"
    },
    async (tx) => {
      const row = await tx.researchArea.update({ where: { id }, data, select: INDEX_SELECT });
      if (shouldRedirect) await recordRename(tx, before.slug, row.slug);
      await indexDocument(tx, searchDocFromResearchArea(row));
      return row;
    }
  );

  return ok({
    ...updated,
    /** Said out loud, because a redirect that was created silently is a redirect nobody knows to remove. */
    ...(shouldRedirect
      ? {
          redirectCreated: {
            from: searchUrlFor("research-area", before.slug),
            to: searchUrlFor("research-area", updated.slug)
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
    "Removing a research area needs researcher access or higher. An administrator can raise yours."
  );

  const { id } = await context.params;

  const area = await prisma.researchArea.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      _count: { select: { projects: true, publications: true } }
    }
  });
  if (!area) throw notFound("That research area");

  await mutateWithHistory<{ id: string }>(
    auditContext(request, { id: user.id, email: user.email }),
    {
      action: "DELETE",
      entityType: "ResearchArea",
      entityLabel: area.title,
      before: { slug: area.slug, title: area.title, status: area.status },
      revise: false
    },
    async (tx) => {
      const row = await tx.researchArea.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true }
      });
      /**
       * The projects and publications filed under this area are NOT touched. Their
       * `researchAreaId` is `onDelete: SetNull` at the referring side, so nothing cascades — and
       * leaving the link in place is what makes a restore put everything back as it was.
       */
      await removeDocument(tx, "research-area", id);
      return row;
    }
  );

  return ok({
    deleted: true,
    id: area.id,
    title: area.title,
    /** The consequences, counted — an area with sixteen projects filed under it is not a quiet deletion. */
    projectsAffected: area._count.projects,
    publicationsAffected: area._count.publications,
    message:
      `“${area.title}” is in the recycle bin and has gone from the site. ` +
      (area._count.projects + area._count.publications > 0
        ? `${area._count.projects} project(s) and ${area._count.publications} publication(s) were filed under it. ` +
          "They are untouched and still on the site, but they are no longer grouped under an area — restoring this " +
          "puts the grouping back."
        : "Nothing was filed under it.")
  });
});
