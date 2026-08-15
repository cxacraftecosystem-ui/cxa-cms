import "server-only";

import type { NewsletterMailKind } from "@prisma/client";

import { prisma } from "@/lib/db";
import { siteName, siteUrl } from "@/lib/env";
import { NEWSLETTER_PATH } from "@/lib/newsletter/paths";
import {
  confirmationExpiryFrom,
  newConfirmationNonce,
  newsletterConfirmUrl,
  signNewsletterToken,
  unsubscribeUrlFor,
  CONFIRMATION_TTL_HOURS
} from "@/lib/newsletter/tokens";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ██  THE DELIVERY SEAM.  THIS IS THE ONE FILE THAT SENDS NEWSLETTER EMAIL.  ██
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ WHAT IS TRUE OF THIS DEPLOYMENT RIGHT NOW ══
 *
 * **No email provider is configured, and nothing here sends anything.** That is not a bug and it is
 * not an unfinished edge; it is the honest state of a product whose owner has not yet chosen a
 * provider. Everything else about the newsletter is built and working: an address can be captured,
 * consent is recorded, a signed confirmation link is issued, the confirm and unsubscribe routes
 * accept it, the studio lists and exports subscribers. The single missing piece is the SMTP or API
 * call, and it is behind this seam.
 *
 * The default implementation is `recordingMailer`, and what it does matters:
 *
 *     it WRITES DOWN EVERY MESSAGE THAT SHOULD HAVE BEEN SENT, as a `NewsletterDelivery` row in
 *     state RECORDED, and it sends nothing.
 *
 * ⚠ THE REASON THAT IS NOT A NO-OP. Without it, a person who signs up gets a PENDING row, no email,
 * and no way to ever become CONFIRMED — a subscriber silently stranded, invisible to everybody,
 * indistinguishable from a person who never signed up. With it, the outbox is a queue: the studio's
 * subscribers screen counts the unsent messages and says so at the top of the page, and the moment a
 * provider is registered those rows are the exact backlog to replay. Nothing is lost, and nobody has
 * to remember that anything was.
 *
 * ══ WHAT A REAL PROVIDER MUST IMPLEMENT — THE WHOLE CONTRACT ══
 *
 * One object satisfying `NewsletterMailer`, registered ONCE at start-up from `instrumentation.ts`:
 *
 *     // lib/newsletter/mailer-<provider>.ts
 *     export const providerMailer: NewsletterMailer = {
 *       name: "Postmark",                              // shown in the studio; say what it IS
 *       async send(message) { ... }                    // throws on failure, returns on success
 *     };
 *
 *     // instrumentation.ts, once, before any request is served:
 *     setNewsletterMailer(providerMailer);
 *
 * `send` receives a fully composed `NewsletterMessage` — recipient, subject, plain-text body, and the
 * one link the message exists to carry. Its obligations, in full:
 *
 *   1. **Throw on failure. Return on success.** A resolved promise is recorded as SENT and is the
 *      only evidence anybody will have. An implementation that swallows a provider error and resolves
 *      turns "the provider is rejecting our domain" into "everything looks fine and nobody is
 *      receiving anything" — the single worst failure mode this feature has.
 *   2. **Send to `message.to`, not to `message.emailKey`.** The key is folded to lower case for
 *      identity; `to` is the address the person typed. See lib/newsletter/address.ts.
 *   3. **Include `message.actionUrl` verbatim** where the body says it will be. Do not shorten it, do
 *      not wrap it in a click tracker: a rewritten URL breaks the signature and the reader lands on
 *      "this link is not valid". If the provider rewrites links by default, that feature must be
 *      turned OFF for these messages.
 *   4. **Never batch, never delay, never deduplicate.** A confirmation is transactional mail: it is
 *      useless five minutes later and actively harmful a day later, since the link expires after
 *      `CONFIRMATION_TTL_HOURS` and the reader has long since given up on it.
 *   5. **Set a `List-Unsubscribe` header** on `WELCOME` and on any actual mailing: the header value is
 *      the URL from `unsubscribeUrlFor(message.emailKey)` in angle brackets, alongside
 *      `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. That URL never expires, which is exactly
 *      what RFC 8058 requires of it. ⚠ The header must NOT be set on `CONFIRMATION`, whose recipient
 *      is not subscribed to anything yet.
 *   6. **Keep the credentials in the environment.** Nothing in this repository may hold an API key —
 *      read it with `process.env` inside the adapter, and fail loudly at start-up if it is absent, the
 *      way lib/env.ts does for everything else.
 *   7. **Be idempotent about nothing.** This layer already writes exactly one outbox row per intent
 *      and calls `send` exactly once per row. A provider-side retry is the provider's business.
 *
 * ⚠ **DO NOT ADD A DEPENDENCY TO MAKE THIS FILE WORK.** No SDK is imported here, no transport is
 * chosen and no vendor is assumed, precisely so that choosing one later is one new file and one line
 * in `instrumentation.ts` rather than a change to the newsletter. A provider's own SDK belongs in the
 * adapter, never here.
 *
 * ══ WHY THE OUTBOX ROW IS WRITTEN BEFORE THE SEND, ALWAYS ══
 *
 * `deliverNewsletterMail` writes the `NewsletterDelivery` row FIRST, in state RECORDED, and only then
 * calls the registered mailer, updating the row to SENT or FAILED. So:
 *
 *   • With no mailer, every row stays RECORDED — a complete, replayable backlog.
 *   • With a mailer that throws, the row is FAILED and carries what the provider said.
 *   • With a mailer that hangs and a process that is killed mid-flight, the row is RECORDED — which
 *     reads as "we do not know whether this was sent", the only honest answer. Writing the row after
 *     a successful send would have lost that message entirely.
 *
 * ══ NOTHING HERE EVER THROWS INTO A REQUEST ══
 *
 * `deliverNewsletterMail` catches everything, exactly as `recordEvent` in lib/audit.ts does. A person
 * who successfully signed up must not be shown "something went wrong" because a mail provider had a
 * bad minute — their row exists, their consent is recorded, and the unsent message is visible in the
 * studio. The failure goes to the server log and to the outbox, never to the reader.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Everything a provider needs in order to send one message. Composed here; never assembled by a route. */
export interface NewsletterMessage {
  /** The envelope address — the capitals the person typed. ⚠ Not `emailKey`. */
  to: string;
  /** The normalised identity, for logging and for `unsubscribeUrlFor()`. */
  emailKey: string;
  /** Null when the subscriber row has since been erased. The message still happened. */
  subscriberId: string | null;
  kind: NewsletterMailKind;
  subject: string;
  /**
   * The complete message as PLAIN TEXT.
   *
   * Plain text rather than HTML on purpose: it is the format every client can render, it cannot carry
   * a tracking pixel, and it is the one an adapter can wrap in a template if it wants HTML as well.
   * An adapter that sends HTML must send this as the `text/plain` alternative rather than dropping it.
   */
  bodyText: string;
  /** The single link the message exists to carry, or null for a message that carries none. */
  actionUrl: string | null;
}

/**
 * What a provider adapter must be.
 *
 * Modelled on `RateLimitStore` in lib/ratelimit.ts — an interface, a default implementation that is
 * honest about its limits, and a `set…` registration — so there is one recognisable shape in this
 * codebase for "a thing this deployment has not chosen yet".
 */
export interface NewsletterMailer {
  /** A short name an administrator reads in the studio: "Postmark", "Amazon SES", "SMTP relay". */
  readonly name: string;
  /** ⚠ THROWS on failure. See obligation 1 in the header. */
  send(message: NewsletterMessage): Promise<void>;
}

interface MailerState {
  mailer: NewsletterMailer | null;
  /** So the "nothing is being sent" warning is one line per process rather than one per sign-up. */
  warned: boolean;
}

/**
 * The state lives on `globalThis`, for the reason lib/db.ts and lib/ratelimit.ts give: the dev server
 * re-evaluates modules on every hot reload, and a module-scoped `let` would silently drop a mailer
 * registered at start-up — so the site would stop sending mail after the first file save, with
 * nothing in the log to say why.
 */
const globalForMailer = globalThis as unknown as { __cxaNewsletterMailer?: MailerState };

const state: MailerState = globalForMailer.__cxaNewsletterMailer ?? { mailer: null, warned: false };
globalForMailer.__cxaNewsletterMailer = state;

/**
 * Install a provider. Call it ONCE, at start-up, before any request is served.
 *
 * Registering a second replaces the first and warns — two mailers in one process means messages going
 * out through whichever one happened to be registered last, which is not a configuration anybody chose.
 *
 * ══ ⚠ NOTHING IN THIS REPOSITORY CALLS THIS FUNCTION, AND THAT IS DELIBERATE — READ THIS BEFORE
 *    "FIXING" IT ══
 *
 * This codebase has a standing rule that an exported symbol nothing imports is a defect, because it is
 * usually a feature that was built and never reached. This is the one place where the rule points the
 * wrong way, so the reasoning is written down rather than left to be re-derived:
 *
 *   • **Calling it requires choosing an email provider, and no provider has been chosen.** The only
 *     argument it accepts is a `NewsletterMailer`, and the only honest `NewsletterMailer` is one that
 *     actually sends mail through somebody's service. Writing one here would mean picking a vendor and
 *     adding a dependency on the owner's behalf, which the brief for this feature forbids in as many
 *     words.
 *   • **A fake would be worse than nothing.** A "log it and resolve" mailer would mark every delivery
 *     row SENT while nothing left the building — precisely the failure obligation 1 above calls the worst
 *     one available here, and it would switch the studio's amber "nothing is being sent" banner off while
 *     the statement remained true.
 *   • **Deleting it would delete the feature's only route to sending anything.** `deliverNewsletterMail`
 *     reads `state.mailer`, and this is the one function that can ever set it. An unused setter is a seam;
 *     a missing setter is a newsletter that can never mail.
 *
 * So it is reached by INSTRUCTIONS rather than by an import: the four steps at the top of this file, the
 * amber banner on `app/studio/subscribers/page.tsx` which names this file by path, and the `humanMustDo`
 * section of the handover. ⚠ If you are adding a provider, `instrumentation.ts` DOES NOT EXIST YET in this
 * repository — creating it (with `export function register() { setNewsletterMailer(providerMailer); }`) is
 * step three, and until somebody does, `newsletterMailerInfo().configured` is false in every process and
 * the studio says so on screen.
 *
 * ⚠ ITS COUNTERPART WAS DELETED, NOT MISLAID. `clearNewsletterMailer()` used to sit directly below,
 * documented "for tests and for a controlled failover", and both halves of that were false: this
 * repository has no test framework at all (no vitest/jest/playwright config and no test directory), and a
 * failover would need a caller at runtime, which nothing anywhere could be. It had zero callers, so it was
 * three lines of dead code carrying a comment stating a rule the code did not keep. Bring it back the day
 * a test needs it — `state.mailer = null; state.warned = false;` is all it was — and give it a caller in
 * the same commit.
 */
export function setNewsletterMailer(mailer: NewsletterMailer): void {
  if (state.mailer && state.mailer !== mailer) {
    console.warn(
      `[newsletter] the mail provider was already set to "${state.mailer.name}" and has been replaced ` +
        `with "${mailer.name}". Register it once, at start-up.`
    );
  }
  state.mailer = mailer;
  state.warned = false;
  // Announced at INFO, not warn: a deployment that has done the right thing should be able to prove it
  // from the log rather than by reading code. The same argument as `setRateLimitStore`.
  console.log(`[newsletter] mail provider set to "${mailer.name}" — confirmation emails will be sent.`);
}

/**
 * What the studio's subscribers screen reads to describe delivery honestly.
 *
 * `configured: false` is the sentence "nothing is being sent", and the screen says exactly that
 * rather than leaving an administrator to infer it from a subscriber list that never moves past
 * pending.
 */
export function newsletterMailerInfo(): { configured: boolean; name: string } {
  return state.mailer
    ? { configured: true, name: state.mailer.name }
    : { configured: false, name: "not configured — messages are recorded, not sent" };
}

/**
 * The one fact a PUBLIC page may learn: whether this deployment can send email at all.
 *
 * The public site threads this the way the studio threads `canSendEmail` (app/studio/users/page.tsx):
 * the server page asks once and hands the bare boolean to the client component, whose copy already
 * covers both answers. A page that gets `false` must not promise an email — "instructions go to your
 * inbox" is, on such a deployment, a sentence about mail nobody will ever receive, and the reader it
 * strands is the one refreshing that inbox.
 *
 * Deliberately NOT `newsletterMailerInfo()`, which also carries the provider's name. The name is a
 * fact about the deployment for an administrator's eyes in the studio; a public page has no business
 * shipping it — or any other environment detail — to every visitor. The boolean is the whole answer.
 */
export function mailerConfigured(): boolean {
  return state.mailer !== null;
}

function warnNotConfiguredOnce(): void {
  if (state.warned) return;
  state.warned = true;
  console.warn(
    "[newsletter] no mail provider is registered, so confirmation emails are being WRITTEN DOWN and " +
      "not sent. Every one is a `newsletter_deliveries` row in state RECORDED, and the studio's " +
      "subscribers screen shows the count. Register a provider with setNewsletterMailer() from " +
      "instrumentation.ts — see the header of lib/newsletter/delivery.ts."
  );
}

/**
 * Record one message, then send it if anything can.
 *
 * NEVER THROWS. See the header. The return value says what happened, for a caller that wants to log
 * it; no caller is required to look.
 *
 * ⚠ NOT EXPORTED, AND IT WAS. Its only callers are the four `send…` functions below it in this file, and
 * that is the design rather than an accident of how far the work got: a route must never be able to invent
 * a message. The subject, the body, which link it carries and whether it carries one at all are decided in
 * this file precisely so the wording a reader receives cannot drift between the sign-up path and the
 * re-issue path — and an exported `deliverNewsletterMail` is an open invitation to compose a fifth message
 * at a call site. `NewsletterMailKind` is a closed enum, so such a message could not even name itself
 * honestly: it would have to borrow one of the four kinds, and the studio's outbox would then label it
 * with `MAIL_KIND_LABELS[kind]` — the wrong sentence about a real message, on the one screen that says
 * what has and has not been sent. Adding a message means adding a `send…` function here, beside the other
 * four, where its wording can be read next to theirs.
 */
async function deliverNewsletterMail(
  message: NewsletterMessage
): Promise<"sent" | "recorded" | "failed"> {
  let deliveryId: string | null = null;

  try {
    const row = await prisma.newsletterDelivery.create({
      data: {
        subscriberId: message.subscriberId,
        emailKey: message.emailKey,
        kind: message.kind,
        subject: message.subject,
        // ⚠ NO LINK AND NO BODY ARE STORED. The confirmation URL is a credential, and a table holding
        // one turns every backup and every export into a way to confirm somebody else's subscription.
        // The token is derived, so a replay rebuilds the link — see the header of tokens.ts.
        state: "RECORDED"
      },
      select: { id: true }
    });
    deliveryId = row.id;
  } catch (error) {
    // The outbox write failed. Say so loudly: from here on nothing about this message is recoverable,
    // and that is precisely the fact an operator needs.
    console.error(
      `[newsletter] the outbox row for a ${message.kind} message to ${message.emailKey} could not be ` +
        "written, so this message is not recorded anywhere. The subscriber's own row is unaffected.",
      error
    );
  }

  const mailer = state.mailer;
  if (!mailer) {
    warnNotConfiguredOnce();
    return "recorded";
  }

  try {
    await mailer.send(message);
    if (deliveryId) {
      await prisma.newsletterDelivery.update({
        where: { id: deliveryId },
        data: { state: "SENT", provider: mailer.name, sentAt: new Date(), error: null }
      });
    }
    return "sent";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[newsletter] "${mailer.name}" refused a ${message.kind} message to ${message.emailKey}.`,
      error
    );
    if (deliveryId) {
      await prisma.newsletterDelivery
        .update({
          where: { id: deliveryId },
          data: { state: "FAILED", provider: mailer.name, error: reason.slice(0, 1000) }
        })
        // A failure to record a failure must not become a second exception on the way out.
        .catch((nested: unknown) => {
          console.error("[newsletter] the failed delivery could not be marked FAILED.", nested);
        });
    }
    return "failed";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The four messages
//
// Composed here rather than in the routes, so the wording of what a person receives is in one file
// and cannot drift between the sign-up path and the re-issue path. Every body is plain text, written
// in complete sentences, and every one says what will happen if the reader does nothing — because
// "ignore this email" is the instruction most of these messages actually need to give.
// ─────────────────────────────────────────────────────────────────────────────

/** The footer every message carries. Says where it came from, so nothing arrives unattributed. */
function signature(): string {
  return `\n\n— ${siteName()}\n${siteUrl()}`;
}

export interface ConfirmationRequest {
  to: string;
  emailKey: string;
  subscriberId: string;
  /** The nonce stored on the row. The link is signed over it, which is what makes it single use. */
  nonce: string;
  /** The row's `confirmationExpiresAt`, so the body and the token cannot quote different deadlines. */
  expiresAt: Date;
}

/**
 * The double opt-in message. The ONLY thing a PENDING subscriber is ever sent.
 *
 * ⚠ ITS BODY MUST TELL SOMEBODY WHO DID NOT SIGN UP WHAT TO DO, and the answer is "nothing". Anybody
 * can type anybody's address into a public form; a confirmation that does not say "if this was not
 * you, ignore it and nothing happens" reads as spam, gets reported as spam, and takes the Centre's
 * sending reputation with it.
 */
export async function sendConfirmationEmail(request: ConfirmationRequest): Promise<void> {
  const token = signNewsletterToken({
    purpose: "confirm",
    emailKey: request.emailKey,
    nonce: request.nonce,
    expiresAt: request.expiresAt
  });
  const actionUrl = newsletterConfirmUrl(token);

  await deliverNewsletterMail({
    to: request.to,
    emailKey: request.emailKey,
    subscriberId: request.subscriberId,
    kind: "CONFIRMATION",
    subject: `Confirm your newsletter subscription — ${siteName()}`,
    actionUrl,
    bodyText:
      `Somebody — we hope you — asked for the ${siteName()} newsletter to be sent to this address.\n\n` +
      "Open this link to confirm it. Nothing will be sent to you until you do:\n\n" +
      `${actionUrl}\n\n` +
      `The link works for ${CONFIRMATION_TTL_HOURS} hours. After that it stops working and you can simply ` +
      "sign up again.\n\n" +
      "If this was not you, do nothing at all. Without that click no newsletter is ever sent to this " +
      "address, and the incomplete record is removed in due course. You do not need to reply." +
      signature()
  });
}

/**
 * The answer to a repeat sign-up for an address that is already confirmed.
 *
 * ══ WHY THIS MESSAGE EXISTS AT ALL ══
 *
 * The sign-up route answers IDENTICALLY for every address — it never says whether one is already
 * known, because that would turn a public form into a tool for testing whether a colleague, a
 * journalist or a rival subscribes here. But the person themselves is owed an explanation for why the
 * confirmation link they were expecting has not arrived. So the fact goes to the ONE place that can
 * only be read by whoever controls the address: their inbox.
 */
export async function sendAlreadySubscribedEmail(request: {
  to: string;
  emailKey: string;
  subscriberId: string;
}): Promise<void> {
  const unsubscribeUrl = unsubscribeUrlFor(request.emailKey);

  await deliverNewsletterMail({
    to: request.to,
    emailKey: request.emailKey,
    subscriberId: request.subscriberId,
    kind: "ALREADY_SUBSCRIBED",
    subject: `You are already subscribed — ${siteName()}`,
    actionUrl: unsubscribeUrl,
    bodyText:
      `Somebody just signed this address up for the ${siteName()} newsletter, but it is already ` +
      "subscribed — so nothing has changed and you will not receive it twice.\n\n" +
      "If you would rather stop receiving it, this link does that immediately and needs no account:\n\n" +
      `${unsubscribeUrl}\n\n` +
      "If it was not you who signed up, there is nothing to do: no new subscription was created." +
      signature()
  });
}

/** Sent once, after a confirmation succeeds, so the first thing that arrives is not silence. */
export async function sendWelcomeEmail(request: {
  to: string;
  emailKey: string;
  subscriberId: string;
}): Promise<void> {
  const unsubscribeUrl = unsubscribeUrlFor(request.emailKey);

  await deliverNewsletterMail({
    to: request.to,
    emailKey: request.emailKey,
    subscriberId: request.subscriberId,
    kind: "WELCOME",
    subject: `Your subscription is confirmed — ${siteName()}`,
    actionUrl: unsubscribeUrl,
    bodyText:
      `Your subscription to the ${siteName()} newsletter is confirmed. This address will receive it ` +
      "from the next issue onwards, and nothing else — it is not used for anything else and it is not " +
      "passed to anybody.\n\n" +
      "Every message, including this one, carries a link that stops them:\n\n" +
      `${unsubscribeUrl}\n\n` +
      "Keep it: it works without signing in to anything, and it does not expire." +
      signature()
  });
}

/**
 * Confirms an unsubscribe took effect.
 *
 * ⚠ THE ONE MESSAGE THAT IS SENT TO SOMEBODY WHO HAS JUST ASKED TO BE LEFT ALONE, and it is defensible
 * only because it is the receipt for an action they themselves took a second ago. It says explicitly
 * that it is the last one. Nothing else may ever be sent to an UNSUBSCRIBED address.
 */
export async function sendUnsubscribeReceipt(request: {
  to: string;
  emailKey: string;
  subscriberId: string;
}): Promise<void> {
  await deliverNewsletterMail({
    to: request.to,
    emailKey: request.emailKey,
    subscriberId: request.subscriberId,
    kind: "UNSUBSCRIBE_RECEIPT",
    subject: `You have been unsubscribed — ${siteName()}`,
    actionUrl: null,
    bodyText:
      `This address has been removed from the ${siteName()} newsletter. This is the last message you ` +
      "will receive from it.\n\n" +
      "We keep a record that you asked to stop, and nothing else, so that a later import or a form " +
      "filled in by somebody else cannot quietly put you back on the list. If you ever want the " +
      // The path is the constant the sign-up page itself is mounted at, not a literal — see the header
      // of lib/newsletter/paths.ts. A "sign up again" address that has moved is a dead end for somebody
      // who has already been told this is the last message they will get from us.
      `newsletter again, sign up at ${siteUrl()}${NEWSLETTER_PATH}.` +
      signature()
  });
}

/**
 * A fresh confirmation nonce and its expiry, as one object.
 *
 * Here rather than at each call site so the row's `confirmationToken`/`confirmationExpiresAt` and the
 * link's signed payload are always produced from the same pair of values — the one place those two
 * could drift is the one place a confirmation link would be permanently rejected.
 */
export function newConfirmationChallenge(now: Date = new Date()): {
  nonce: string;
  expiresAt: Date;
} {
  return { nonce: newConfirmationNonce(), expiresAt: confirmationExpiryFrom(now) };
}
