import type { NextRequest } from "next/server";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { recordEvent } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { assertMaySend, assertSendable, loadIssue } from "@/lib/newsletter/issue-studio";
import { canAuthor } from "@/lib/permissions";
import { buildAuditContext, fieldProblem, parseStudioJson, requiredDateTime } from "@/lib/studio/crud";
import { z } from "@/lib/zod";

/**
 * Schedule an issue (POST), or take it off the schedule (DELETE).
 *
 * A scheduled issue is queued by the first drain run at or after `scheduledAt`, so it goes out shortly
 * after that time rather than on the second — the screen says so. Publishing access, as for a send now.
 */

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const ScheduleBody = z.object({
  scheduledAt: requiredDateTime("The send time", "Choose when the issue should go out.")
});

export const POST = route(async (request: NextRequest, context: Context) => {
  assertSameOrigin(request);
  const user = await requireCapability(canAuthor, "Scheduling a newsletter needs publishing access.");
  assertMaySend(user);
  const body = await parseStudioJson(request, ScheduleBody);

  const { id } = await context.params;
  const issue = await loadIssue(id);
  assertSendable(issue);

  if (body.scheduledAt.getTime() < Date.now() + 60_000) {
    throw fieldProblem("scheduledAt", "Choose a time at least a minute from now, or send it now instead.");
  }

  const changed = await prisma.newsletterIssue.updateMany({
    where: { id, deletedAt: null, status: { in: ["DRAFT", "SCHEDULED"] } },
    data: { status: "SCHEDULED", scheduledAt: body.scheduledAt, sentById: user.id, updatedById: user.id }
  });
  if (changed.count === 0) throw conflict("This issue has already been sent or cancelled.");

  await recordEvent(buildAuditContext(request, user), {
    action: "UPDATE",
    entityType: "NewsletterIssue",
    entityId: id,
    entityLabel: issue.title,
    after: { status: "SCHEDULED", scheduledAt: body.scheduledAt.toISOString() }
  });

  return ok({ item: await loadIssue(id) });
});

export const DELETE = route(async (request: NextRequest, context: Context) => {
  assertSameOrigin(request);
  const user = await requireCapability(canAuthor, "Changing a newsletter schedule needs publishing access.");
  assertMaySend(user);

  const { id } = await context.params;
  const issue = await loadIssue(id);

  const changed = await prisma.newsletterIssue.updateMany({
    where: { id, deletedAt: null, status: "SCHEDULED" },
    data: { status: "DRAFT", scheduledAt: null, updatedById: user.id }
  });
  if (changed.count === 0) {
    throw conflict("This issue is no longer scheduled — it may have started sending. Reload to see where it stands.");
  }

  await recordEvent(buildAuditContext(request, user), {
    action: "UPDATE",
    entityType: "NewsletterIssue",
    entityId: id,
    entityLabel: issue.title,
    after: { status: "DRAFT", unscheduled: true }
  });

  return ok({ item: await loadIssue(id) });
});
