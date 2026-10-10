import "server-only";

import { prisma } from "@/lib/db";
import { sendUnsubscribeReceipt } from "@/lib/newsletter/delivery";

/**
 * The unsubscribe write, shared by the two ways in: the form on the unsubscribe page
 * (app/api/public/newsletter/unsubscribe) and the RFC 8058 one-click POST from a mail client
 * (app/api/public/newsletter/one-click). One implementation, so the two cannot drift on the details that
 * matter — that the row is KEPT as a suppression record, that the confirmation nonce is cleared, and that
 * the guarded update lets exactly one of two simultaneous clicks own the transition.
 *
 * The reasoning behind each of those is set out in the unsubscribe route's header; it is not repeated here.
 */

export type UnsubscribeOutcome =
  /** No row for that address, or an erased one. The reader's intent is already true. */
  | "not-found"
  /** It was already UNSUBSCRIBED, or another request made the change a moment earlier. */
  | "already"
  /** This call moved it to UNSUBSCRIBED. */
  | "unsubscribed";

export async function unsubscribeAddress(
  emailKey: string,
  options: {
    /**
     * Send the "you have been unsubscribed" receipt on a CONFIRMED → UNSUBSCRIBED transition.
     *
     * True for the page, where the reader pressed a button and a receipt answers "did it work?". FALSE
     * for one-click: the mail client already shows its own confirmation, and a message arriving straight
     * after the reader pressed "Unsubscribe" in their inbox reads as the sender ignoring them.
     */
    receipt: boolean;
  }
): Promise<UnsubscribeOutcome> {
  const row = await prisma.newsletterSubscriber.findUnique({
    where: { emailKey },
    select: { id: true, email: true, status: true, deletedAt: true }
  });

  if (!row || row.deletedAt !== null) return "not-found";
  if (row.status === "UNSUBSCRIBED") return "already";

  const changed = await prisma.newsletterSubscriber.updateMany({
    where: { id: row.id, status: { in: ["PENDING", "CONFIRMED"] }, deletedAt: null },
    data: {
      status: "UNSUBSCRIBED",
      unsubscribedAt: new Date(),
      // ⚠ Security-relevant: an unspent confirmation link must not be able to put them back.
      confirmationToken: null,
      confirmationExpiresAt: null
    }
  });

  if (changed.count === 0) return "already";

  /**
   * Anything still queued for this address is now addressed to somebody who asked to stop. The drain
   * would suppress each row when it reached it; doing it here means the studio's counts say so at once.
   */
  await prisma.newsletterDelivery.updateMany({
    where: { subscriberId: row.id, state: "RECORDED", kind: { in: ["ISSUE", "WELCOME", "ALREADY_SUBSCRIBED"] } },
    data: { state: "SUPPRESSED", error: "The subscriber unsubscribed before this was sent." }
  });

  if (options.receipt && row.status === "CONFIRMED") {
    await sendUnsubscribeReceipt({ to: row.email, emailKey, subscriberId: row.id });
  }

  return "unsubscribed";
}
