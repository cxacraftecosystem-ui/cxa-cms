import type { NextRequest } from "next/server";
import { z } from "zod";

import { assertSameOrigin, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { sendWelcomeEmail } from "@/lib/newsletter/delivery";
import {
  NEWSLETTER_RATE_LIMITS,
  enforceNewsletterRateLimit,
  newsletterWantsJson,
  readNewsletterBody,
  refuse,
  succeed
} from "@/lib/newsletter/http";
import { NEWSLETTER_CONFIRM_PATH } from "@/lib/newsletter/paths";
import {
  NEWSLETTER_TOKEN_QUERY_KEY,
  confirmationNonceMatches,
  verifyNewsletterToken
} from "@/lib/newsletter/tokens";

/**
 * Confirm a subscription — the second half of the double opt-in, and the only thing in this application
 * that can put an address on the mailing list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A **POST**, WHEN THE READER GOT HERE BY CLICKING A LINK IN AN EMAIL.
 *
 * The link in the message points at a PAGE (`NEWSLETTER_CONFIRM_PATH`), and that page shows a button
 * which posts here. The extra click is not friction anybody failed to remove; the header of
 * lib/newsletter/tokens.ts sets out the reason at length and it is worth restating where the mutation
 * actually happens:
 *
 *     A link in an email is fetched by things that are not the recipient. Corporate mail gateways,
 *     "safe links" rewriters and antivirus scanners follow every URL in every message BEFORE a person
 *     sees it. If confirming were a GET, a security appliance would confirm the subscription, and the
 *     double opt-in — the entire legal basis for sending anything — would silently become a single
 *     opt-in that nobody could detect from the data.
 *
 * No scanner performs a POST, so the click that reaches this handler is a person's.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ THE ORDER OF THE FOUR CHECKS IS LOAD-BEARING ══
 *
 *   1. **The signature**, inside `verifyNewsletterToken`, with the purpose `"confirm"` passed in by this
 *      route and NOT read out of the token. A verifier that took the purpose from the token would accept
 *      an unsubscribe token here, which is the confused-deputy version of having no domain separation.
 *      This costs no database query, so every forgery is refused before a connection is used.
 *   2. **The expiry inside the signed payload** — also inside `verifyNewsletterToken`, and checked AFTER
 *      the signature, because the expiry is a number the holder of a forged token would otherwise get to
 *      choose.
 *   3. **The nonce against the row.** This is what makes the link SINGLE USE and what makes an older
 *      link die the moment a newer one is issued.
 *   4. **The row's own `confirmationExpiresAt`.** ⚠ NOT redundant with check 2. The signed expiry proves
 *      what was issued; the column proves what is still on offer. They are written from one pair of
 *      values (`newConfirmationChallenge`) so they normally agree — but if a row is ever touched by hand,
 *      by a repair script or by a future re-issue path that forgets one of them, the pair disagreeing must
 *      resolve to "refused", never to "accepted". The schema says the expiry is enforced in both places
 *      for exactly this reason.
 *
 * ══ AND THE FIFTH CHECK IS THE WRITE ITSELF ══
 *
 * The promotion is an `updateMany` whose `where` REPEATS the status and the nonce. Two clicks arriving at
 * the same millisecond — a double-tap, a mail client that pre-fetches and then submits, a reader on a slow
 * connection pressing the button twice — would otherwise both read a PENDING row and both proceed, and the
 * second would send a second welcome email. The guarded update makes the database the arbiter: exactly one
 * of them sees `count === 1` and sends the welcome; the other sees `0`, re-reads, finds CONFIRMED, and says
 * "already confirmed", which is the truth.
 *
 * ⚠ AN ALREADY-CONFIRMED SUBSCRIPTION IS A **SUCCESS**, NOT AN ERROR. A reader who clicks the link twice,
 * or who opens it again a week later to check it worked, has done nothing wrong and their subscription is
 * exactly as they want it. Answering 4xx would tell them something is broken when nothing is.
 */

export const dynamic = "force-dynamic";

const BASE_PATH = NEWSLETTER_CONFIRM_PATH;

/**
 * ⚠ THE FIELD NAME IS THE SAME CONSTANT THE LINK BUILDER USES.
 *
 * `NEWSLETTER_TOKEN_QUERY_KEY` names the query parameter the emailed link carries; the confirm page
 * copies that value into a hidden input of the same name and posts it here. Sharing the one constant is
 * what stops the page and this handler drifting to `token` and `t` — a mismatch that would look exactly
 * like every link being invalid, with nothing on screen or in a log to say why.
 *
 * ⚠ `.default("")`, NOT `.optional().default("")` — the latter leaves `undefined` in the OUTPUT type even
 * though it can never occur at runtime. See the note in the sign-up route's schema.
 */
const ConfirmBody = z.object({
  [NEWSLETTER_TOKEN_QUERY_KEY]: z.string().trim().max(2048).default("")
});

/** The sentence for a link that cannot be read at all — mangled, truncated, or forged. */
const BAD_LINK_MESSAGE =
  "That confirmation link could not be read. Mail programmes sometimes break a long link across two " +
  "lines, so copying the whole address from the message and pasting it into your browser often fixes it. " +
  "If it still will not work, sign up again and a fresh link will be sent — nothing has been lost.";

export const POST = route(async (request: NextRequest) => {
  const wantsJson = newsletterWantsJson(request);

  const limited = enforceNewsletterRateLimit({
    request,
    // ⚠ Its own bucket. A namespace shared with the sign-up form would let one abused endpoint disable
    // the other, and being unable to CONFIRM is the more damaging of the two: the reader has already done
    // everything asked of them.
    bucket: "newsletter-confirm",
    policy: NEWSLETTER_RATE_LIMITS.confirm,
    wantsJson,
    basePath: BASE_PATH,
    message: (phrase) =>
      `This link has been used ${NEWSLETTER_RATE_LIMITS.confirm.limit} times from your connection in the ` +
      `last few minutes, so it is paused. Try again in ${phrase} — your subscription is unaffected.`
  });
  if (limited) return limited;

  assertSameOrigin(request);

  const body = await readNewsletterBody(request, ConfirmBody, {
    basePath: BASE_PATH,
    state: "bad-link"
  });
  if (!body.ok) return body.response;

  // ── Checks 1 and 2: the token itself ──────────────────────────────────────

  const verified = verifyNewsletterToken("confirm", body.data[NEWSLETTER_TOKEN_QUERY_KEY]);

  if (!verified.ok) {
    /**
     * ⚠ THREE REASONS, TWO ANSWERS, AND THE COLLAPSE IS DELIBERATE.
     *
     * `verifyNewsletterToken` distinguishes "malformed", "forged" and "expired" because they need
     * different sentences — and the useful split for a READER is expired versus not, not malformed versus
     * forged. Telling somebody their link was FORGED when their mail client mangled it is both wrong and
     * insulting; telling an actual forger which of their attempts was malformed and which was merely
     * mis-signed is free information for tuning the next one. So both non-expiry failures become one
     * "we could not read that link, here is how to get a new one".
     */
    if (verified.reason === "expired") {
      return refuse({
        wantsJson,
        status: 410,
        code: "token_expired",
        message:
          "That confirmation link has expired, so nothing has been changed. Sign up again and a fresh " +
          "link will be sent — it takes a moment, and links are given a short life on purpose so that " +
          "one sitting in an old forwarded message cannot be used to subscribe somebody else.",
        basePath: BASE_PATH,
        state: "expired"
      });
    }

    return refuse({
      wantsJson,
      status: 422,
      code: "token_invalid",
      message: BAD_LINK_MESSAGE,
      basePath: BASE_PATH,
      state: "bad-link"
    });
  }

  // ── The row ───────────────────────────────────────────────────────────────

  const row = await prisma.newsletterSubscriber.findUnique({
    where: { emailKey: verified.emailKey },
    select: {
      id: true,
      email: true,
      status: true,
      confirmationToken: true,
      confirmationExpiresAt: true,
      deletedAt: true
    }
  });

  /**
   * ⚠ AN ERASED ROW (`deletedAt`) IS TREATED AS ABSENT, NOT AS CONFIRMABLE.
   *
   * Somebody asked to be forgotten. A link issued before that request must not quietly bring them back:
   * every other read path filters on `deletedAt`, and a confirmation that ignored it would produce a
   * CONFIRMED row invisible to the studio and to the export while being perfectly visible to a mailing.
   */
  if (!row || row.deletedAt !== null) {
    return refuse({
      wantsJson,
      status: 404,
      code: "not_found",
      message:
        "There is no sign-up waiting for that address, so there was nothing to confirm. If you would " +
        "like the newsletter, sign up again and a fresh confirmation link will be sent.",
      basePath: BASE_PATH,
      state: "not-found"
    });
  }

  // Idempotent, and a success. See the header.
  if (row.status === "CONFIRMED") {
    return alreadyConfirmed(wantsJson);
  }

  // ── Check 3: the nonce ────────────────────────────────────────────────────

  /**
   * ⚠ THIS IS ALSO WHAT REFUSES A CONFIRM LINK HELD BY SOMEBODY WHO HAS UNSUBSCRIBED.
   *
   * The unsubscribe route CLEARS `confirmationToken`, so an UNSUBSCRIBED row has no nonce and
   * `confirmationNonceMatches(null, …)` is false by construction. That is deliberate and it is the whole
   * mechanism: an outstanding confirmation link must not be able to re-subscribe somebody who has since
   * asked to be left alone. There is no separate status check here for that case, because a status check
   * could be forgotten and this one cannot — the row simply has nothing to match against.
   */
  if (!confirmationNonceMatches(row.confirmationToken, verified.nonce)) {
    return refuse({
      wantsJson,
      status: 409,
      code: "token_superseded",
      message:
        "That confirmation link is no longer the current one — a newer one has been sent, or this " +
        "address has since been unsubscribed. Nothing has been changed. Open the most recent " +
        "confirmation email, or sign up again to be sent a fresh link.",
      basePath: BASE_PATH,
      state: "bad-link"
    });
  }

  // ── Check 4: the row's own deadline ───────────────────────────────────────

  if (row.confirmationExpiresAt && row.confirmationExpiresAt.getTime() < Date.now()) {
    return refuse({
      wantsJson,
      status: 410,
      code: "token_expired",
      message:
        "That confirmation link has expired, so nothing has been changed. Sign up again and a fresh " +
        "link will be sent.",
      basePath: BASE_PATH,
      state: "expired"
    });
  }

  // ── Check 5: the write, guarded ───────────────────────────────────────────

  const promoted = await prisma.newsletterSubscriber.updateMany({
    /**
     * ⚠ THE `where` REPEATS WHAT WAS JUST CHECKED, ON PURPOSE. Between the read above and this write, a
     * second request can confirm the same row. Repeating `status` and `confirmationToken` here makes the
     * database decide which of the two wins, rather than both believing they did — see the header.
     */
    where: { id: row.id, status: "PENDING", confirmationToken: verified.nonce, deletedAt: null },
    data: {
      status: "CONFIRMED",
      confirmedAt: new Date(),
      /**
       * ⚠ THE NONCE IS CLEARED, WHICH IS WHAT SPENDS THE LINK.
       *
       * Without this the same link would confirm for ever — harmless while the subscription stands, and
       * not harmless after an unsubscribe, when it would become a way to put somebody back on the list
       * from a message in their archive.
       */
      confirmationToken: null,
      confirmationExpiresAt: null
    }
  });

  if (promoted.count === 0) {
    /**
     * Somebody else got there first, or the row changed underneath us. Re-read rather than guess: the
     * overwhelmingly likely truth is that it is now CONFIRMED, and telling that reader "your link is
     * invalid" when their subscription is live would be the worst available answer.
     */
    const after = await prisma.newsletterSubscriber.findUnique({
      where: { id: row.id },
      select: { status: true, deletedAt: true }
    });

    if (after && after.status === "CONFIRMED" && after.deletedAt === null) {
      return alreadyConfirmed(wantsJson);
    }

    return refuse({
      wantsJson,
      status: 409,
      code: "token_superseded",
      message:
        "That confirmation could not be completed because the sign-up changed while it was being " +
        "processed. Nothing has been half-done. Sign up again and a fresh link will be sent.",
      basePath: BASE_PATH,
      state: "bad-link"
    });
  }

  /**
   * The welcome, sent exactly once — only the request that won the guarded update reaches this line.
   *
   * ⚠ AFTER the write, never before. A welcome that went out first and then failed to commit would tell
   * somebody they are subscribed when they are not, and it carries their unsubscribe link, which would
   * then be the only trace of a subscription that does not exist.
   */
  await sendWelcomeEmail({ to: row.email, emailKey: verified.emailKey, subscriberId: row.id });

  return succeed({
    wantsJson,
    json: { confirmed: true, message: CONFIRMED_MESSAGE },
    basePath: BASE_PATH,
    state: "confirmed"
  });
});

const CONFIRMED_MESSAGE =
  "Your subscription is confirmed. This address will receive the newsletter from the next issue onwards, " +
  "and every message carries a link that stops them again in one click.";

/**
 * The answer for a subscription that was already live.
 *
 * A function rather than two copies, because it is returned from two places — the fast path and the loser
 * of the race — and those two must say the same thing. Two literals here would be two chances for one of
 * them to be reworded and the other forgotten, and a reader cannot tell which path they took.
 */
function alreadyConfirmed(wantsJson: boolean) {
  return succeed({
    wantsJson,
    json: { confirmed: true, message: ALREADY_CONFIRMED_MESSAGE },
    basePath: BASE_PATH,
    state: "already-confirmed"
  });
}

const ALREADY_CONFIRMED_MESSAGE =
  "That address is already confirmed, so there was nothing left to do — you are subscribed and no second " +
  "subscription has been created. This is what you should see if you open the confirmation link twice.";
