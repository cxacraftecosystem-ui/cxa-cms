import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, conflict, noContent, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { LIVE_STATUSES } from "@/lib/content";
import { prisma } from "@/lib/db";
import {
  describePublishBlockers,
  normalisePageSlug,
  pagePath,
  pagePublishBlockers,
  pageSlugConflict
} from "@/lib/pages";
import { canAccessStudio, canManageStructure } from "@/lib/permissions";
import {
  assertMediaAvailable,
  assertSlugAvailable,
  boundedInt,
  buildAuditContext,
  dropSearchDocument,
  fieldProblem,
  found,
  isUniqueViolation,
  optionalDateTime,
  optionalId,
  optionalText,
  parseStudioJson,
  publishTransition,
  requiredText,
  slugSchema,
  statusSchema,
  syncSearchDocument
} from "@/lib/studio/crud";

/**
 * One page: read it, save it, put it in the recycle bin.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * MOVING A PAGE LEAVES A REDIRECT BEHIND, and that is the most important thing this file does.
 *
 * An institutional address is quoted in papers, syllabi, emails and other people's websites that all
 * outlive the page itself. Changing a slug without a redirect turns every one of those into "page not
 * found", silently and permanently. So `createRedirect` defaults to TRUE, and three things happen when a
 * published page's address changes:
 *
 *   1. a `Redirect` row is written from the old address to the new one;
 *   2. any redirect that pointed AT the old address is re-pointed at the new one, so a citation from two
 *      moves ago still resolves in one hop rather than a chain;
 *   3. any redirect whose source is the NEW address is deleted — a page must win the address it claims,
 *      or the page would be unreachable at its own URL.
 *
 * All three are inside the same transaction as the page's own update: a redirect that exists without the
 * move (or the reverse) is worse than neither.
 *
 * A SYSTEM PAGE CANNOT BE DELETED. `isSystem` marks a page whose route the site's own code renders and
 * links to; deleting it would 404 a link the site draws itself. It CAN be renamed, which is why the
 * redirect logic above matters even more for one.
 *
 * AND THIS IS WHERE A PLACEHOLDER IS REFUSED. The PATCH is the handler that carries a page's status, so
 * it is the one place a page can cross from private into public — which makes it the only honest place
 * to check that no block still says "Add a heading". See the long note at the call to
 * `pagePublishBlockers()` below for exactly which crossings are checked and which are deliberately not.
 *
 * ⚠ The body schema is a twin of the one in `../route.ts`. See the note there for why it is not shared.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const pageBodySchema = z.object({
  title: requiredText(160, "A page needs a title. It appears at the top of the page and in every list."),
  slug: z
    .string()
    .trim()
    .transform((value) => normalisePageSlug(value))
    .pipe(slugSchema({ allowEmpty: true, allowSlashes: true }))
    /*
     * ⚠ AND THE ROUTER MUST BE ABLE TO SERVE IT. `slugSchema` checks the SHAPE — that the characters
     * are URL-safe — and a perfectly shaped slug can still be an address this application will never
     * render: `news/annual-review` is matched by `app/(site)/news/[slug]`, which looks for an article
     * called "annual-review", finds none, and answers 404. The page would sit in the studio marked
     * PUBLISHED, appear in every list, and 404 for the editor who made it.
     *
     * Refused here rather than filtered downstream, because this is the one place the person who typed
     * it is still looking. `pageSlugConflict` returns the sentence naming the collision.
     */
    .superRefine((value, ctx) => {
      const conflict = pageSlugConflict(value);
      // `superRefine` and not `refine`, because the MESSAGE is computed from the value — `refine` can
      // only decide pass or fail and would have to carry a generic sentence. Using both would emit
      // two errors for one mistake, which is how a form ends up telling somebody the same thing twice.
      if (conflict) ctx.addIssue({ code: z.ZodIssueCode.custom, message: conflict });
    }),
  navLabel: optionalText(60),
  status: statusSchema,
  publishAt: optionalDateTime("The date it goes public"),
  unpublishAt: optionalDateTime("The date it comes off the site"),
  seoTitle: optionalText(90),
  seoDescription: optionalText(220),
  seoImageId: optionalId(),
  seoNoIndex: z.boolean(),
  canonicalUrl: optionalText(500).refine(
    (value) => value === null || /^https?:\/\//i.test(value),
    "A canonical address must be a full address beginning with https://. Leave it empty to use this page's own address."
  ),
  sortOrder: boundedInt({ min: -9999, max: 9999, fallback: 0 }),
  /**
   * Whether to leave a redirect behind when the address changes. Ignored when it has not changed.
   *
   * Defaults to true, because the failure it prevents is silent and permanent and the failure it risks is
   * one unnecessary row in a table nobody looks at.
   */
  createRedirect: z.boolean().default(true)
});

/**
 * Every field the editor may write, which is also exactly what a revision stores.
 *
 * The keys match `PageSettingsValue` in `PageEditor`, so the history panel can compare a stored version
 * with what is on screen field by field and label each one.
 */
const PAGE_EDITABLE_SELECT = {
  id: true,
  slug: true,
  title: true,
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

/** The row shape `PAGE_EDITABLE_SELECT` produces, so the response type says what it actually carries. */
type PageRow = Prisma.PageGetPayload<{ select: typeof PAGE_EDITABLE_SELECT }>;

/** Drop the keys a PATCH did not mention, so an absent key means "leave this column alone". */
function definedOnly(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export const GET = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  await requireCapability(canAccessStudio);
  const { id } = await context.params;

  // A soft-deleted page is still readable: the recycle bin shows what it would restore, and refusing here
  // would make that screen impossible to build.
  const page = found(
    await prisma.page.findUnique({
      where: { id },
      select: {
        ...PAGE_EDITABLE_SELECT,
        seoImage: {
          select: {
            id: true,
            objectKey: true,
            width: true,
            height: true,
            altText: true,
            blurDataUrl: true,
            variants: { select: { label: true, format: true, objectKey: true, width: true } }
          }
        },
        sections: {
          orderBy: { position: "asc" },
          select: { id: true, type: true, position: true, label: true, data: true, isVisible: true }
        }
      }
    }),
    "That page"
  );

  const { seoImage, sections, ...row } = page;

  return ok({ page: { ...row, path: pagePath(row.slug) }, seoImage, sections });
});

export const PATCH = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Changing a page needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const body = await parseStudioJson(request, pageBodySchema.partial());

  // A page in the recycle bin must be restored before it can be edited: saving one would put work into a
  // row the editor believes they have removed, and the site would not show it either way.
  const existing = found(
    await prisma.page.findFirst({ where: { id, deletedAt: null }, select: PAGE_EDITABLE_SELECT }),
    "That page"
  );

  const slug = body.slug ?? existing.slug;
  if (slug !== existing.slug) await assertSlugAvailable("page", slug, id);

  if (body.seoImageId !== undefined) {
    await assertMediaAvailable(prisma, body.seoImageId, {
      field: "seoImageId",
      what: "picture for shared links"
    });
  }

  const publishAt = body.publishAt !== undefined ? body.publishAt : existing.publishAt;
  const unpublishAt = body.unpublishAt !== undefined ? body.unpublishAt : existing.unpublishAt;
  if (publishAt && unpublishAt && unpublishAt <= publishAt) {
    throw fieldProblem(
      "unpublishAt",
      "The date it comes off the site must be after the date it goes on."
    );
  }

  const transition = publishTransition(existing, { status: body.status, publishAt: body.publishAt }, user, {
    schedulable: true
  });

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THE PLACEHOLDER GATE. THIS IS THE CALL `pagePublishBlockers()` IN lib/pages.ts WAS WRITTEN FOR.
   *
   * The homepage went live carrying a literal "Add a heading" as its `<h2>`. Every mechanism in the
   * building saw it and not one of them refused: the block's schema was satisfied (a heading is
   * optional and "Add a heading" is a valid string), the seed validated, the renderer drew exactly
   * what it was given, and `lib/health.ts` — which finds it correctly and says so plainly — is a
   * REPORT that somebody has to open. So the refusal goes here, at the moment a person asks for the
   * page to become public. Same argument `pageSlugConflict` makes for an unservable address, in the
   * same handler, for the same reason: the one place the person who caused it is still looking.
   *
   * IT FIRES ON THE CROSSING, NOT ON EVERY SAVE, and that is the whole of the design:
   *
   *   • DRAFT / IN_REVIEW / ARCHIVED → PUBLISHED or SCHEDULED is refused while a VISIBLE block still
   *     holds one of the studio's own prompts. SCHEDULED counts as going public: nobody looks again
   *     when app/api/cron/publish flips it, so the only moment left to check is when the schedule is
   *     set.
   *   • PUBLISHED → PUBLISHED — an ordinary save of a live page — is NOT checked, and this is the half
   *     that keeps the gate honest. An editor fixing a typo on a page that has carried a placeholder
   *     since before this gate existed must not be locked out of the settings form by a rule they
   *     cannot satisfy from it: the offending words live in the BLOCKS, on the Content tab, and this
   *     handler writes the page's own columns. A check nobody can make pass is a trap, not a check.
   *   • PUBLISHED / SCHEDULED → DRAFT or ARCHIVED is not checked either. Taking a page off the site is
   *     always allowed, whatever it holds.
   *
   * ⚠ SO A PAGE THAT IS ALREADY LIVE WITH A PLACEHOLDER STAYS LIVE WITH IT until somebody publishes
   * it afresh. Deliberate, and it is exactly what `lib/health.ts`'s report is for: this gate stops the
   * next one, the report finds the ones that predate it. Grandfathering is the only rule that can be
   * satisfied by every row that already exists.
   *
   * ⚠ THE LADDER IS `LIVE_STATUSES`, WHICH IS COARSER THAN `isLive()`. Two consequences, both chosen:
   * a page scheduled for next year is treated as already committed to publication, so SCHEDULED →
   * PUBLISHED is not re-checked; and clearing a past `unpublishAt` on a retired page (which does make
   * it public again) is not caught, because the status does not move. The alternative — keying on
   * `isLive()` — would let DRAFT → SCHEDULED(future) through unchecked, which is strictly worse: that
   * one publishes itself with nobody in the room. `publishTransition` above draws its permission
   * boundary at this same ladder, so one crossing needs publishing rights and passes this gate.
   *
   * ⚠ THERE IS A THIRD WAY A PAGE BECOMES READABLE — `deletedAt` — AND IT IS NOT A CONSEQUENCE OF THE
   * CHOICE ABOVE, WHICH IS WHY IT IS NOT IN THAT LIST. `isLive()` is false for as long as `deletedAt` is
   * set, so clearing it does put a PUBLISHED page's blocks back in front of readers. But this handler
   * cannot see such a row at all: `existing` is fetched with `where: { id, deletedAt: null }` a few dozen
   * lines above, so the value is `null` on every input that reaches this line and keying on `isLive()`
   * rather than on the ladder would change nothing about it. The crossing lives in a different route —
   * `app/api/studio/recycle-bin/restore/route.ts` — and it is ungated for the same grandfathering reason
   * as PUBLISHED → PUBLISHED here: those blocks were already public before the page was binned, and no
   * NEW placeholder can be smuggled in while it sits there, because both block editors refuse a page with
   * `deletedAt` set. The survey in `pagePublishBlockers()`'s own header lists it with the rest.
   *
   * ⚠ THE BLOCKS ARE READ IN A SECOND QUERY, AND ONLY ON THE CROSSING. The transaction below reads
   * them again for the search index with a narrower select; sharing one read would mean either
   * checking after the write (too late) or widening the index's select for a reason that has nothing
   * to do with indexing. Ordered by `position`, so a refusal that names three blocks of nine names
   * them in the order they appear down the page — which is the order the editor will look in.
   *
   * The check sits OUTSIDE the transaction, exactly like `assertSlugAvailable` above it. A colleague
   * editing a block in the gap between this read and the commit is a race nothing here can close, and
   * the cost of losing it is one unreviewed placeholder rather than a half-written row.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const wasPublic = LIVE_STATUSES.includes(existing.status);
  const willBePublic = LIVE_STATUSES.includes(transition.status);

  if (willBePublic && !wasPublic) {
    const blocks = await prisma.pageSection.findMany({
      where: { pageId: id },
      orderBy: { position: "asc" },
      select: { type: true, data: true, isVisible: true, label: true }
    });

    // `describePublishBlockers` returns null for an empty list, so an unblocked publish cannot be
    // refused by a message that quotes nothing.
    const refusal = describePublishBlockers(pagePublishBlockers(blocks));
    // Attached to `status`, because that is the field the editor changed and the one the form can
    // point at — the same shape `publishTransition` uses for a schedule it cannot accept. The sentence
    // itself names the block and quotes the words, so `SaveBar` renders it verbatim and the reader can
    // find them with the browser's own search.
    if (refusal) throw fieldProblem("status", refusal);
  }

  const oldPath = pagePath(existing.slug);
  const newPath = pagePath(slug);
  // A redirect is only worth writing when there is an old address to redirect FROM. The homepage's slug is
  // the empty string, and "/" cannot redirect to a child page without taking the whole site with it.
  const redirecting =
    slug !== existing.slug && existing.slug.length > 0 && body.createRedirect !== false;

  const context_ = buildAuditContext(request, user);

  try {
    const updated = await mutateWithHistory<PageRow>(
      context_,
      {
        action: transition.action,
        entityType: "Page",
        entityLabel: body.title ?? existing.title,
        before: existing,
        summary: slug !== existing.slug ? `Address changed from /${existing.slug}` : null
      },
      async (tx) => {
        const row = await tx.page.update({
          where: { id },
          data: {
            ...definedOnly({
              title: body.title,
              navLabel: body.navLabel,
              seoTitle: body.seoTitle,
              seoDescription: body.seoDescription,
              seoImageId: body.seoImageId,
              seoNoIndex: body.seoNoIndex,
              canonicalUrl: body.canonicalUrl,
              sortOrder: body.sortOrder,
              publishAt: body.publishAt,
              unpublishAt: body.unpublishAt
            }),
            slug,
            status: transition.status,
            ...(transition.publishedAt ? { publishedAt: transition.publishedAt } : {}),
            ...(transition.publishAt === null ? { publishAt: null } : {})
          },
          select: PAGE_EDITABLE_SELECT
        });

        if (slug !== existing.slug) {
          // The page must win its own address. A leftover redirect from this path would send every reader
          // straight off it, and the page would look broken with nothing on screen to explain why.
          await tx.redirect.deleteMany({ where: { source: { in: [newPath, slug] } } });

          if (redirecting) {
            await tx.redirect.upsert({
              where: { source: oldPath },
              create: { source: oldPath, destination: newPath, permanent: true },
              // An existing row for the same source is re-pointed rather than left: it was written by an
              // earlier move of this same page, and the newest destination is the only correct one.
              update: { destination: newPath, permanent: true }
            });

            // Collapse chains: anything that used to arrive at the old address now arrives at the new one
            // directly. Two hops work, but each is a round trip and search engines discount them.
            await tx.redirect.updateMany({
              where: { destination: oldPath },
              data: { destination: newPath }
            });
          }
        }

        // The page's searchable text includes the words in its blocks, so the sections are read back and
        // handed to the indexer. Inside the transaction: an index that can disagree with the row is an
        // index that eventually will.
        const sections = await tx.pageSection.findMany({
          where: { pageId: id },
          select: { isVisible: true, data: true }
        });
        await syncSearchDocument(tx, "page", { ...row, sections });

        return row;
      }
    );

    return ok({ page: { ...updated, path: newPath }, redirectCreated: redirecting });
  } catch (error) {
    if (isUniqueViolation(error)) await assertSlugAvailable("page", slug, id);
    throw error;
  }
});

export const DELETE = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Deleting a page needs editor access. An administrator can raise yours."
  );
  const { id } = await context.params;

  const existing = found(
    await prisma.page.findUnique({
      where: { id },
      select: { id: true, slug: true, title: true, isSystem: true, deletedAt: true }
    }),
    "That page"
  );

  if (existing.isSystem) {
    throw conflict(
      `“${existing.title}” is one of the site's built-in pages: its address is written into the site's own menus and code, so deleting it would break links the site draws itself. It can be renamed or emptied of blocks instead.`
    );
  }

  // Already in the recycle bin. Answered as success rather than as a conflict — the reader asked for it to
  // be gone and it is gone, and a second click on a slow connection must not produce an error.
  if (existing.deletedAt) return noContent();

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, user),
    {
      action: "DELETE",
      entityType: "Page",
      entityLabel: existing.title,
      before: existing,
      // A delete is not a new version of the content. The revision history holds what the page WAS; a
      // snapshot of the moment it was thrown away adds nothing to restore from.
      revise: false
    },
    async (tx) => {
      const row = await tx.page.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: { id: true, slug: true, title: true, deletedAt: true }
      });

      // Out of search immediately. The recycle bin is reached from the studio, never from a search result,
      // and a public result pointing at a page that now 404s is the worst of both.
      await dropSearchDocument(tx, "page", id);

      // A lock on a deleted page can only ever tell somebody that a colleague is editing something that
      // no longer exists.
      await tx.contentLock.deleteMany({ where: { entityType: "Page", entityId: id } });

      return row;
    }
  );

  return noContent();
});
