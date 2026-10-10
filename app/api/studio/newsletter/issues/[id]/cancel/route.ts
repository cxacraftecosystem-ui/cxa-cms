import type { NextRequest } from "next/server";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { recordEvent } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { cancelIssue, issueDeliveryCounts, refreshIssue } from "@/lib/newsletter/issues";
import { assertMaySend, loadIssue } from "@/lib/newsletter/issue-studio";
import { canAuthor } from "@/lib/permissions";
import { buildAuditContext } from "@/lib/studio/crud";

/**
 * Stop an issue that is sending. Copies already sent cannot be recalled; every copy still waiting is
 * marked cancelled and will not go out. Publishing access, as for sending.
 */

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const POST = route(async (request: NextRequest, context: Context) => {
  assertSameOrigin(request);
  const user = await requireCapability(canAuthor, "Cancelling a newsletter send needs publishing access.");
  assertMaySend(user);

  const { id } = await context.params;
  const issue = await loadIssue(id);

  const cancelled = await cancelIssue(id);
  if (!cancelled) {
    throw conflict("This issue is not sending, so there is nothing to cancel. Reload to see where it stands.");
  }
  await refreshIssue(id);

  await recordEvent(buildAuditContext(request, user), {
    action: "UNPUBLISH",
    entityType: "NewsletterIssue",
    entityId: id,
    entityLabel: issue.title,
    after: { status: "CANCELLED" }
  });

  return ok({ item: await loadIssue(id), counts: await issueDeliveryCounts(id) });
});
