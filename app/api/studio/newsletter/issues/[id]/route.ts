import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { issueDeliveryCounts } from "@/lib/newsletter/issues";
import {
  ISSUE_SELECT,
  IssuePatchBody,
  assertEditable,
  assertMayEdit,
  loadIssue,
  storedBody,
  type IssueRow
} from "@/lib/newsletter/issue-studio";
import { canAuthor } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";

/**
 * One newsletter issue: read it with its live delivery counts, save the draft, or remove a draft.
 *
 * Editing is allowed while the issue is a draft or scheduled. Once it is queued the words are what went
 * out, and the route says so rather than saving a change nobody will receive.
 */

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_request: NextRequest, context: Context) => {
  await requireCapability(canAuthor, "Newsletter issues need author access or higher.");
  const { id } = await context.params;
  const item = await loadIssue(id);
  const counts = await issueDeliveryCounts(id);
  return ok({ item, counts });
});

export const PATCH = route(async (request: NextRequest, context: Context) => {
  assertSameOrigin(request);
  const user = await requireCapability(canAuthor, "Changing a newsletter issue needs author access or higher.");
  const { id } = await context.params;
  const body = await parseStudioJson(request, IssuePatchBody);

  const before = await loadIssue(id);
  assertMayEdit(user, before);
  assertEditable(before.status);

  if (body.expectedUpdatedAt && body.expectedUpdatedAt !== before.updatedAt.toISOString()) {
    throw conflict(
      "Somebody else has saved this issue since you opened it. Copy anything you need, then reload to see their version."
    );
  }

  const data: Prisma.NewsletterIssueUpdateInput = { updatedById: user.id };
  if (body.title !== undefined) data.title = body.title;
  if (body.subject !== undefined) data.subject = body.subject;
  if (body.preheader !== undefined) {
    data.preheader = body.preheader && body.preheader.length > 0 ? body.preheader : null;
  }
  if (body.body !== undefined) data.body = storedBody(body.body) ?? Prisma.DbNull;

  const updated = await mutateWithHistory<IssueRow>(
    buildAuditContext(request, user),
    { action: "UPDATE", entityType: "NewsletterIssue", entityLabel: body.title ?? before.title, before },
    async (tx) => {
      // Guarded on the status, so a save that races a Send cannot change the words after they were queued.
      const changed = await tx.newsletterIssue.updateMany({
        where: { id, deletedAt: null, status: { in: ["DRAFT", "SCHEDULED"] } },
        data: data as Prisma.NewsletterIssueUpdateManyMutationInput
      });
      if (changed.count === 0) {
        throw conflict("This issue was sent or cancelled while you were editing it, so the change was not saved.");
      }
      return tx.newsletterIssue.findUniqueOrThrow({ where: { id }, select: ISSUE_SELECT });
    }
  );

  return ok({ item: updated });
});

export const DELETE = route(async (request: NextRequest, context: Context) => {
  assertSameOrigin(request);
  const user = await requireCapability(canAuthor, "Removing a newsletter issue needs author access or higher.");
  const { id } = await context.params;

  const before = await loadIssue(id);
  assertMayEdit(user, before);
  if (before.status !== "DRAFT") {
    throw conflict(
      "Only a draft can be removed. A scheduled issue has to be taken off the schedule first, and a sent one is a record of what went out."
    );
  }

  await mutateWithHistory<IssueRow>(
    buildAuditContext(request, user),
    { action: "DELETE", entityType: "NewsletterIssue", entityLabel: before.title, before, revise: false },
    async (tx) => {
      const changed = await tx.newsletterIssue.updateMany({
        where: { id, deletedAt: null, status: "DRAFT" },
        data: { deletedAt: new Date(), updatedById: user.id }
      });
      if (changed.count === 0) throw conflict("This issue changed while you were looking at it. Reload and try again.");
      return tx.newsletterIssue.findUniqueOrThrow({ where: { id }, select: ISSUE_SELECT });
    }
  );

  return ok({ removed: true });
});
