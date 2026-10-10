import { after, type NextRequest } from "next/server";

import { ApiError, assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { recordEvent } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { drainOutbox } from "@/lib/newsletter/drain";
import { enqueueIssue } from "@/lib/newsletter/issues";
import { assertMaySend, assertSendable, loadIssue } from "@/lib/newsletter/issue-studio";
import { canAuthor } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";
import { z } from "@/lib/zod";

/**
 * Send an issue to every confirmed subscriber, now.
 *
 * ⚠ IDEMPOTENT. The screen asks for confirmation first, and the request carries `confirm: true` so a
 * stray POST cannot send a mailing; beyond that, `enqueueIssue` queues an issue exactly once however many
 * times this is called (lib/newsletter/issues.ts). A second click answers with where the first one got
 * to, never with a second mailing.
 *
 * The first batch starts straight after the answer is sent (`after`), so a mailing to a few hundred
 * readers is usually finished before the scheduled drain would even have woken.
 */

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const SendBody = z.object({
  confirm: z.literal(true, { error: "Confirm the send before it can go out." })
});

export const POST = route(async (request: NextRequest, context: Context) => {
  assertSameOrigin(request);
  const user = await requireCapability(canAuthor, "Sending a newsletter needs publishing access.");
  assertMaySend(user);
  await parseStudioJson(request, SendBody);

  const { id } = await context.params;
  const issue = await loadIssue(id);

  if (issue.status === "SENDING" || issue.status === "SENT") {
    // Already queued: nothing is queued twice. While it is still sending, a press (or the issue screen's
    // periodic nudge) runs another batch, so a mailing does not depend on the best-effort schedule.
    if (issue.status === "SENDING") startBatch();
    return ok({ status: issue.status, recipients: issue.recipientCount, alreadyQueued: true });
  }
  if (issue.status === "CANCELLED") {
    throw conflict("This issue was cancelled. Write a new issue to send it again.");
  }
  assertSendable(issue);

  const outcome = await enqueueIssue(id, user.id);
  if (!outcome.queued) {
    if (outcome.status === "SENDING" || outcome.status === "SENT") {
      const current = await loadIssue(id);
      return ok({ status: current.status, recipients: current.recipientCount, alreadyQueued: true });
    }
    throw new ApiError(409, "This issue changed while you were looking at it. Reload and try again.", {
      code: "conflict"
    });
  }

  await recordEvent(buildAuditContext(request, user), {
    action: "PUBLISH",
    entityType: "NewsletterIssue",
    entityId: id,
    entityLabel: issue.title,
    after: { status: "SENDING", recipients: outcome.recipients }
  });

  startBatch();

  const current = await loadIssue(id);
  return ok({ status: current.status, recipients: outcome.recipients, alreadyQueued: false });
});

/** One drain batch after the response has gone, inside this function's time limit (vercel.json). */
function startBatch(): void {
  after(async () => {
    try {
      await drainOutbox({ budgetMs: 35_000 });
    } catch (error) {
      console.error("[newsletter] a batch after a send could not run; the schedule will pick it up.", error);
    }
  });
}
