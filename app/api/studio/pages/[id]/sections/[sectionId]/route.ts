import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { ApiError, assertSameOrigin, conflict, noContent, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canAccessStudio, canManageStructure } from "@/lib/permissions";
import { mergeSectionData, sectionAnchor } from "@/lib/sections/anchor";
import { parseSectionData, sectionTypeSchema } from "@/lib/sections/schema";
import {
  buildAuditContext,
  found,
  optionalText,
  parseStudioJson,
  reindexPage,
  rewriteSectionPositions
} from "@/lib/studio/crud";

/**
 * One block on one page: read it, save it, delete it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SECTION MUST BELONG TO THE PAGE IN THE ADDRESS, and a mismatch is a 404 rather than a 403.
 *
 * Both ids are in the URL, so nothing stops a caller pairing this page with another page's block. Looking
 * the block up by id alone would then edit — or delete — a block on a page the caller never named, and the
 * audit entry would be filed against the wrong page. Every query below therefore carries `pageId`, and a
 * block that is not on this page simply does not exist as far as this address is concerned.
 *
 * A BLOCK'S TYPE CANNOT CHANGE. Its payload is validated against the schema for its type, and every schema
 * has different fields — so "make this HERO a STATS" would either throw the writing away or store a payload
 * that cannot render. The refusal says what to do instead, which takes two clicks and loses nothing.
 *
 * DELETING A BLOCK CLOSES THE GAP IT LEAVES. `PageSection` has a dense 0-based ordering, and the builder
 * renumbers its own list the same way, so leaving a hole would make the client's positions disagree with
 * the server's the moment anything else was dragged.
 *
 * ⚠ A BLOCK'S NAMED ANCHOR SURVIVES A SAVE ONLY BECAUSE THIS HANDLER PUTS IT BACK. `data.anchor` sits outside
 * every schema, so validation strips it; the studio merges it back on the client, and so must the server, or
 * the merge on the client is undone one layer down. See `mergeSectionData` in lib/sections/anchor.ts.
 *
 * ⚠ `PageSection` HAS NO `deletedAt`. A deleted block does not go to the recycle bin — the studio's confirm
 * dialog says so in as many words. Its revisions survive it, which is the only trace left.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const SECTION_SELECT = {
  id: true,
  type: true,
  position: true,
  label: true,
  data: true,
  isVisible: true
} as const;

type SectionRow = Prisma.PageSectionGetPayload<{ select: typeof SECTION_SELECT }>;

/**
 * What the builder's autosave sends: `contentOf(entry)` — the label, the payload and the switch.
 *
 * `type` is accepted only so a mismatch can be REFUSED with an explanation. Silently ignoring it would let
 * a caller believe a conversion had happened.
 *
 * `position` is deliberately absent: ordering is the order endpoint's job, and a position written here
 * would collide with `@@unique([pageId, position])` on the first overlap.
 */
const patchSchema = z.object({
  label: optionalText(80),
  data: z.unknown().optional(),
  isVisible: z.boolean().optional(),
  type: sectionTypeSchema.optional()
});

interface RouteContext {
  params: Promise<{ id: string; sectionId: string }>;
}

export const GET = route(async (request: Request, context: RouteContext) => {
  await requireCapability(canAccessStudio);
  const { id, sectionId } = await context.params;

  const section = found(
    await prisma.pageSection.findFirst({
      where: { id: sectionId, pageId: id },
      select: SECTION_SELECT
    }),
    "That block"
  );

  return ok({ section });
});

export const PATCH = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Changing a page's blocks needs editor access. An administrator can raise yours."
  );
  const { id, sectionId } = await context.params;

  const body = await parseStudioJson(request, patchSchema);

  const existing = found(
    await prisma.pageSection.findFirst({
      where: { id: sectionId, pageId: id },
      select: { ...SECTION_SELECT, page: { select: { title: true, deletedAt: true } } }
    }),
    "That block"
  );

  if (existing.page.deletedAt) {
    throw conflict(
      "This page is in the recycle bin. Restore the page before changing the blocks on it."
    );
  }

  if (body.type && body.type !== existing.type) {
    throw conflict(
      `A block cannot be changed from one sort into another — a ${existing.type} block and a ${body.type} block hold completely different settings. Add the new block where you want it and delete this one.`
    );
  }

  // Validated against the schema for the STORED type, never the requested one. `data` omitted means "leave
  // the payload alone", which is what a save of the label or the switch alone sends.
  //
  // ⚠ THE PARSED PAYLOAD IS NOT WHAT GETS STORED. A block's named anchor lives on `data.anchor`, outside all
  // twenty-three schemas, so validation strips it (lib/sections/anchor.ts explains why it lives there). Writing
  // `parsed.data` into the row would therefore delete the anchor on the first save of any field on the block,
  // and `/about#history` would scroll nowhere from then on — with no field anywhere in the studio to type it
  // back in. `mergeSectionData` carries it across. The anchor is read from what the caller sent when they sent
  // one, and from the stored row otherwise, so a client that posts a stripped payload cannot delete an anchor
  // it had no way to set.
  const nextData =
    body.data === undefined
      ? undefined
      : (() => {
          const parsed = parseSectionData(existing.type, body.data);
          if (!parsed.ok) {
            throw new ApiError(422, parsed.message, {
              code: "validation_failed",
              fieldErrors: parsed.fieldErrors
            });
          }
          const carrier = sectionAnchor(body.data) ? body.data : existing.data;
          return mergeSectionData(carrier, parsed.data) as Prisma.InputJsonValue;
        })();

  const updated = await mutateWithHistory<SectionRow>(
    buildAuditContext(request, user),
    {
      action: "UPDATE",
      entityType: "PageSection",
      entityLabel: `${existing.page.title} — ${existing.label ?? existing.type}`,
      before: { ...existing, page: undefined }
    },
    async (tx) => {
      const row = await tx.pageSection.update({
        where: { id: sectionId },
        data: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.isVisible !== undefined ? { isVisible: body.isVisible } : {}),
          ...(nextData !== undefined ? { data: nextData } : {})
        },
        select: SECTION_SELECT
      });

      // The words in this block are part of the page's searchable text — including whether it is switched
      // on, since a hidden block is not on the page and must not match.
      await reindexPage(tx, id);

      return row;
    }
  );

  return ok({ section: updated });
});

export const DELETE = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Deleting a page's blocks needs editor access. An administrator can raise yours."
  );
  const { id, sectionId } = await context.params;

  const existing = found(
    await prisma.pageSection.findFirst({
      where: { id: sectionId, pageId: id },
      select: { ...SECTION_SELECT, page: { select: { title: true } } }
    }),
    "That block"
  );

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "PageSection",
      entityLabel: `${existing.page.title} — ${existing.label ?? existing.type}`,
      before: { ...existing, page: undefined },
      // The revisions already hold what this block said. A snapshot of it being removed adds nothing that
      // could be restored from, and `PageSection` has no recycle bin to restore into.
      revise: false
    },
    async (tx) => {
      const row = await tx.pageSection.delete({
        where: { id: sectionId },
        select: { id: true }
      });

      // Close the gap. Read AFTER the delete so the remaining blocks are renumbered 0…n-1 in the order they
      // already stood in, which is exactly what the builder does to its own list.
      const remaining = await tx.pageSection.findMany({
        where: { pageId: id },
        orderBy: { position: "asc" },
        select: { id: true }
      });
      if (remaining.length > 0) {
        await rewriteSectionPositions(
          tx,
          id,
          remaining.map((section) => section.id)
        );
      }

      await reindexPage(tx, id);

      return row;
    }
  );

  return noContent();
});
