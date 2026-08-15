import type { NextRequest } from "next/server";
import { z } from "zod";

import { assertSameOrigin, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { sendUnsubscribeReceipt } from "@/lib/newsletter/delivery";
import {
  NEWSLETTER_RATE_LIMITS,
  enforceNewsletterRateLimit,
  newsletterWantsJson,
  readNewsletterBody,
  refuse,
  succeed
} from "@/lib/newsletter/http";
import { NEWSLETTER_UNSUBSCRIBE_PATH } from "@/lib/newsletter/paths";
import { NEWSLETTER_TOKEN_QUERY_KEY, verifyNewsletterToken } from "@/lib/newsletter/tokens";

/**
 * Stop the newsletter.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ██  THIS IS THE MOST IMPORTANT ROUTE IN THE FEATURE, AND IT IS THE ONE THAT MUST NEVER REFUSE.  ██
 *
 * Every other newsletter endpoint can afford to be strict. This one cannot. The reader's conclusion when
 * an unsubscribe link does not work is not "there is a bug on this website" — it is "this institution
 * will not let me stop", and their next action is a spam report or a complaint to a regulator. That is
 * why nearly every decision here differs from the confirm route's, in the direction of letting somebody
 * out:
 *
 *   • **The token never expires.** `unsubscribe` tokens carry no expiry and no nonce; they are derived
 *     from the address alone, so the same address always has the same link and a message dug out of a
 *     three-year-old archive still works. lib/newsletter/tokens.ts sets out the trade: the worst case for
 *     a leaked unsubscribe link is that somebody stops receiving something they can sign up for again in
 *     ten seconds, and the worst case for an expired one is a person who cannot make the mail stop.
 *   • **The rate limit is the loosest of the three** (`NEWSLETTER_RATE_LIMITS.unsubscribe`). A shared
 *     office behind one address, six colleagues unsubscribing in an afternoon, must not hit a wall.
 *   • **Unsubscribing twice is a success, not an error.** So is unsubscribing an address that was only
 *     ever PENDING. The reader's intent — "do not send me this" — is satisfied in every one of those
 *     cases, and the only honest answer is to say so.
 *   • **An address that is not on the list is answered kindly, not with a bare 404 sentence.** See the
 *     message below: somebody standing in front of "not found" after clicking "unsubscribe" reasonably
 *     concludes the link is broken and that the mail will keep coming.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ WHY THIS IS STILL A POST, WHEN A ONE-CLICK LINK WOULD BE EASIER ══
 *
 * The same reason the confirmation is (tokens.ts): mail gateways and "safe links" scanners fetch every
 * URL in every message before a person sees it, and an unsubscribe that mutated on GET would be
 * "clicked" by a security appliance — silently unsubscribing readers who never asked to leave, which is
 * a data-loss bug wearing the costume of a privacy feature. So the emailed link lands on a page that
 * names the address and offers a real form, and this handler answers the form.
 *
 * ⚠ THE DOOR IS DELIBERATELY LEFT OPEN FOR RFC 8058 ONE-CLICK. `assertSameOrigin` allows a request with
 * NO `Origin` header (lib/api.ts explains why), and a mail client performing a `List-Unsubscribe-Post`
 * sends none — so this handler already answers that shape of request correctly. What is NOT built is the
 * header on the outgoing message, which belongs to whichever provider adapter is chosen; obligation 5 in
 * the header of lib/newsletter/delivery.ts spells out exactly what it must send.
 *
 * ══ WHAT THE WRITE DOES, AND THE ONE THING IT DELIBERATELY DOES NOT DO ══
 *
 * The row is set to UNSUBSCRIBED and KEPT. It is not deleted, and that is the entire point of it: schema
 * fact 2 calls it a SUPPRESSION RECORD — the evidence that this address asked to be left alone, so that a
 * later import, or a sign-up form filled in by somebody else, cannot quietly put them back. Deleting the
 * row would destroy the only thing standing between this person and a second unwanted subscription.
 *
 * ⚠ AND THE RECEIPT IS SENT ONLY ON A **CONFIRMED → UNSUBSCRIBED** TRANSITION. A PENDING address was
 * never subscribed to anything: the schema says a PENDING subscriber is "NEVER mailed anything except the
 * confirmation itself", and mailing an unconfirmed address a receipt — however well meant — would break
 * that rule and send unsolicited mail to somebody who has just told us to stop. The page still confirms
 * the outcome on screen, which is where a reader who is standing right there actually wants it.
 */

export const dynamic = "force-dynamic";

const BASE_PATH = NEWSLETTER_UNSUBSCRIBE_PATH;

/**
 * ⚠ The same constant the emailed link and the page's hidden input use. See the confirm route.
 *
 * ⚠ `.default("")`, NOT `.optional().default("")` — see the note in the sign-up route's schema.
 */
const UnsubscribeBody = z.object({
  [NEWSLETTER_TOKEN_QUERY_KEY]: z.string().trim().max(2048).default("")
});

const UNSUBSCRIBED_MESSAGE =
  "That address has been removed from the newsletter. Nothing further will be sent to it. The Centre " +
  "keeps a note that you asked to stop — and nothing else — so that a later import cannot put you back " +
  "on the list by accident.";

/**
 * ⚠ THE SENTENCE FOR AN ADDRESS THAT IS NOT ON THE LIST, AND WHY IT IS PHRASED AS REASSURANCE.
 *
 * This is reached when the token is perfectly valid but no row exists — a subscriber whose record was
 * erased, or a link for an address that was never confirmed and has since been cleaned up. The reader has
 * clicked "unsubscribe" and is owed the outcome they wanted, which is "you will not be sent this". Saying
 * "not found" and stopping would leave them believing the link failed.
 */
const NOT_ON_LIST_MESSAGE =
  "That address is not on the newsletter list, so there was nothing to remove — you will not be sent it. " +
  "If messages do keep arriving, they are not coming from this newsletter; forward one to the Centre " +
  "using the contact page and somebody will find out what is sending them.";

export const POST = route(async (request: NextRequest) => {
  const wantsJson = newsletterWantsJson(request);

  const limited = enforceNewsletterRateLimit({
    request,
    bucket: "newsletter-unsubscribe",
    policy: NEWSLETTER_RATE_LIMITS.unsubscribe,
    wantsJson,
    basePath: BASE_PATH,
    message: (phrase) =>
      `This has been used ${NEWSLETTER_RATE_LIMITS.unsubscribe.limit} times from your connection in the ` +
      `last few minutes, so it is paused for ${phrase}. If you have already unsubscribed, it worked — ` +
      "nothing more will be sent to that address."
  });
  if (limited) return limited;

  assertSameOrigin(request);

  const body = await readNewsletterBody(request, UnsubscribeBody, {
    basePath: BASE_PATH,
    state: "bad-link"
  });
  if (!body.ok) return body.response;

  /**
   * ⚠ THE PURPOSE `"unsubscribe"` IS PASSED IN, NOT READ FROM THE TOKEN. It is inside the signed message,
   * so a confirmation token presented here fails the signature check rather than being accepted as an
   * unsubscribe — which is the half of domain separation that actually does the work.
   */
  const verified = verifyNewsletterToken("unsubscribe", body.data[NEWSLETTER_TOKEN_QUERY_KEY]);

  if (!verified.ok) {
    /**
     * ⚠ ALL THREE REASONS COLLAPSE TO ONE ANSWER HERE, UNLIKE THE CONFIRM ROUTE.
     *
     * An unsubscribe token carries no expiry, so `"expired"` is unreachable by construction — and writing
     * a separate branch for it would be a sentence about a deadline that does not exist, which is the kind
     * of comment-that-contradicts-the-code this repository has been bitten by three times. Malformed and
     * forged are collapsed for the confirm route's reason: the useful thing to tell a reader is how to get
     * out anyway, and telling a forger which attempt failed how is free tuning information.
     *
     * ⚠ THE SENTENCE MUST GIVE THEM ANOTHER WAY OUT. This is the one refusal in the feature where the
     * reader is trying to leave, so it names the two things that still work: the newest message's own
     * link, and writing to the Centre. A refusal with no route forward is what turns a broken link into a
     * spam report.
     */
    return refuse({
      wantsJson,
      status: 422,
      code: "token_invalid",
      message:
        "That unsubscribe link could not be read — mail programmes sometimes break a long link across " +
        "two lines. Copying the whole address out of the message and pasting it into your browser " +
        "usually fixes it. Failing that, the link at the foot of any newer message will also work, or " +
        "write to the Centre using the contact page and your address will be removed by hand.",
      basePath: BASE_PATH,
      state: "bad-link"
    });
  }

  const row = await prisma.newsletterSubscriber.findUnique({
    where: { emailKey: verified.emailKey },
    select: { id: true, email: true, status: true, deletedAt: true }
  });

  /**
   * No row, or an erased one. Answered as a SUCCESS state rather than an error.
   *
   * ⚠ `state: "not-found"` still redirects the browser to the unsubscribe page, which renders this as a
   * reassuring outcome rather than as a failure — the wording is `NOT_ON_LIST_MESSAGE` and it is the same
   * sentence on both paths. The status is 200, not 404: there is nothing wrong with this request, and a
   * 4xx would make a monitoring dashboard report a working unsubscribe as an error.
   */
  if (!row || row.deletedAt !== null) {
    return succeed({
      wantsJson,
      json: { unsubscribed: true, message: NOT_ON_LIST_MESSAGE },
      basePath: BASE_PATH,
      state: "not-found"
    });
  }

  // Already done. Idempotent, and a success — see the header.
  if (row.status === "UNSUBSCRIBED") {
    return succeed({
      wantsJson,
      json: { unsubscribed: true, message: UNSUBSCRIBED_MESSAGE },
      basePath: BASE_PATH,
      state: "unsubscribed"
    });
  }

  /**
   * ⚠ GUARDED, SO THE RECEIPT CANNOT BE SENT TWICE, AND SO ONLY ONE REQUEST OWNS THE TRANSITION.
   *
   * `status: { in: ["PENDING", "CONFIRMED"] }` repeats what was just read. Two clicks arriving together
   * would otherwise both see a CONFIRMED row and both send a receipt — two "you have been unsubscribed"
   * messages to somebody who has just asked for silence, which is a small insult and an entirely
   * avoidable one.
   */
  const changed = await prisma.newsletterSubscriber.updateMany({
    where: { id: row.id, status: { in: ["PENDING", "CONFIRMED"] }, deletedAt: null },
    data: {
      status: "UNSUBSCRIBED",
      unsubscribedAt: new Date(),
      /**
       * ⚠ CLEARING THE CONFIRMATION NONCE IS A SECURITY-RELEVANT PART OF THIS WRITE, NOT TIDYING.
       *
       * An unspent confirmation link may still be sitting in this person's inbox. Left alone, it would
       * remain a way to put them BACK on the list after they asked to leave — and the confirm route's
       * nonce check is what refuses it, precisely because there is nothing left here to match. Deleting
       * these two lines would silently reopen that hole with nothing on screen or in a type to show it.
       */
      confirmationToken: null,
      confirmationExpiresAt: null
    }
  });

  /**
   * The receipt: CONFIRMED → UNSUBSCRIBED only, and only for the request that won the guard.
   *
   * `row.status` is the status read BEFORE the update, which is the one that decides this. A PENDING
   * address was never subscribed and must not be mailed — see the header.
   */
  if (changed.count === 1 && row.status === "CONFIRMED") {
    await sendUnsubscribeReceipt({
      to: row.email,
      emailKey: verified.emailKey,
      subscriberId: row.id
    });
  }

  /**
   * ⚠ SUCCESS EVEN WHEN `count` IS 0.
   *
   * Zero means somebody else's request made the same change a moment earlier — the row IS UNSUBSCRIBED,
   * which is exactly what this reader asked for. Refusing here would be reporting a failure for an
   * outcome that was achieved. There is no branch in which this route tells a person who wanted out that
   * they are still on the list.
   */
  return succeed({
    wantsJson,
    json: { unsubscribed: true, message: UNSUBSCRIBED_MESSAGE },
    basePath: BASE_PATH,
    state: "unsubscribed"
  });
});
