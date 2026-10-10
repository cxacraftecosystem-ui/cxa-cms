import "server-only";

import type { NewsletterMailKind } from "@prisma/client";

import { prisma } from "@/lib/db";
import { sesConfigured, sesEnv, siteName, siteUrl } from "@/lib/env";
import type { MailHeader } from "@/lib/newsletter/list-unsubscribe";
import { listUnsubscribeHeaders } from "@/lib/newsletter/list-unsubscribe";
import { describeSendError, dispositionOf } from "@/lib/newsletter/mail-errors";
import { createSesMailer } from "@/lib/newsletter/mailer-ses";
import {
  createClaimedRow,
  markAttemptFailed,
  markSent,
  newClaimToken
} from "@/lib/newsletter/outbox-store";
import { NEWSLETTER_PATH } from "@/lib/newsletter/paths";
import {
  confirmationExpiryFrom,
  newConfirmationNonce,
  newsletterConfirmUrl,
  oneClickUnsubscribeUrlFor,
  signNewsletterToken,
  unsubscribeUrlFor,
  CONFIRMATION_TTL_HOURS
} from "@/lib/newsletter/tokens";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ██  THE DELIVERY SEAM.  EVERY NEWSLETTER MESSAGE IS COMPOSED HERE AND HANDED TO THE MAILER HERE.  ██
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ HOW A MESSAGE LEAVES ══
 *
 * The mailer is Amazon SES (lib/newsletter/mailer-ses.ts), registered from the environment — at start-up
 * by `instrumentation.ts`, and lazily by `activeNewsletterMailer()` for any process that serves a
 * request before that hook has run. With the SES variables absent (a laptop, CI, a preview) there is no
 * mailer, and every message is queued as a RECORDED row for the drain to send once there is one.
 *
 * There are two paths out, and they share every write:
 *
 *   • **Transactional mail** (confirmation, welcome, already-subscribed, unsubscribe receipt) is sent
 *     INLINE by the request that caused it, because a confirmation link is useless an hour late. The row
 *     is created already CLAIMED (`createClaimedRow`), so the drain cannot send it a second time. A
 *     throttled or 5xx attempt goes back to the queue with a backoff, and the drain finishes the job.
 *   • **Issues** are queued by lib/newsletter/issues.ts and sent by the drain (lib/newsletter/drain.ts),
 *     a bounded batch per invocation.
 *
 * ══ THE MAILER'S CONTRACT ══
 *
 *   1. **Throw on failure, as a `MailSendError` with a disposition** (lib/newsletter/mail-errors.ts).
 *      A resolved promise is recorded as SENT and is the only evidence anybody will have.
 *   2. **Send to `message.to`, not `message.emailKey`.** The key is folded for identity.
 *   3. **Include `message.actionUrl` verbatim.** No click tracking: a rewritten URL breaks the signature.
 *   4. **Send the headers it is given.** `List-Unsubscribe`/`List-Unsubscribe-Post` are on every message to
 *      a subscriber (welcome, already-subscribed, every issue) and NEVER on a confirmation, whose
 *      recipient is not subscribed to anything yet.
 *   5. **Never log a body or an address beyond `emailKey`.**
 *
 * ══ WHY THE ROW IS WRITTEN BEFORE THE SEND, ALWAYS ══
 *
 * A process killed mid-send leaves a SENDING row whose claim goes stale and is released to the queue —
 * "we do not know whether this was sent" becomes "it will be sent again", which is the honest recovery.
 * Writing the row after a successful send would lose that message entirely.
 *
 * ══ NOTHING HERE EVER THROWS INTO A REQUEST ══
 *
 * A person who successfully signed up must not be shown "something went wrong" because the provider had a
 * bad minute — their row exists, their consent is recorded, and the message is in the queue.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Everything a provider needs in order to send one message. Composed here; never assembled by a route. */
export interface NewsletterMessage {
  /** The envelope address — the capitals the person typed. ⚠ Not `emailKey`. */
  to: string;
  /** The normalised identity, for logging and for the unsubscribe links. */
  emailKey: string;
  /** Null for a studio test copy, or when the subscriber row has since been erased. */
  subscriberId: string | null;
  kind: NewsletterMailKind;
  subject: string;
  /** The complete message as plain text. Always present: it is the `text/plain` part of every message. */
  bodyText: string;
  /** The HTML part, for issues. Transactional messages are plain text only. */
  bodyHtml: string | null;
  /** Extra headers — the RFC 8058 pair, where the message carries it. */
  headers: MailHeader[];
  /** The single link the message exists to carry, or null for a message that carries none. */
  actionUrl: string | null;
}

/** What a provider says about a message it accepted. */
export interface SendResult {
  providerMessageId: string | null;
}

/** The provider's own limits, so the drain can pace itself. */
export interface SendQuota {
  maxPerSecond: number;
  /** Null when the account has no daily cap. */
  remainingToday: number | null;
  sendingEnabled: boolean;
}

/** What a provider adapter must be. */
export interface NewsletterMailer {
  /** A short name an administrator reads in the studio: "Amazon SES". */
  readonly name: string;
  /** ⚠ THROWS on failure. See the contract in the header. */
  send(message: NewsletterMessage): Promise<SendResult>;
  /** The current sending limits, or null when they cannot be read. */
  quota?(): Promise<SendQuota | null>;
}

interface MailerState {
  mailer: NewsletterMailer | null;
  /** True once the environment has been read, so a process without SES does not re-read it per message. */
  fromEnvChecked: boolean;
}

/**
 * On `globalThis`, for the reason lib/db.ts gives: the dev server re-evaluates modules on every hot reload,
 * and a module-scoped `let` would silently drop the mailer registered at start-up.
 */
const globalForMailer = globalThis as unknown as { __cxaNewsletterMailer?: MailerState };

const state: MailerState = globalForMailer.__cxaNewsletterMailer ?? { mailer: null, fromEnvChecked: false };
globalForMailer.__cxaNewsletterMailer = state;

/** Install a provider. Called once at start-up by `registerNewsletterMailerFromEnv`, and by the tests. */
export function setNewsletterMailer(mailer: NewsletterMailer | null): void {
  if (state.mailer && mailer && state.mailer !== mailer) {
    console.warn(
      `[newsletter] the mail provider was already set to "${state.mailer.name}" and has been replaced ` +
        `with "${mailer.name}".`
    );
  }
  state.mailer = mailer;
  state.fromEnvChecked = true;
  if (mailer) console.log(`[newsletter] mail provider set to "${mailer.name}".`);
}

/**
 * Register the SES mailer when its environment is set. Idempotent; called by `instrumentation.ts` at
 * start-up and, through `activeNewsletterMailer()`, by anything that needs a mailer before that ran.
 *
 * ⚠ A MALFORMED CONFIGURATION IS LOGGED AND LEAVES NO MAILER, rather than throwing: a throw here would take
 * down sign-up for a mistyped sender address. The messages queue, and the studio says sending is not set
 * up — which is the truth.
 */
export function registerNewsletterMailerFromEnv(): NewsletterMailer | null {
  if (state.mailer) return state.mailer;
  if (state.fromEnvChecked) return null;
  state.fromEnvChecked = true;
  if (!sesConfigured()) return null;
  try {
    state.mailer = createSesMailer(sesEnv());
    console.log(`[newsletter] mail provider set to "${state.mailer.name}".`);
  } catch (error) {
    console.error("[newsletter] the SES configuration could not be read, so nothing will be sent.", error);
    state.mailer = null;
  }
  return state.mailer;
}

/** The registered mailer, registering it from the environment on first use. */
export function activeNewsletterMailer(): NewsletterMailer | null {
  return state.mailer ?? registerNewsletterMailerFromEnv();
}

/**
 * What the studio reads to describe delivery. The name is for the studio only; a public page reads
 * `mailerConfigured()` and nothing else.
 */
export function newsletterMailerInfo(): { configured: boolean; name: string } {
  const mailer = activeNewsletterMailer();
  return mailer ? { configured: true, name: mailer.name } : { configured: false, name: "not set up" };
}

/** Whether this deployment can send email at all. The one fact a public page may learn. */
export function mailerConfigured(): boolean {
  return activeNewsletterMailer() !== null;
}

export type DeliveryOutcome = "sent" | "queued" | "failed" | "suppressed";

/**
 * May this message still be sent to this subscriber?
 *
 * A confirmation is always allowed — it is the explicit answer to somebody signing up again, which is how
 * a bounced or complaining address comes back. Everything else stops at a bounce or a complaint.
 */
async function suppressionReason(message: NewsletterMessage): Promise<string | null> {
  if (message.kind === "CONFIRMATION" || !message.subscriberId) return null;
  const row = await prisma.newsletterSubscriber.findUnique({
    where: { id: message.subscriberId },
    select: { bouncedAt: true, complainedAt: true, deletedAt: true }
  });
  if (!row || row.deletedAt) return "The subscriber record has been erased.";
  if (row.complainedAt) return "This address reported a previous message as spam.";
  if (row.bouncedAt) return "Mail to this address bounced permanently.";
  return null;
}

/**
 * Hand one composed message to the mailer, with the outbox row written first.
 *
 * Exported for the drain's replay and the studio's test send; routes call the `send…` functions below,
 * which compose the wording. NEVER THROWS.
 */
export async function deliverNewsletterMail(
  message: NewsletterMessage,
  options: { issueId?: string | null } = {}
): Promise<DeliveryOutcome> {
  try {
    const suppressed = await suppressionReason(message);
    if (suppressed) {
      await prisma.newsletterDelivery.create({
        data: {
          subscriberId: message.subscriberId,
          emailKey: message.emailKey,
          kind: message.kind,
          subject: message.subject,
          issueId: options.issueId ?? null,
          state: "SUPPRESSED",
          error: suppressed
        }
      });
      return "suppressed";
    }

    const mailer = activeNewsletterMailer();
    if (!mailer) {
      await prisma.newsletterDelivery.create({
        data: {
          subscriberId: message.subscriberId,
          emailKey: message.emailKey,
          kind: message.kind,
          subject: message.subject,
          issueId: options.issueId ?? null,
          state: "RECORDED"
        }
      });
      return "queued";
    }

    const token = newClaimToken();
    const row = await createClaimedRow({
      subscriberId: message.subscriberId,
      emailKey: message.emailKey,
      kind: message.kind,
      subject: message.subject,
      issueId: options.issueId ?? null,
      token
    });
    const outcome = await sendClaimed(mailer, message, { id: row.id, token, attempts: row.attempts });
    return outcome === "halted" ? "queued" : outcome;
  } catch (error) {
    console.error(
      `[newsletter] a ${message.kind} message to ${message.emailKey} could not be queued or sent.`,
      error
    );
    return "failed";
  }
}

/**
 * Send a message whose row this caller has claimed, and settle the row. Shared with the drain.
 *
 * Returns "queued" when the attempt failed but the row went back to the queue (throttling, a 5xx), and
 * "halted" when the provider refused the account or the sender — the drain stops its batch on that.
 */
export async function sendClaimed(
  mailer: NewsletterMailer,
  message: NewsletterMessage,
  claim: { id: string; token: string; attempts: number }
): Promise<DeliveryOutcome | "halted"> {
  try {
    const result = await mailer.send(message);
    await markSent(claim.id, claim.token, mailer.name, result.providerMessageId);
    return "sent";
  } catch (error) {
    const disposition = dispositionOf(error);
    const description = describeSendError(error);
    console.error(
      `[newsletter] "${mailer.name}" did not accept a ${message.kind} message to ${message.emailKey} ` +
        `(${disposition}): ${description}`
    );
    const settled = await markAttemptFailed({
      id: claim.id,
      token: claim.token,
      provider: mailer.name,
      attempts: claim.attempts,
      disposition,
      error: description
    }).catch((nested: unknown) => {
      console.error("[newsletter] the failed delivery could not be settled.", nested);
      return null;
    });
    if (settled === "FAILED") return "failed";
    return disposition === "halt" ? "halted" : "queued";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The four transactional messages
//
// Composed here rather than in the routes, so the wording of what a person receives is in one file and
// cannot drift between the sign-up path, the re-issue path and the drain's replay. Every body is plain
// text, written in complete sentences, and every one says what will happen if the reader does nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** The footer every message carries. Says where it came from, so nothing arrives unattributed. */
function signature(): string {
  return `\n\n— ${siteName()}\n${siteUrl()}`;
}

interface Recipient {
  to: string;
  emailKey: string;
  subscriberId: string;
}

export interface ConfirmationRequest extends Recipient {
  /** The nonce stored on the row. The link is signed over it, which is what makes it single use. */
  nonce: string;
  /** The row's `confirmationExpiresAt`, so the body and the token cannot quote different deadlines. */
  expiresAt: Date;
}

/**
 * The double opt-in message. The ONLY thing a PENDING subscriber is ever sent.
 *
 * ⚠ ITS BODY MUST TELL SOMEBODY WHO DID NOT SIGN UP WHAT TO DO, and the answer is "nothing". A
 * confirmation that does not say "if this was not you, ignore it" reads as spam and gets reported as spam.
 *
 * ⚠ NO List-Unsubscribe HEADER: the recipient is not subscribed to anything yet.
 */
export function composeConfirmation(request: ConfirmationRequest): NewsletterMessage {
  const token = signNewsletterToken({
    purpose: "confirm",
    emailKey: request.emailKey,
    nonce: request.nonce,
    expiresAt: request.expiresAt
  });
  const actionUrl = newsletterConfirmUrl(token);

  return {
    to: request.to,
    emailKey: request.emailKey,
    subscriberId: request.subscriberId,
    kind: "CONFIRMATION",
    subject: `Confirm your newsletter subscription — ${siteName()}`,
    actionUrl,
    bodyHtml: null,
    headers: [],
    bodyText:
      `Somebody — we hope you — asked for the ${siteName()} newsletter to be sent to this address.\n\n` +
      "Open this link to confirm it. Nothing will be sent to you until you do:\n\n" +
      `${actionUrl}\n\n` +
      `The link works for ${CONFIRMATION_TTL_HOURS} hours. After that it stops working and you can simply ` +
      "sign up again.\n\n" +
      "If this was not you, do nothing at all. Without that click no newsletter is ever sent to this " +
      "address, and the incomplete record is removed in due course. You do not need to reply." +
      signature()
  };
}

export async function sendConfirmationEmail(request: ConfirmationRequest): Promise<void> {
  await deliverNewsletterMail(composeConfirmation(request));
}

/**
 * The answer to a repeat sign-up for an address that is already confirmed.
 *
 * The sign-up route answers IDENTICALLY for every address, so the fact that this one is already known goes
 * to the one place only its owner can read: their inbox.
 */
export function composeAlreadySubscribed(request: Recipient): NewsletterMessage {
  const unsubscribeUrl = unsubscribeUrlFor(request.emailKey);
  return {
    to: request.to,
    emailKey: request.emailKey,
    subscriberId: request.subscriberId,
    kind: "ALREADY_SUBSCRIBED",
    subject: `You are already subscribed — ${siteName()}`,
    actionUrl: unsubscribeUrl,
    bodyHtml: null,
    headers: listUnsubscribeHeaders(oneClickUnsubscribeUrlFor(request.emailKey)),
    bodyText:
      `Somebody just signed this address up for the ${siteName()} newsletter, but it is already ` +
      "subscribed — so nothing has changed and you will not receive it twice.\n\n" +
      "If you would rather stop receiving it, this link does that immediately and needs no account:\n\n" +
      `${unsubscribeUrl}\n\n` +
      "If it was not you who signed up, there is nothing to do: no new subscription was created." +
      signature()
  };
}

export async function sendAlreadySubscribedEmail(request: Recipient): Promise<void> {
  await deliverNewsletterMail(composeAlreadySubscribed(request));
}

/** Sent once, after a confirmation succeeds, so the first thing that arrives is not silence. */
export function composeWelcome(request: Recipient): NewsletterMessage {
  const unsubscribeUrl = unsubscribeUrlFor(request.emailKey);
  return {
    to: request.to,
    emailKey: request.emailKey,
    subscriberId: request.subscriberId,
    kind: "WELCOME",
    subject: `Your subscription is confirmed — ${siteName()}`,
    actionUrl: unsubscribeUrl,
    bodyHtml: null,
    headers: listUnsubscribeHeaders(oneClickUnsubscribeUrlFor(request.emailKey)),
    bodyText:
      `Your subscription to the ${siteName()} newsletter is confirmed. This address will receive it ` +
      "from the next issue onwards, and nothing else — it is not used for anything else and it is not " +
      "passed to anybody.\n\n" +
      "Every message, including this one, carries a link that stops them:\n\n" +
      `${unsubscribeUrl}\n\n` +
      "Keep it: it works without signing in to anything, and it does not expire." +
      signature()
  };
}

export async function sendWelcomeEmail(request: Recipient): Promise<void> {
  await deliverNewsletterMail(composeWelcome(request));
}

/**
 * Confirms an unsubscribe took effect.
 *
 * ⚠ THE ONE MESSAGE SENT TO SOMEBODY WHO HAS JUST ASKED TO BE LEFT ALONE, defensible only because it is
 * the receipt for an action they took a second ago. It says explicitly that it is the last one, and it
 * carries no List-Unsubscribe header: there is nothing left to stop.
 */
export function composeUnsubscribeReceipt(request: Recipient): NewsletterMessage {
  return {
    to: request.to,
    emailKey: request.emailKey,
    subscriberId: request.subscriberId,
    kind: "UNSUBSCRIBE_RECEIPT",
    subject: `You have been unsubscribed — ${siteName()}`,
    actionUrl: null,
    bodyHtml: null,
    headers: [],
    bodyText:
      `This address has been removed from the ${siteName()} newsletter. This is the last message you ` +
      "will receive from it.\n\n" +
      "We keep a record that you asked to stop, and nothing else, so that a later import or a form " +
      "filled in by somebody else cannot quietly put you back on the list. If you ever want the " +
      `newsletter again, sign up at ${siteUrl()}${NEWSLETTER_PATH}.` +
      signature()
  };
}

export async function sendUnsubscribeReceipt(request: Recipient): Promise<void> {
  await deliverNewsletterMail(composeUnsubscribeReceipt(request));
}

/**
 * A fresh confirmation nonce and its expiry, as one object, so the row's columns and the link's signed
 * payload are always produced from the same pair of values.
 */
export function newConfirmationChallenge(now: Date = new Date()): {
  nonce: string;
  expiresAt: Date;
} {
  return { nonce: newConfirmationNonce(), expiresAt: confirmationExpiryFrom(now) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay: the drain re-composing a queued transactional message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How old a queued transactional message may be and still be worth sending.
 *
 * A confirmation is still the answer to a real request a month later (it was queued because nothing could
 * send it); "you are already subscribed" or "you have been unsubscribed" a week late only confuses.
 */
const REPLAY_MAX_AGE_MS: Record<"CONFIRMATION" | "WELCOME" | "ALREADY_SUBSCRIBED" | "UNSUBSCRIBE_RECEIPT", number> = {
  CONFIRMATION: 30 * 24 * 60 * 60 * 1000,
  WELCOME: 7 * 24 * 60 * 60 * 1000,
  ALREADY_SUBSCRIBED: 3 * 24 * 60 * 60 * 1000,
  UNSUBSCRIBE_RECEIPT: 3 * 24 * 60 * 60 * 1000
};

/**
 * The message a queued transactional row stands for, rebuilt from the subscriber as it is NOW — or the
 * reason it must not be sent.
 *
 * ⚠ THE ROW HOLDS NO LINK AND NO BODY (the schema says why), so this is the only way a queued message can
 * be sent at all. And it is re-checked against the subscriber's current status, because a lot can change
 * while a message waits: a confirmation for somebody who has since confirmed, or a welcome for somebody
 * who has since left, must not go out.
 *
 * A confirmation whose nonce has expired or been cleared is given a FRESH challenge (guarded on the row
 * still being PENDING), so the link the reader receives works for the full window from the moment it is
 * actually sent.
 */
export async function recomposeTransactional(row: {
  kind: NewsletterMailKind;
  subscriberId: string | null;
  createdAt: Date;
}): Promise<{ message: NewsletterMessage } | { suppress: string }> {
  if (row.kind === "ISSUE" || row.kind === "ISSUE_TEST") {
    return { suppress: "Not a transactional message." };
  }
  if (Date.now() - row.createdAt.getTime() > REPLAY_MAX_AGE_MS[row.kind]) {
    return { suppress: "Queued too long ago to still be useful, so it was not sent." };
  }
  if (!row.subscriberId) return { suppress: "The subscriber record has been erased." };

  const subscriber = await prisma.newsletterSubscriber.findUnique({
    where: { id: row.subscriberId },
    select: {
      id: true,
      email: true,
      emailKey: true,
      status: true,
      deletedAt: true,
      bouncedAt: true,
      complainedAt: true,
      confirmationToken: true,
      confirmationExpiresAt: true
    }
  });
  if (!subscriber || subscriber.deletedAt) return { suppress: "The subscriber record has been erased." };

  const recipient = { to: subscriber.email, emailKey: subscriber.emailKey, subscriberId: subscriber.id };

  if (row.kind !== "CONFIRMATION" && (subscriber.bouncedAt || subscriber.complainedAt)) {
    return { suppress: "This address bounced or reported a previous message as spam." };
  }

  switch (row.kind) {
    case "CONFIRMATION": {
      if (subscriber.status !== "PENDING") {
        return { suppress: "The address was confirmed or unsubscribed before this was sent." };
      }
      // At least an hour of life left, or the reader may open a link that has just died.
      const usable =
        subscriber.confirmationToken &&
        subscriber.confirmationExpiresAt &&
        subscriber.confirmationExpiresAt.getTime() - Date.now() > 60 * 60 * 1000;
      if (usable && subscriber.confirmationToken && subscriber.confirmationExpiresAt) {
        return {
          message: composeConfirmation({
            ...recipient,
            nonce: subscriber.confirmationToken,
            expiresAt: subscriber.confirmationExpiresAt
          })
        };
      }
      const challenge = newConfirmationChallenge();
      const refreshed = await prisma.newsletterSubscriber.updateMany({
        where: { id: subscriber.id, status: "PENDING", deletedAt: null },
        data: {
          confirmationToken: challenge.nonce,
          confirmationExpiresAt: challenge.expiresAt,
          confirmationSentAt: new Date()
        }
      });
      if (refreshed.count === 0) return { suppress: "The address changed state before this was sent." };
      return { message: composeConfirmation({ ...recipient, ...challenge }) };
    }
    case "WELCOME":
      return subscriber.status === "CONFIRMED"
        ? { message: composeWelcome(recipient) }
        : { suppress: "The address is no longer subscribed." };
    case "ALREADY_SUBSCRIBED":
      return subscriber.status === "CONFIRMED"
        ? { message: composeAlreadySubscribed(recipient) }
        : { suppress: "The address is no longer subscribed." };
    case "UNSUBSCRIBE_RECEIPT":
      return subscriber.status === "UNSUBSCRIBED"
        ? { message: composeUnsubscribeReceipt(recipient) }
        : { suppress: "The address subscribed again before this was sent." };
  }
}
