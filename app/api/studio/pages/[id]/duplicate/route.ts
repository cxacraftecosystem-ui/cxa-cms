import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { normalisePageSlug, pagePath } from "@/lib/pages";
import { canManageStructure } from "@/lib/permissions";
import { buildAuditContext, found, isUniqueViolation, reindexPage } from "@/lib/studio/crud";
import { slugify } from "@/lib/utils";

/**
 * Copy a page, with its blocks.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE PROMISES THIS ENDPOINT MAKES, AND WHY EACH ONE IS NOT NEGOTIABLE.
 *
 *  1. **THE COPY IS A DRAFT.** Not scheduled, not published, with no `publishedAt`, no `publishAt` and no
 *     `unpublishAt` — whatever the original was. Duplicating is how somebody rewrites next year's version
 *     of a page that is currently in front of readers, and a copy that inherited PUBLISHED would put an
 *     unfinished draft of the Centre's own words on the public site the instant the button was pressed.
 *
 *  2. **THE COPY GETS A FREE ADDRESS, DERIVED AND SUFFIXED.** `Page.slug` is unique, so a copy cannot
 *     share one; and an address chosen by asking the reader would make "duplicate" a form rather than a
 *     button. `about` becomes `about-copy`, then `about-copy-2`. The check is a check and not a guarantee
 *     — two people duplicating the same page in the same second both pass it — which is why the unique
 *     index is the backstop and P2002 is answered as a sentence naming what to do.
 *
 *  3. **ALL OF IT IS ONE TRANSACTION.** `PageSection.pageId` is a foreign key, so the blocks cannot exist
 *     before the page; and a page created without its blocks is the failure mode this endpoint exists to
 *     avoid — a reader who asked for a copy of a twelve-block page and got an empty one has no way to tell
 *     that from a page whose blocks failed to copy, and will start rebuilding it by hand.
 *
 * ⚠ `isSystem` IS NEVER COPIED. That flag marks a page whose route the site's own code renders and links
 * to; a second page claiming it would be a page that cannot be deleted for a reason that is not true of it.
 *
 * ⚠ `canonicalUrl` IS NEVER COPIED EITHER, and this one is easy to get wrong in the other direction. A
 * canonical address means "the real version of this page lives here" — copying it would make the new page
 * declare the ORIGINAL as the authoritative one, which quietly removes the copy from every search result
 * and says nothing on screen about having done so. Everything else in the search-engine panel is carried
 * over, because it is a starting point the editor will rewrite.
 *
 * ⚠ THE PLACEHOLDER GATE IS NOT CALLED HERE, AND PROMISE 1 IS THE REASON. `pagePublishBlockers()` in
 * lib/pages.ts refuses to PUBLISH a page whose blocks still hold the studio's own prompt text, and the
 * PATCH in `../route.ts` calls it on the crossing into publication. A copy is created DRAFT, with
 * `publishedAt`, `publishAt` and `unpublishAt` all written as null a few lines below — it crosses
 * nothing, so the gate here could refuse nothing. The blocks are copied verbatim precisely so that a
 * half-finished page can be copied and finished; refusing that would make "duplicate" useless for the
 * one job it is most often asked to do. Whatever prompt text comes across is refused later, by the
 * PATCH, when somebody asks for the copy to go public.
 *
 * ⚠ IF PROMISE 1 IS EVER RELAXED — a copy that inherits the original's status — this endpoint MUST call
 * the gate on the same `LIVE_STATUSES` crossing the PATCH uses, or a published page's placeholders reach
 * readers again under a new address that nobody has read.
 *
 * ⚠ THERE IS NO REQUEST BODY, AND THAT IS THE WHOLE INPUT. The only thing this handler is told is which
 * page to copy, which arrives in the path — so the path parameter is what is validated with Zod. Accepting
 * a title or an address here would make the endpoint a second page editor with a second set of rules to
 * keep in step with `pages/[id]/route.ts`; the copy is a draft, and renaming a draft is what the editor is
 * for.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** The same ceiling as `pageBodySchema` in the pages routes, so a copy is always re-saveable as it is. */
const TITLE_MAX = 160;

/** The suffix appended to the copied title. Words, not "(1)": a reader has to see what happened. */
const TITLE_SUFFIX = " (copy)";

/**
 * `slugSchema` refuses an address longer than this, so a copy must fit inside it — otherwise the new page
 * exists at an address its own editor cannot save.
 */
const SLUG_MAX = 96;

/**
 * How many numbered addresses are tried before giving up.
 *
 * ⚠ A TWIN of the loop in app/studio/templates/page.tsx. The two cannot share a helper: a `route.ts` may
 * export nothing but its handlers — Next's generated type check refuses any other export — and a page
 * cannot import from one. Both take a base address and add `-2`, `-3` until one is free, and both refuse
 * rather than loop.
 */
const SLUG_ATTEMPTS = 50;

/**
 * The path parameter, validated.
 *
 * A shape test, not a foreign key — the row lookup below is what decides whether the page exists. It
 * exists so a pasted paragraph cannot become a 40 kB query against the primary key.
 */
const paramsSchema = z.object({
  id: z.string().trim().min(1, "Which page to copy was not given.").max(40)
});

/** Everything the copy carries over, plus what the audit trail and the response need to read. */
const SOURCE_SELECT = {
  id: true,
  title: true,
  slug: true,
  navLabel: true,
  seoTitle: true,
  seoDescription: true,
  seoImageId: true,
  seoNoIndex: true,
  sortOrder: true
} as const;

const COPY_SELECT = {
  id: true,
  title: true,
  slug: true,
  navLabel: true,
  status: true,
  publishedAt: true,
  publishAt: true,
  unpublishAt: true,
  seoTitle: true,
  seoDescription: true,
  seoImageId: true,
  seoNoIndex: true,
  canonicalUrl: true,
  isSystem: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true
} as const;

type CopyRow = Prisma.PageGetPayload<{ select: typeof COPY_SELECT }>;

/**
 * The address base a copy hangs off.
 *
 * The homepage's slug is the EMPTY STRING, so a copy of it has nothing to derive from — hence the fall
 * back to the title, and then to the word "page" for a title made entirely of punctuation. The base is
 * shortened so that `-copy-50` still fits inside `SLUG_MAX`.
 */
function slugBase(slug: string, title: string): string {
  const fromSlug = normalisePageSlug(slug);
  const base = fromSlug.length > 0 ? fromSlug : slugify(title);
  const usable = base.length > 0 ? base : "page";
  // "-copy-50" is the longest suffix this file can produce.
  return usable.slice(0, SLUG_MAX - "-copy-50".length).replace(/-+$/, "");
}

export const POST = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Copying a page needs editor access, because the copy is a new address on this site. An administrator can raise yours."
  );

  const { id } = paramsSchema.parse(await context.params);

  /**
   * A page in the recycle bin cannot be copied.
   *
   * Copying one would resurrect content an editor believes they have removed, under a new address and with
   * nothing on either row to say where it came from. Restoring it first is one click and leaves a trail.
   */
  const source = found(
    await prisma.page.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...SOURCE_SELECT,
        sections: {
          // Ordered in SQL. `position` is dense and unique per page, so this ordering is total — and the
          // copy has to come out in the same order or the new page reads as a different page.
          orderBy: { position: "asc" },
          select: { type: true, position: true, label: true, data: true, isVisible: true }
        }
      }
    }),
    "That page"
  );

  const { sections, ...page } = source;

  const title = `${page.title.slice(0, TITLE_MAX - TITLE_SUFFIX.length).trimEnd()}${TITLE_SUFFIX}`;
  const base = slugBase(page.slug, page.title);

  /**
   * The candidate addresses, checked in ONE query.
   *
   * `startsWith` rather than fifty round trips, and it deliberately catches soft-deleted pages too: a row
   * in the recycle bin still holds its slug and the unique index still refuses a second one, so a candidate
   * that looks free because it is "deleted" would fail the insert with nothing on screen explaining it.
   */
  const taken = new Set(
    (
      await prisma.page.findMany({
        where: { slug: { startsWith: base } },
        select: { slug: true }
      })
    ).map((row) => row.slug)
  );

  let slug = "";
  for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${base}-copy` : `${base}-copy-${attempt}`;
    if (!taken.has(candidate)) {
      slug = candidate;
      break;
    }
  }

  if (slug.length === 0) {
    throw conflict(
      `There are already ${SLUG_ATTEMPTS} copies of “${page.title}” at every address this one would use. Rename or delete some of them, or copy a different page.`
    );
  }

  const auditContext = buildAuditContext(request, user);

  try {
    const copy = await mutateWithHistory<CopyRow>(
      auditContext,
      {
        action: "CREATE",
        entityType: "Page",
        entityLabel: title,
        // Named, so the history of the copy says where it came from. A copy with no provenance is a page
        // nobody can explain a year later.
        summary: `Copied from “${page.title}” (${pagePath(page.slug)})`
      },
      async (tx) => {
        const row = await tx.page.create({
          data: {
            title,
            slug,
            navLabel: page.navLabel,
            // Promise 1. Written out rather than left to the column defaults, so the intent is legible at
            // the one place it matters.
            status: "DRAFT",
            publishedAt: null,
            publishAt: null,
            unpublishAt: null,
            seoTitle: page.seoTitle,
            seoDescription: page.seoDescription,
            seoImageId: page.seoImageId,
            seoNoIndex: page.seoNoIndex,
            // See the header: never carried over.
            canonicalUrl: null,
            isSystem: false,
            sortOrder: page.sortOrder
          },
          select: COPY_SELECT
        });

        if (sections.length > 0) {
          // One statement for every block. The source's positions are dense and unique per page and this
          // page has no other blocks, so there is nothing for `@@unique([pageId, position])` to collide
          // with and no two-pass renumbering to do.
          await tx.pageSection.createMany({
            data: sections.map((block) => ({
              pageId: row.id,
              type: block.type,
              position: block.position,
              label: block.label,
              // Copied verbatim. It was validated against its own schema when it was saved on the original,
              // and re-parsing it here would silently rewrite a payload an editor is looking at on the page
              // they asked to copy.
              data: block.data as Prisma.InputJsonValue,
              isVisible: block.isVisible
            }))
          });
        }

        // A page's searchable text is built from the words in its blocks, so this runs after they exist and
        // inside the same transaction. A draft is indexed as unpublished, which is what makes it findable in
        // the studio's own search and nowhere else.
        await reindexPage(tx, row.id);

        return row;
      }
    );

    return ok(
      {
        page: { ...copy, path: pagePath(copy.slug) },
        /** Stated, so a caller can say "12 blocks copied" rather than "done". */
        sectionsCopied: sections.length,
        copiedFrom: { id: page.id, title: page.title, path: pagePath(page.slug) }
      },
      { status: 201 }
    );
  } catch (error) {
    // Somebody else took the address between the check above and this insert. The honest answer names the
    // race rather than reporting a server fault, because nothing is wrong and pressing the button again
    // will work.
    if (isUniqueViolation(error)) {
      throw conflict(
        `The address “${slug}” was taken while this copy was being made. Nothing was created — try again.`
      );
    }
    throw error;
  }
});
