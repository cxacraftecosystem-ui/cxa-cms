import { z } from "zod";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageStructure } from "@/lib/permissions";
import {
  buildAuditContext,
  fieldProblem,
  found,
  parseStudioJson,
  reindexPage,
  rewriteSectionPositions
} from "@/lib/studio/crud";
import { unique } from "@/lib/utils";

/**
 * Re-order the blocks on a page: ONE request carrying the WHOLE order.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE COMPLETE LIST, AND NOT "MOVE BLOCK X TO POSITION 3".
 *
 * Moving one block in a list of seven changes the position of everything between its old place and its new
 * one. Sent as N independent requests, two of them are in flight at once the moment a builder drags twice
 * — and then two blocks claim one position, `@@unique([pageId, position])` refuses one of them, and the
 * page is left half-reordered with no record of what happened. A single request carrying the whole order
 * cannot be half-applied: it either commits or it does not.
 *
 * THE SET MUST BE EXACT, AND A MISMATCH IS A 409 THAT SAYS THE TWO NUMBERS.
 *
 * A list missing an id would leave that block holding a position the rewrite is about to hand to somebody
 * else. A list containing an id from ANOTHER page would move that page's block into this one, silently.
 * The commonest cause of either is a second tab: somebody added or deleted a block there, and this tab's
 * order describes a page that no longer exists. So the refusal states what was sent, what the page holds,
 * and what to do — reload — rather than "invalid request".
 *
 * THE REWRITE ITSELF IS TWO PASSES THROUGH A NEGATIVE RANGE. See `rewriteSectionPositions()` in
 * lib/studio/crud.ts; its header is where the constraint collision is explained, because that is the single
 * most likely place in the studio for a "reordering sometimes fails" bug.
 *
 * BOTH `PATCH` AND `PUT` ARE ACCEPTED, and they are the same handler. `PageBuilder` sends PATCH (the
 * browser client in lib/client/fetcher.ts has no `put` helper), while replacing a whole ordered collection
 * is the textbook PUT. Refusing one of the two would be a 405 nobody could explain from the outside.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The cap matches the one on adding a block, plus room to spare. A body longer than this is not a page.
 */
const MAX_IDS = 200;

const orderSchema = z.object({
  ids: z
    .array(z.string().trim().min(1, "An empty block reference cannot be saved.").max(40))
    .min(1, "The new order arrived empty, so nothing has been changed.")
    .max(MAX_IDS, `A page cannot hold more than ${MAX_IDS} blocks.`)
});

const handler = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Re-ordering a page's blocks needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, orderSchema);

  const page = found(
    await prisma.page.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, title: true }
    }),
    "That page"
  );

  // A duplicate id would be written twice and leave another block without a position at all.
  const ids = unique(body.ids);
  if (ids.length !== body.ids.length) {
    throw fieldProblem(
      "ids",
      "The new order lists the same block more than once. Reload the page and try the move again."
    );
  }

  const current = await prisma.pageSection.findMany({
    where: { pageId: page.id },
    orderBy: { position: "asc" },
    select: { id: true }
  });
  const currentIds = current.map((section) => section.id);

  if (ids.length !== currentIds.length) {
    throw conflict(
      `The order sent covers ${describeBlocks(ids.length)}, but this page has ${describeBlocks(currentIds.length)}. It has probably been changed in another tab — reload this page and make the move again. Nothing has been re-ordered.`
    );
  }

  // Every id must be one of THIS page's. Checking the set rather than only the count is what stops an id
  // from another page displacing one of these while the counts still match.
  const here = new Set(currentIds);
  const stranger = ids.find((candidate) => !here.has(candidate));
  if (stranger !== undefined) {
    throw conflict(
      "One of the blocks in that order is not on this page. Reload the page and make the move again. Nothing has been re-ordered."
    );
  }

  // Nothing to do. Answered as success: the client's optimistic list already shows this order, and an error
  // would roll it back to the identical order while claiming something went wrong.
  if (ids.every((candidate, index) => candidate === currentIds[index])) {
    return ok({ order: currentIds, changed: false });
  }

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "UPDATE",
      entityType: "Page",
      entityLabel: page.title,
      before: { sectionOrder: currentIds },
      // A re-order is logged, not versioned: the blocks themselves are unchanged, and a revision of the
      // page's own fields that differs from the last one in nothing at all is noise in the history panel.
      revise: false
    },
    async (tx) => {
      await rewriteSectionPositions(tx, page.id, ids);

      // The set of words on the page has not changed, but their order in the indexed text has, and the page
      // is cheap to re-index. Keeping every writer of `PageSection` re-indexing means no writer has to
      // reason about whether its particular change mattered to search.
      await reindexPage(tx, page.id);

      return { id: page.id, sectionOrder: ids };
    }
  );

  return ok({ order: ids, changed: true });
});

function describeBlocks(count: number): string {
  return count === 1 ? "1 block" : `${count} blocks`;
}

export const PATCH = handler;
export const PUT = handler;
