import type { NextRequest } from "next/server";

import { ApiError, assertSameOrigin, ok, route } from "@/lib/api";
import { recordEvent } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { normaliseEmail } from "@/lib/newsletter/address";
import { mailerConfigured } from "@/lib/newsletter/delivery";
import { sendIssueTest } from "@/lib/newsletter/issues";
import { assertMayEdit, assertSendable, loadIssue } from "@/lib/newsletter/issue-studio";
import { canAuthor } from "@/lib/permissions";
import { enforceRateLimit } from "@/lib/ratelimit";
import { buildAuditContext } from "@/lib/studio/crud";

/**
 * "Send a test to me": one copy of the issue, now, to the signed-in member of staff's own address.
 *
 * Never to anybody else — the address is the session's, not a field in the request — so this cannot be
 * used to mail an arbitrary person from the Centre's sender. The copy is labelled as a test in its
 * subject and body, carries the real unsubscribe link and headers so they can be checked, and is not
 * counted in the issue's delivery figures.
 */

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const POST = route(async (request: NextRequest, context: Context) => {
  assertSameOrigin(request);
  const user = await requireCapability(canAuthor, "Sending a test needs author access or higher.");

  const limited = enforceRateLimit(request, "newsletter-test-send", { limit: 10, windowSeconds: 15 * 60 });
  if (limited) return limited;

  const { id } = await context.params;
  const issue = await loadIssue(id);
  assertMayEdit(user, issue);
  assertSendable(issue);

  if (!mailerConfigured()) {
    throw new ApiError(409, "Email sending is not set up on this site yet, so a test cannot be sent.", {
      code: "sender_not_configured"
    });
  }

  const emailKey = normaliseEmail(user.email);
  if (!emailKey) {
    throw new ApiError(422, "Your account's email address could not be used as a recipient.", {
      code: "bad_recipient"
    });
  }

  const outcome = await sendIssueTest(issue, { email: user.email, emailKey });

  await recordEvent(buildAuditContext(request, user), {
    action: "UPDATE",
    entityType: "NewsletterIssue",
    entityId: issue.id,
    entityLabel: issue.title,
    after: { testSent: outcome }
  });

  if (outcome === "failed") {
    throw new ApiError(502, "The test could not be delivered to your address. The reason is in the subscribers screen's list of messages that were not delivered.", {
      code: "test_failed"
    });
  }

  return ok({
    outcome,
    message:
      outcome === "sent"
        ? `A test copy is on its way to ${user.email}.`
        : `The test copy is queued for ${user.email} and will go out within a few minutes.`
  });
});
