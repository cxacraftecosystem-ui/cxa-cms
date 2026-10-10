import { NextResponse, type NextRequest } from "next/server";

import { route } from "@/lib/api";
import { sesFeedbackTopicArns } from "@/lib/env";
import { applySesFeedback } from "@/lib/newsletter/feedback";
import { isAmazonSnsUrl, parseSnsMessage, verifySnsMessage } from "@/lib/newsletter/sns";

/**
 * Amazon SES bounce and complaint notifications, delivered by Amazon SNS over HTTPS.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT ARRIVES HERE, AND IN WHAT ORDER IT IS DISTRUSTED
 *
 *   1. **The body must be an SNS message** (`Type`, `Signature`, `SigningCertURL`, …). SNS posts it as
 *      `text/plain`, so the body is read as text and parsed, never via `request.json()`'s content-type
 *      expectations.
 *   2. **The topic must be one this deployment subscribed** (`sesFeedbackTopicArns()`, by default
 *      arn:aws:sns:ap-south-1:626159998512:ses-feedback). A validly signed message from somebody else's
 *      topic is still somebody else's.
 *   3. **The signature must verify** against Amazon's certificate (lib/newsletter/sns.ts). Only then is
 *      anything inside believed.
 *
 * Then, by type:
 *
 *   • `SubscriptionConfirmation` — SNS asks whether this endpoint wants the topic. The `SubscribeURL` is
 *     checked to be on Amazon's SNS host and fetched, which confirms the subscription. This happens once,
 *     when an operator subscribes the endpoint (docs/DEPLOYMENT.md says how).
 *   • `Notification` — a bounce or a complaint, applied by lib/newsletter/feedback.ts.
 *   • `UnsubscribeConfirmation` — acknowledged and otherwise ignored.
 *
 * ⚠ A REFUSED MESSAGE IS ANSWERED 403, NOT 200. SNS retries non-2xx deliveries, which is right for a
 * genuine message that failed for a transient reason and harmless for a forgery (nobody is retrying it).
 * A processing error is a 500 for the same reason: SNS will deliver it again.
 *
 * No address is logged; the summary line carries counts only.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** SNS bodies are small; anything far larger is not one. */
const MAX_BODY_BYTES = 256 * 1024;

function plain(status: number, text: string): NextResponse {
  return new NextResponse(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
}

export const POST = route(async (request: NextRequest) => {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return plain(413, "Too large.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return plain(400, "Not an SNS message.");
  }

  const message = parseSnsMessage(parsed);
  if (!message) return plain(400, "Not an SNS message.");

  if (!sesFeedbackTopicArns().includes(message.TopicArn)) {
    console.warn("[newsletter] SES feedback from an unexpected SNS topic was refused.");
    return plain(403, "Unexpected topic.");
  }

  const verified = await verifySnsMessage(message);
  if (!verified.ok) {
    console.warn(`[newsletter] an SNS message was refused (${verified.reason}).`);
    return plain(403, "Signature not verified.");
  }

  if (message.Type === "SubscriptionConfirmation") {
    if (!isAmazonSnsUrl(message.SubscribeURL, "subscribe")) return plain(400, "Unexpected subscribe URL.");
    const confirmation = await fetch(message.SubscribeURL as string, {
      redirect: "error",
      signal: AbortSignal.timeout(5000)
    });
    if (!confirmation.ok) {
      console.error(`[newsletter] confirming the SNS subscription answered ${confirmation.status}.`);
      return plain(502, "Subscription not confirmed.");
    }
    console.log("[newsletter] the SES feedback subscription has been confirmed.");
    return plain(200, "Subscribed.");
  }

  if (message.Type === "UnsubscribeConfirmation") return plain(200, "Noted.");

  const summary = await applySesFeedback(message.Message);
  console.log(`[newsletter] SES feedback: ${summary.kind}, ${summary.marked} subscriber(s) marked.`);
  return plain(200, "Received.");
});
