import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { assertSameOrigin, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { normalisePageSlug, pagePath, pageSlugConflict } from "@/lib/pages";
import { canAccessStudio, canManageStructure } from "@/lib/permissions";
import {
  assertMediaAvailable,
  assertSlugAvailable,
  binWhere,
  boundedInt,
  buildAuditContext,
  fieldProblem,
  isUniqueViolation,
  listQuerySchema,
  optionalDateTime,
  optionalId,
  optionalText,
  pageWindow,
  paginated,
  parseStudioJson,
  parseStudioQuery,
  publishTransition,
  requiredText,
  resolveSort,
  slugSchema,
  statusSchema,
  syncSearchDocument,
  textSearchWhere
} from "@/lib/studio/crud";

/**
 * Pages — the list, and creating one.
 *
 * WHO MAY DO WHAT. Reading the list is open to anybody who can reach the studio: the link dialog in the
 * rich-text editor and the entity pickers in the section forms both search it, and an author writing a
 * news article legitimately needs to link to the About page. Creating one is `canManageStructure`,
 * because a new page is a new address on the institution's own domain.
 *
 * WHY THE LIST CARRIES `path` AS WELL AS `slug`. The homepage's slug is the EMPTY STRING, and the
 * tolerant client readers in components/studio/ treat an empty string as an absent field — so a list that
 * sent only the slug would show every page except the homepage in the link dialog. `path` is built by
 * `pagePath()`, the one function that knows `"" → "/"`.
 *
 * ⚠ THE BODY SCHEMA IS DECLARED IN THIS FILE AND AGAIN IN `[id]/route.ts`. A `route.ts` may not export
 * anything but its handlers and the route config — Next's generated type check refuses an unexpected
 * export — and one route module importing another is worse than a twin. The two are kept in step by
 * hand; every length below is also a `maxLength` on the matching field in `PageEditor`, so a change means
 * three edits, not two.
 */

export const dynamic = "force-dynamic";

/** The columns a page may be sorted by, and the column each name means. Nothing else reaches Prisma. */
const SORTABLE = {
  updatedAt: "updatedAt",
  createdAt: "createdAt",
  publishedAt: "publishedAt",
  title: "title",
  slug: "slug",
  order: "sortOrder"
} as const;

const listSchema = listQuerySchema.extend({
  /** `only` lists the pages whose route the site's own code owns; `exclude` hides them. */
  system: z.enum(["", "only", "exclude"]).default("")
});

/**
 * The page's own fields, as `PageEditor` sends them.
 *
 * `slug` is piped through `normalisePageSlug` BEFORE it is validated, so a pasted "/about/" is tidied
 * rather than refused — the shape check then runs on what will actually be stored.
 *
 * `publishedAt` arrives in the payload (the editor holds the whole row) and is deliberately NOT declared:
 * `z.object()` strips it, and `publishTransition()` is the only thing allowed to decide that column. If
 * this schema accepted it, an editor could rewrite the date an article claims to have appeared on.
 */
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
  status: statusSchema.default("DRAFT"),
  publishAt: optionalDateTime("The date it goes public"),
  unpublishAt: optionalDateTime("The date it comes off the site"),
  seoTitle: optionalText(90),
  seoDescription: optionalText(220),
  seoImageId: optionalId(),
  seoNoIndex: z.boolean().default(false),
  canonicalUrl: optionalText(500).refine(
    (value) => value === null || /^https?:\/\//i.test(value),
    "A canonical address must be a full address beginning with https://. Leave it empty to use this page's own address."
  ),
  sortOrder: boundedInt({ min: -9999, max: 9999, fallback: 0 })
});

/** Everything the editor may write, plus what the search index and the audit trail need to read. */
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

export const GET = route(async (request: Request) => {
  await requireCapability(canAccessStudio);

  const query = parseStudioQuery(request, listSchema);
  const { page, pageSize, skip, take } = pageWindow(query);

  const where: Record<string, unknown> = {
    ...binWhere(query.bin),
    ...(query.status === "" ? {} : { status: query.status }),
    ...(query.system === "" ? {} : { isSystem: query.system === "only" }),
    // Searching the slug as well as the title is what makes "about" find /research/about-us. Safe to
    // spread beside the filters above because none of them carries an `OR` of its own (`textSearchWhere`).
    ...textSearchWhere(query.q, ["title", "slug", "navLabel"])
  };

  const [rows, total] = await prisma.$transaction([
    prisma.page.findMany({
      where,
      orderBy: resolveSort(query, SORTABLE, "updatedAt"),
      skip,
      take,
      select: {
        id: true,
        slug: true,
        title: true,
        navLabel: true,
        status: true,
        publishedAt: true,
        publishAt: true,
        unpublishAt: true,
        seoNoIndex: true,
        isSystem: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        _count: { select: { sections: true } }
      }
    }),
    prisma.page.count({ where })
  ]);

  return ok(
    paginated(
      rows.map(({ _count, ...row }) => ({
        ...row,
        path: pagePath(row.slug),
        sectionCount: _count.sections
      })),
      total,
      page,
      pageSize
    )
  );
});

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const user = await requireCapability(
    canManageStructure,
    "Creating a page needs editor access. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, pageBodySchema);

  // An empty address is legal exactly once — it IS the homepage — and `assertSlugAvailable` is what
  // refuses a second one, naming the page that already holds it.
  await assertSlugAvailable("page", body.slug);
  await assertMediaAvailable(prisma, body.seoImageId, {
    field: "seoImageId",
    what: "picture for shared links"
  });

  if (body.publishAt && body.unpublishAt && body.unpublishAt <= body.publishAt) {
    throw fieldProblem(
      "unpublishAt",
      "The date it comes off the site must be after the date it goes on."
    );
  }

  const transition = publishTransition(
    { status: "DRAFT", publishedAt: null, publishAt: null },
    { status: body.status, publishAt: body.publishAt },
    user,
    { schedulable: true }
  );

  /*
   * ⚠ THE PLACEHOLDER GATE IS DELIBERATELY ABSENT HERE, AND THE REASON IS STRUCTURAL RATHER THAN AN
   * OVERSIGHT — which is why it is written down. `pagePublishBlockers()` in lib/pages.ts refuses to
   * publish a page whose BLOCKS still hold the studio's own prompt text, and it is called from the
   * PATCH in `[id]/route.ts`. A page created here has NO blocks: this schema accepts none, the create
   * below writes none, and `syncSearchDocument` is handed a literal `sections: []` on the next line but
   * one. So the gate could only ever return an empty list, and a call that cannot refuse anything is a
   * call the next reader has to prove is dead before they may touch it.
   *
   * The page is publishable-from-empty on purpose: an editor creates the page, then builds it. The
   * moment they add a block and publish, the PATCH is the handler that answers, and the gate is there.
   * ⚠ If this endpoint is ever given blocks to create — a template, an import — the gate belongs here
   * too, on the same `LIVE_STATUSES` crossing the PATCH uses.
   */

  const context = buildAuditContext(request, user);

  try {
    const created = await mutateWithHistory<PageRow>(
      context,
      {
        action: transition.action,
        entityType: "Page",
        entityLabel: body.title,
        summary: "Created"
      },
      async (tx) => {
        const row = await tx.page.create({
          data: {
            title: body.title,
            slug: body.slug,
            navLabel: body.navLabel,
            seoTitle: body.seoTitle,
            seoDescription: body.seoDescription,
            seoImageId: body.seoImageId,
            seoNoIndex: body.seoNoIndex,
            canonicalUrl: body.canonicalUrl,
            sortOrder: body.sortOrder,
            publishAt: transition.publishAt === null ? null : body.publishAt,
            unpublishAt: body.unpublishAt,
            status: transition.status,
            ...(transition.publishedAt ? { publishedAt: transition.publishedAt } : {})
          },
          select: PAGE_EDITABLE_SELECT
        });

        // A new page has no blocks, so its indexed text is the title and description alone. Indexing it
        // now rather than on first save means a draft is already findable in the studio's own search, and
        // a page created as PUBLISHED is findable on the site the moment it exists.
        await syncSearchDocument(tx, "page", { ...row, sections: [] });

        return row;
      }
    );

    return ok({ page: created }, { status: 201 });
  } catch (error) {
    // The unique index caught a page created at the same address in the same moment. The check above
    // would have given this answer a millisecond earlier; re-running it names the winner.
    if (isUniqueViolation(error)) await assertSlugAvailable("page", body.slug);
    throw error;
  }
});
