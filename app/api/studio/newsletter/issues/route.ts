import type { NextRequest } from "next/server";

import { assertSameOrigin, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { ISSUE_SELECT, IssueCreateBody, storedBody, type IssueRow } from "@/lib/newsletter/issue-studio";
import { canAuthor } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";

/**
 * Newsletter issues — the list, and a new draft.
 *
 * Author access and up, the same floor as writing a news article: an issue is drafted like one, and
 * sending it is a separate act that takes publishing access (lib/newsletter/issue-studio.ts).
 */

export const dynamic = "force-dynamic";

/** Issues are a few a year; a hundred is years of them. The screen says so if it is ever reached. */
const MAX_ROWS = 100;

export const GET = route(async () => {
  await requireCapability(canAuthor, "Newsletter issues need author access or higher.");

  const [items, total] = await Promise.all([
    prisma.newsletterIssue.findMany({
      where: { deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_ROWS,
      select: ISSUE_SELECT
    }),
    prisma.newsletterIssue.count({ where: { deletedAt: null } })
  ]);

  return ok({ items, total, truncated: total > items.length, limit: MAX_ROWS });
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);
  const user = await requireCapability(canAuthor, "Writing a newsletter issue needs author access or higher.");
  const body = await parseStudioJson(request, IssueCreateBody);

  const created = await mutateWithHistory<IssueRow>(
    buildAuditContext(request, user),
    { action: "CREATE", entityType: "NewsletterIssue", entityLabel: body.title },
    async (tx) =>
      tx.newsletterIssue.create({
        data: {
          title: body.title,
          // The subject starts as the title; most issues keep it, and it is never empty.
          subject: body.subject ?? body.title,
          preheader: body.preheader,
          body: storedBody(body.body) ?? undefined,
          createdById: user.id,
          updatedById: user.id
        },
        select: ISSUE_SELECT
      })
  );

  return ok({ item: created }, { status: 201 });
});
