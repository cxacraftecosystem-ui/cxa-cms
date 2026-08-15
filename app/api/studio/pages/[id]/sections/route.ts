import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { ApiError, assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canAccessStudio, canManageStructure } from "@/lib/permissions";
import { defaultSectionData, parseSectionData, sectionTypeSchema } from "@/lib/sections/schema";
import {
  buildAuditContext,
  found,
  optionalText,
  parseStudioJson,
  reindexPage,
  rewriteSectionPositions
} from "@/lib/studio/crud";
import { clamp } from "@/lib/utils";

/**
 * The blocks on one page: the list, and adding one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ADDING A BLOCK AT A POSITION IS A REORDER, and it is done with the same two-pass rewrite as a drag —
 * `rewriteSectionPositions()`, whose header explains why a single pass cannot work against
 * `@@unique([pageId, position])`.
 *
 * The block is created at the END first, where the next free position provably is (the ordering is dense,
 * so `count` is always free), and the whole page is then renumbered into the order the builder asked for.
 * That is one extra pass over a list of at most a few dozen rows, and it removes the only alternative:
 * shifting the tail up one row at a time, which collides with the constraint on its first statement.
 *
 * `PageBuilder` relies on this: "the server inserted at the same position and shifted the rest, so the two
 * agree by arithmetic" — it does not re-read the list after an add.
 *
 * A BLOCK'S PAYLOAD IS VALIDATED AGAINST THE SCHEMA FOR ITS TYPE, always, on the way in. `PageSection.data`
 * is a JSON column, so this and `parseSectionData()` are the only things standing between a drag-and-drop
 * and a renderer reading a property that is not there.
 *
 * ADDING A BLOCK RE-INDEXES THE PAGE. A page's searchable text is built from the words in its blocks
 * (`plainTextFromSections`), so a new block changes what the page matches. Inside the same transaction, for
 * the usual reason: an index that can disagree with the data eventually does.
 *
 * A BLOCK ADDED TO A LIVE PAGE ARRIVES HIDDEN. A page's blocks have one copy — there is no draft of a
 * published page — so a block created visible on a PUBLISHED page is on the public site the moment this
 * request returns, wearing its seeded placeholder wording. SCHEDULED counts as live for the usual
 * conservative reason: its date can pass between this write and the editor's next look. The builder says
 * so before and after the add, and the row's eye toggle is how the editor turns the block on once its
 * words are real.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The most blocks one page may hold.
 *
 * Not a database limit — a limit on what anybody can maintain, and on how much a single page can be asked
 * to render. It is stated in the refusal, because a cap that is not said is indistinguishable from a bug.
 */
const MAX_SECTIONS_PER_PAGE = 60;

const SECTION_SELECT = {
  id: true,
  type: true,
  position: true,
  label: true,
  data: true,
  isVisible: true
} as const;

/** What one block looks like on the wire — the same shape as `BuilderSection` in the studio builder. */
type SectionRow = Prisma.PageSectionGetPayload<{ select: typeof SECTION_SELECT }>;

const createSchema = z.object({
  type: sectionTypeSchema,
  /** Where it goes. Out-of-range values are clamped rather than refused — the end of the list is a sane
   *  reading of "position 40" on a page with six blocks, and a 422 there would only lose the block. */
  position: z.coerce.number().int().min(0).max(1000).optional(),
  label: optionalText(80),
  /** Omitted means "the seeded default for this type", which is what a freshly dropped block starts with. */
  data: z.unknown().optional(),
  /** Ignored on a live page, where the POST forces the new block to arrive hidden — see the header. */
  isVisible: z.boolean().default(true)
});

export const GET = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(canAccessStudio);
  const { id } = await context.params;

  const page = found(
    await prisma.page.findUnique({ where: { id }, select: { id: true } }),
    "That page"
  );

  // Ordered in SQL. `position` is dense and unique per page, so this ordering is total.
  const sections = await prisma.pageSection.findMany({
    where: { pageId: page.id },
    orderBy: { position: "asc" },
    select: SECTION_SELECT
  });

  return ok({ sections });
});

export const POST = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Building a page needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, createSchema);

  const page = found(
    await prisma.page.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, title: true, status: true }
    }),
    "That page"
  );

  // PUBLISHED is public now; SCHEDULED becomes public when its date passes, which can happen between
  // this write and the editor's next look — the safe reading of both is "readers can see this page".
  const pageIsLive = page.status === "PUBLISHED" || page.status === "SCHEDULED";

  // Validated before anything is written, so a payload that cannot render is refused rather than stored as
  // an editor-only error card. `data` omitted becomes the seeded default for the type.
  const parsed = parseSectionData(body.type, body.data ?? defaultSectionData(body.type));
  if (!parsed.ok) {
    throw new ApiError(422, parsed.message, {
      code: "validation_failed",
      fieldErrors: parsed.fieldErrors
    });
  }

  const created = await mutateWithHistory<SectionRow>(
    buildAuditContext(request, user),
    {
      action: "CREATE",
      entityType: "PageSection",
      // Names the page as well as the block: an audit list of twenty "HERO created" lines is unreadable
      // without knowing which page each one is on.
      entityLabel: `${page.title} — ${body.type}`,
      summary: "Added to the page"
    },
    async (tx) => {
      // Read INSIDE the transaction. Two builders adding a block to one page in the same second would
      // otherwise both compute the same free position, and the second would be refused by
      // `@@unique([pageId, position])` after the reader had been told it worked.
      const existing = await tx.pageSection.findMany({
        where: { pageId: page.id },
        orderBy: { position: "asc" },
        select: { id: true, position: true }
      });

      if (existing.length >= MAX_SECTIONS_PER_PAGE) {
        throw conflict(
          `This page already has ${existing.length} blocks, which is the most one page holds. Move some of it onto a second page, or delete a block you no longer need.`
        );
      }

      const target = clamp(body.position ?? existing.length, 0, existing.length);

      // One past the HIGHEST position, not `count`. The two are the same while the ordering is dense — and
      // if it ever is not (an import, a hand-edited row), `count` is a position somebody already holds and
      // this insert would be refused for a reason the reader could do nothing about.
      const free = (existing[existing.length - 1]?.position ?? -1) + 1;

      const row = await tx.pageSection.create({
        data: {
          pageId: page.id,
          type: body.type,
          position: free,
          label: body.label,
          data: parsed.data as Prisma.InputJsonValue,
          // ⚠ Forced hidden on a live page, whatever the caller asked for. There is no draft copy of
          // a page's blocks, so a visible block created here would be public before anybody had
          // replaced its placeholder wording — and a copy of a visible block would go out twice.
          isVisible: pageIsLive ? false : body.isVisible
        },
        select: SECTION_SELECT
      });

      // Appending to a dense list needs no rewrite. Anything else — inserting in the middle, or appending
      // to a list that had gaps — is renumbered so the page comes out dense and 0-based, which is what the
      // builder assumes when it renumbers its own copy.
      if (target !== existing.length || free !== existing.length) {
        const order = existing.map((section) => section.id);
        order.splice(target, 0, row.id);
        await rewriteSectionPositions(tx, page.id, order);
      }

      await reindexPage(tx, page.id);

      // The position the row now holds, not the one it was created at — the rewrite above moved it.
      return { ...row, position: target };
    }
  );

  return ok({ section: created }, { status: 201 });
});
