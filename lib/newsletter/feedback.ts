import "server-only";

import { prisma } from "@/lib/db";
import { normaliseEmail } from "@/lib/newsletter/address";

/**
 * What an Amazon SES bounce or complaint means for the list.
 *
 * Two notification shapes reach the webhook, and both are read:
 *
 *   • **Identity feedback notifications** — `{ "notificationType": "Bounce" | "Complaint", ... }` — which is
 *     what an SES identity publishes to an SNS topic directly.
 *   • **Configuration-set event publishing** — `{ "eventType": "Bounce" | "Complaint", ... }`.
 *
 * ⚠ ONLY A PERMANENT BOUNCE STOPS MAIL. A transient bounce (mailbox full, an auto-reply, a greylisting
 * server) is the receiving side having a bad day; marking it would take people off the list for a
 * full inbox. SES retries transient failures itself.
 *
 * ⚠ A COMPLAINT IS ALSO AN UNSUBSCRIBE. Somebody who pressed "Report spam" has said, in the strongest way
 * available to them, that they do not want this. Their row becomes UNSUBSCRIBED (kept, as every
 * unsubscribe is) and carries `complainedAt`, and no receipt is sent: writing to somebody who has just
 * reported you is the one thing guaranteed to make it worse.
 *
 * Addresses are looked up by `normaliseEmail`, the same identity every other path uses.
 */

export interface FeedbackSummary {
  kind: "bounce" | "complaint" | "ignored";
  /** How many subscriber rows this changed. */
  marked: number;
}

interface SesRecipient {
  emailAddress?: unknown;
}

function addressesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const keys: string[] = [];
  for (const entry of list as SesRecipient[]) {
    if (typeof entry?.emailAddress !== "string") continue;
    // SES may give `"Name" <a@b>`; take what is inside the brackets when there are any.
    const bracketed = /<([^>]+)>/.exec(entry.emailAddress);
    const key = normaliseEmail(bracketed ? bracketed[1] : entry.emailAddress);
    if (key) keys.push(key);
  }
  return [...new Set(keys)];
}

export async function applySesFeedback(rawMessage: string, now: Date = new Date()): Promise<FeedbackSummary> {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawMessage) as Record<string, unknown>;
  } catch {
    return { kind: "ignored", marked: 0 };
  }

  const type = (typeof event.notificationType === "string" ? event.notificationType : event.eventType) as unknown;

  if (type === "Bounce") {
    const bounce = (event.bounce ?? {}) as { bounceType?: unknown; bouncedRecipients?: unknown };
    if (bounce.bounceType !== "Permanent") return { kind: "ignored", marked: 0 };
    const keys = addressesOf(bounce.bouncedRecipients);
    if (keys.length === 0) return { kind: "bounce", marked: 0 };

    const marked = await prisma.newsletterSubscriber.updateMany({
      where: { emailKey: { in: keys }, bouncedAt: null },
      data: { bouncedAt: now }
    });
    await suppressQueued(keys, "Mail to this address bounced permanently.");
    return { kind: "bounce", marked: marked.count };
  }

  if (type === "Complaint") {
    const complaint = (event.complaint ?? {}) as { complainedRecipients?: unknown };
    const keys = addressesOf(complaint.complainedRecipients);
    if (keys.length === 0) return { kind: "complaint", marked: 0 };

    const marked = await prisma.newsletterSubscriber.updateMany({
      where: { emailKey: { in: keys }, complainedAt: null },
      data: { complainedAt: now }
    });
    // The unsubscribe half, guarded so an existing unsubscribe date is not overwritten.
    await prisma.newsletterSubscriber.updateMany({
      where: { emailKey: { in: keys }, status: { in: ["PENDING", "CONFIRMED"] } },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: now, confirmationToken: null, confirmationExpiresAt: null }
    });
    await suppressQueued(keys, "This address reported a previous message as spam.");
    return { kind: "complaint", marked: marked.count };
  }

  return { kind: "ignored", marked: 0 };
}

/** Anything still waiting for these addresses is suppressed at once, so the studio's counts say so. */
async function suppressQueued(keys: string[], reason: string): Promise<void> {
  await prisma.newsletterDelivery.updateMany({
    where: { emailKey: { in: keys }, state: "RECORDED", kind: { not: "CONFIRMATION" } },
    data: { state: "SUPPRESSED", error: reason }
  });
}
