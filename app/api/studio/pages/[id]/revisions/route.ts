import { z } from "zod";

import { ok, route } from "@/lib/api";
import { listRevisions } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { pagePath } from "@/lib/pages";
import { canManageStructure } from "@/lib/permissions";
import { found, parseStudioQuery } from "@/lib/studio/crud";

/**
 * Every saved version of one page's own details.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NO `data` IN THE LIST, AND THAT IS THE POINT.
 *
 * `listRevisions()` selects the version number, the summary, the date and the author, and deliberately
 * omits the stored snapshot: fifty snapshots of a page is a payload nobody reads, and the panel fetches
 * ONE on demand from `[version]/route.ts` when a reader asks to compare. `RevisionHistory` is built
 * around exactly that split.
 *
 * THE CAP IS REPORTED, NOT MERELY APPLIED. `total` counts every revision this page has and `truncated`
 * says whether this answer carries all of them. A history that quietly stops at fifty is indistinguishable
 * from a page that has only ever been saved fifty times (contract §1.6) — and `RevisionHistory` prints the
 * sentence about it from `take`, so `take` travels back in the answer rather than being assumed.
 *
 * THE DEFAULT IS 50 BECAUSE THREE PLACES ALREADY AGREE ON 50: `listRevisions`'s own default, the server
 * component in `app/studio/pages/[id]/page.tsx` that hands the first list down, and `DEFAULT_TAKE` in
 * `RevisionHistory`. A fourth number here would make the cap notice wrong on whichever screen did not use
 * this route.
 *
 * A PAGE IN THE RECYCLE BIN STILL HAS A HISTORY, and it is readable — the same rule as `GET` on
 * `pages/[id]`. Refusing here would make the recycle bin unable to say what it holds. The answer says
 * plainly that the page is in the bin, because restoring a version of a deleted page is refused by the
 * restore handler and a reader deserves to know that before they try.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `canManageStructure` — the same predicate `pages/[id]`'s PATCH enforces. A page's history is a list of
 * its past titles, addresses and search-engine settings, so it is read by the people who may change them.
 */

export const dynamic = "force-dynamic";

/** How many versions one request may ask for, and how many it gets when it does not say. See the header. */
const DEFAULT_TAKE = 50;
const MAX_TAKE = 200;

const listQuery = z.object({
  take: z.coerce
    .number()
    .int("The number of versions must be a whole number.")
    .min(1, "Ask for at least one version.")
    .max(MAX_TAKE, `Ask for at most ${MAX_TAKE} versions at a time.`)
    .default(DEFAULT_TAKE)
});

export const GET = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(
    canManageStructure,
    "A page's version history needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  // `parseStudioQuery` rather than `parseQuery`: `take` carries a default, so the schema's input and
  // output types differ and the plain helper would type it `| undefined` (lib/studio/crud.ts).
  const query = parseStudioQuery(request, listQuery);

  const page = found(
    await prisma.page.findUnique({
      where: { id },
      select: { id: true, title: true, slug: true, deletedAt: true }
    }),
    "That page"
  );

  const [revisions, total] = await Promise.all([
    listRevisions("Page", page.id, query.take),
    // Counted separately rather than inferred from the rows: "fifty came back" and "there are exactly
    // fifty" are different facts, and the sentence on screen depends on which one is true.
    prisma.revision.count({ where: { entityType: "Page", entityId: page.id } })
  ]);

  return ok({
    revisions,
    total,
    /** What was asked for, so the screen's cap notice states the right number. */
    take: query.take,
    truncated: total > revisions.length,
    page: {
      id: page.id,
      title: page.title,
      path: pagePath(page.slug),
      /** True when the page is in the recycle bin — restoring a version of it will be refused. */
      inRecycleBin: page.deletedAt !== null
    }
  });
});
