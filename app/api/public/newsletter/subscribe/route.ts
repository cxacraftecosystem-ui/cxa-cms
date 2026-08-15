import type { NextRequest } from "next/server";
import { z } from "zod";

import { assertSameOrigin, clientIp, route, userAgent } from "@/lib/api";
import { prisma } from "@/lib/db";
import {
  EMAIL_MAX_LENGTH,
  displayEmail,
  normaliseEmail,
  toNewsletterSource
} from "@/lib/newsletter/address";
import { STALE_CONSENT_MESSAGE, consentTextFor } from "@/lib/newsletter/consent";
import {
  newConfirmationChallenge,
  sendAlreadySubscribedEmail,
  sendConfirmationEmail
} from "@/lib/newsletter/delivery";
import {
  CONFIRMATION_RESEND_COOLDOWN_MINUTES,
  NEWSLETTER_RATE_LIMITS,
  enforceNewsletterRateLimit,
  newsletterWantsJson,
  readNewsletterBody,
  refuse,
  succeed
} from "@/lib/newsletter/http";
import { NEWSLETTER_PATH } from "@/lib/newsletter/paths";

/**
 * Sign up for the newsletter — the first half of a double opt-in.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ██  THE ONE THING TO UNDERSTAND: **THE ANSWER IS IDENTICAL FOR EVERY ADDRESS.**  ██
 *
 * A new address, an address already waiting to confirm, an address that is already subscribed, an
 * address that unsubscribed last year, and an address whose record was erased all receive the SAME
 * status, the SAME sentence and the SAME redirect. This is the rule `app/api/public/contact/route.ts`
 * follows about spam, applied to a different secret, and the reasoning is stronger here:
 *
 *   • A form that answered "you are already subscribed" is an ORACLE. Anybody could type a colleague's,
 *     a journalist's or a rival's address into a public box and learn whether they read this newsletter.
 *     That is a fact about a person which this application has no right to disclose to whoever asks.
 *   • The person themselves is still owed the explanation, so it goes to the one place only they can
 *     read: their inbox. `sendAlreadySubscribedEmail` exists for precisely that, and its header says so.
 *
 * ⚠ SO DO NOT ADD A FIELD TO THE ANSWER THAT DIFFERS BETWEEN THE BRANCHES. Not a `created` boolean, not
 * a `status`, not a different wording for "a message is on its way" versus "another message is on its
 * way". Timing is the one channel that cannot be closed here, and it is not worth closing: every branch
 * does one indexed lookup and hands one message to the delivery seam, which is close enough that no
 * conclusion can be drawn from it over the internet.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ══ THE FOUR STATES OF AN ADDRESS THAT ARRIVES HERE ══
 *
 *   1. **Unknown.** A PENDING row is created and a confirmation is sent. Nothing else happens: nobody is
 *      on the list until they click.
 *   2. **PENDING already.** The nonce and expiry are REPLACED (which kills the previous link — see
 *      `confirmationToken` in the schema) and a fresh confirmation is sent, subject to the cooldown
 *      below. ⚠ The consent stamp is rewritten too, **but only in the write that issues that fresh
 *      nonce** — never on a submission the cooldown suppressed. When a link is issued, they have just
 *      agreed again and the newer agreement is the one to hold evidence of; when no link is issued, the
 *      agreement that will actually be proved is the OLDER one and it must survive untouched. See "THE
 *      CONSENT BLOCK AND THE CHALLENGE TRAVEL TOGETHER" at the `upsert`.
 *   3. **CONFIRMED.** Nothing at all is changed. `sendAlreadySubscribedEmail` tells them why no
 *      confirmation link is coming, and carries their unsubscribe link.
 *   4. **UNSUBSCRIBED.** The row is put back to PENDING and a confirmation is sent — it is NOT
 *      re-subscribed. This is the whole reason the suppression record is kept: schema fact 2 says a row
 *      exists so "a later import or a form filled in by somebody else cannot quietly put you back on the
 *      list", and honouring that means the ONLY thing that can re-subscribe somebody is a click in their
 *      own mailbox. `unsubscribedAt` is deliberately NOT cleared here — see the note at the write.
 *
 * ⚠ AND THE FIFTH, WHICH IS A JUDGEMENT CALL, NOT AN OBVIOUS ANSWER. A row with `deletedAt` set is an
 * ERASURE — somebody asked to be forgotten, which is a stronger request than asking to be left alone.
 * `emailKey` is `@unique`, so the row cannot be ignored and re-created; something must be decided. This
 * route REVIVES it as PENDING with a new consent record, because the alternative is that an address
 * which was once erased can never subscribe again for as long as the database lives — a permanent,
 * invisible ban that no screen would ever explain to the person hitting it. New consent, freshly
 * recorded, is a lawful basis in its own right; and the only message that reaches them before they click
 * is one confirmation that tells them to ignore it if it was not them. It is written down here because it
 * is the kind of decision that looks like an oversight when it is met later in a database.
 *
 * ══ WHY THERE IS NO HONEYPOT ON THIS FORM, UNLIKE THE CONTACT FORM ══
 *
 * Deliberate, and it is not laziness — `lib/spam.ts` was read before this was decided.
 *
 * A honeypot's answer to a hit is "accept the submission and mark it", because the cost of being wrong
 * about a PERSON is far higher than the cost of storing a bot's message: the contact route stores a
 * flagged enquiry so an editor can still find it a day later. `NewsletterSubscriber` HAS NO SUCH STATE.
 * There is no `SPAM` status, no filter that shows suppressed sign-ups, and no screen anywhere that could
 * surface one — so a honeypot here could only ever SILENTLY DISCARD, and a real reader caught by it would
 * wait for an email that no human being can discover was never sent. That is the exact defect class this
 * repository keeps producing, bought for no gain, because the thing a honeypot would protect against is
 * already covered twice over:
 *
 *   • **The double opt-in is the defence.** A bot that submits a thousand addresses creates a thousand
 *     PENDING rows that are never mailed anything again and never appear in a mailing, because
 *     `mailableSubscriberWhere()` filters on CONFIRMED. It has achieved nothing.
 *   • **`CONFIRMATION_RESEND_COOLDOWN_MINUTES` closes the one real harm** — using this form to post
 *     mail at somebody else's inbox — and it closes it for a distributed attacker too, because it is
 *     measured on the ROW, not on the connection.
 *
 * If a honeypot is ever wanted here, it needs a place to put its verdict first.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ NO AUDIT ENTRY IS WRITTEN, AND THAT IS THE CONSIDERED CHOICE. `recordEvent` would copy a member of
 * the public's email address into `audit_logs`, a table read by more people and included in exports —
 * the contact route makes exactly this argument about message bodies. The evidence a consent challenge
 * needs is already on the subscriber row and is richer: `consentText` (verbatim), `consentVersion`,
 * `consentAt`, `ipAddress`, `userAgent`. Duplicating it would widen who can read an address without
 * adding a single fact. Studio-side changes DO write audit entries; a reader's own act does not.
 */

export const dynamic = "force-dynamic";

/** Where a browser with no JavaScript is sent back to, with a `?state=` code. */
const BASE_PATH = NEWSLETTER_PATH;

/**
 * ⚠ EVERY FIELD IS A LENIENT STRING, AND THE CAPS ARE PROTECTION RATHER THAN VALIDATION.
 *
 * The semantic checks are done below, by hand, with `refuse()` — NOT by Zod. That is the opposite of the
 * house habit (`parseJson` + a strict schema) and there is one reason for it: a Zod failure is a single
 * `ApiError`, and this route has to tell three different refusals apart because each one sends the
 * browser back with a DIFFERENT `?state=` code and therefore a different sentence on screen. An address
 * that will not parse is "invalid"; an unticked box is "consent"; a page older than the current wording
 * is "stale". Collapsing those into one 422 would show a reader who forgot to tick a box a message about
 * their email address.
 *
 * So Zod's whole job here is "these are strings, and none of them is a megabyte". Anything that trips
 * one of these caps is not a reader — the form's own `maxLength` attributes are far below them — and
 * `readNewsletterBody` still answers it in the caller's own shape rather than throwing JSON at a browser.
 *
 * ⚠ AND EVERY VALUE ARRIVES AS A STRING, INCLUDING THE CHECKBOX. HTML has no other kind of value: an
 * unticked checkbox is ABSENT from the body, not `false`. `consent` is therefore validated as "present,
 * and naming a wording this build knows", never as a boolean — see `CONSENT_FIELD` below.
 *
 * ⚠ `.default("")` AND NOT `.optional().default("")`. The two read as synonyms and are not: `.optional()`
 * puts `undefined` in the OUTPUT type, and `ZodDefault` wrapped around it only substitutes for a missing
 * INPUT — so the combination yields `string | undefined` and every read below needs a `?? ""` that does
 * nothing at runtime. `.default("")` alone makes the key optional in the input and `string` in the output,
 * which is exactly what is wanted: an absent field (an unticked checkbox, an old form) becomes `""` and is
 * then refused by name, with its own sentence, rather than by a type guard.
 */
const SubscribeBody = z.object({
  email: z.string().trim().max(1000).default(""),
  /** The ticked box's `value`, which IS the consent version. See `CONSENT_FIELD`. */
  consent: z.string().trim().max(64).default(""),
  source: z.string().trim().max(64).default(""),
  sourcePath: z.string().trim().max(2048).default("")
});

/**
 * ⚠ THE CONSENT CHECKBOX CARRIES THE VERSION AS ITS `value`, AND THAT IS ONE FIELD DOING TWO JOBS ON
 * PURPOSE.
 *
 * `lib/newsletter/consent.ts` requires the FORM to post which wording it displayed, so the route can
 * store the sentence the person actually read rather than whatever the server's current wording happens
 * to be. The naive implementation is two fields — a checkbox plus a hidden `consentVersion` — and it has
 * a hole: a submission carrying the hidden version WITHOUT the checkbox would record consent to a
 * sentence nobody agreed to. Putting the version in the checkbox's own `value` makes that unrepresentable
 * — the version cannot arrive unless the box was ticked, because a browser sends neither otherwise.
 *
 * The name is shared with `NewsletterSignup` through this file only as a documented contract; the form
 * writes `name="consent"` and `value={CURRENT_CONSENT_VERSION}`.
 */
const CONSENT_FIELD = "consent";

/** The sentence every successful sign-up is answered with, whatever the address's real state was. */
const CONFIRMATION_PROMISE =
  "Thank you. If that address can receive mail, a message is on its way to it with a link to confirm — " +
  "nothing will be sent to you until you open it. If nothing arrives within a few minutes, check the " +
  "folder your mail programme files bulk mail in.";

export const POST = route(async (request: NextRequest) => {
  /**
   * ⚠ THE ANSWER SHAPE IS DECIDED FIRST, FROM A HEADER, BEFORE THE BODY IS TOUCHED.
   *
   * The rate limit has to answer in the caller's own shape, and it runs before the body is read (the
   * contact route's rule: a refusal should cost as little as possible). `newsletterWantsJson` is the same
   * function `readNewsletterBody` uses, so the limiter and the handler cannot disagree about who asked.
   */
  const wantsJson = newsletterWantsJson(request);

  const limited = enforceNewsletterRateLimit({
    request,
    bucket: "newsletter-signup",
    policy: NEWSLETTER_RATE_LIMITS.signup,
    wantsJson,
    basePath: BASE_PATH,
    message: (phrase) =>
      `This form has been used ${NEWSLETTER_RATE_LIMITS.signup.limit} times from your connection in the ` +
      `last few minutes, so it is paused. Try again in ${phrase}. If you have already signed up, the ` +
      "confirmation email is on its way and you do not need to send this again."
  });
  if (limited) return limited;

  /**
   * ⚠ AFTER the rate limit and BEFORE the body, matching the contact route.
   *
   * A cross-site POST is answered as JSON even on the browser path, and that is correct: `assertSameOrigin`
   * only fires when an `Origin` header is present AND names another host, which never happens to a reader
   * submitting the Centre's own form. Whoever does see it crafted the request, and does not need a page.
   */
  assertSameOrigin(request);

  const body = await readNewsletterBody(request, SubscribeBody, {
    basePath: BASE_PATH,
    state: "invalid"
  });
  if (!body.ok) return body.response;

  const { data } = body;

  // ── The address ────────────────────────────────────────────────────────────

  /**
   * ⚠ ONE definition of "the same address", from lib/newsletter/address.ts. Never `.toLowerCase()` here:
   * `emailKey` is `@unique`, and a call site that folds differently from the token signer produces a row
   * whose unsubscribe link nothing can look up.
   */
  const emailKey = normaliseEmail(data.email);
  if (!emailKey) {
    /**
     * ONE sentence, used as both the banner and the message under the box.
     *
     * Written once rather than twice: `message` and `fieldErrors.email` are read by two different parts
     * of the form (the summary and `Field`'s own error slot), and two literals saying nearly the same
     * thing is how one of them ends up correcting a wording the other still gets wrong.
     *
     * ⚠ The distinction is EMPTY versus UNPARSEABLE, not "too long". An address over
     * `EMAIL_MAX_LENGTH` also fails `normaliseEmail`, and telling somebody who pasted 300 characters
     * that there is a typo in their domain is close enough to true to be actionable, where "your
     * address exceeds the SMTP mailbox limit" is not something a reader can do anything with.
     */
    const sentence =
      data.email.length === 0
        ? "Enter the email address the newsletter should go to."
        : `That does not look like an email address. Check for a missing @, a typo in the domain, or ` +
          `whether it is longer than ${EMAIL_MAX_LENGTH} characters.`;

    return refuse({
      wantsJson,
      status: 422,
      code: "validation_failed",
      // Keyed to the field the form renders, so `Field` can attach it to the right box.
      fieldErrors: { email: [sentence] },
      message: sentence,
      basePath: BASE_PATH,
      state: "invalid"
    });
  }

  // ── The consent record ────────────────────────────────────────────────────

  if (data[CONSENT_FIELD].length === 0) {
    return refuse({
      wantsJson,
      status: 422,
      code: "consent_required",
      fieldErrors: { consent: ["Tick the box to say you would like these emails."] },
      message:
        "Nothing has been saved, because the box saying you would like these emails was not ticked. " +
        "The Centre only sends a newsletter to somebody who has asked for it in as many words.",
      basePath: BASE_PATH,
      state: "consent"
    });
  }

  /**
   * The wording they actually saw, found by the version their page posted.
   *
   * `null` means this build has never heard of that version — a page prerendered before the wording
   * changed, a tab left open over a deploy, or a browser's back-forward cache. It is a NORMAL outcome,
   * not an attack, and consent.ts explains at length why the honest answer is to refuse and ask them to
   * reload rather than to store a sentence that was never on their screen.
   */
  const consentText = consentTextFor(data[CONSENT_FIELD]);
  if (!consentText) {
    return refuse({
      wantsJson,
      status: 409,
      code: "consent_stale",
      message: STALE_CONSENT_MESSAGE,
      basePath: BASE_PATH,
      state: "stale"
    });
  }

  // ── The row ───────────────────────────────────────────────────────────────

  const now = new Date();
  const email = displayEmail(data.email);
  const source = toNewsletterSource(data.source);
  const sourcePath = data.sourcePath.length > 0 ? data.sourcePath.slice(0, 500) : null;
  const ipAddress = clientIp(request);
  const agent = userAgent(request)?.slice(0, 512) ?? null;

  /**
   * The evidence for THIS submission, as one object.
   *
   * ⚠ ONE OBJECT SO THE FIVE FIELDS CANNOT BE WRITTEN SEPARATELY, and it is spread ONLY where a fresh
   * confirmation link is issued in the same statement — see "THE CONSENT BLOCK AND THE CHALLENGE TRAVEL
   * TOGETHER" at the `upsert`. Half a consent record (a new `consentAt` beside last week's `ipAddress`)
   * would be worse than either, and grouping them is what makes writing half of one impossible.
   */
  const consent = {
    consentText,
    consentVersion: data[CONSENT_FIELD],
    consentAt: now,
    ipAddress,
    userAgent: agent
  };

  const existing = await prisma.newsletterSubscriber.findUnique({
    where: { emailKey },
    select: {
      id: true,
      email: true,
      status: true,
      confirmationSentAt: true,
      /**
       * ⚠ BOTH HALVES OF THE OUTSTANDING CHALLENGE ARE READ, and they are not decoration.
       *
       * `hasUsableChallenge` below needs to know whether a link that still WORKS is already in this
       * person's inbox, and that question cannot be answered from `confirmationSentAt` alone: the nonce
       * may have been cleared by an unsubscribe, or the expiry may have passed. Selecting only the date
       * is what produced the stranded-subscriber bug described there.
       */
      confirmationToken: true,
      confirmationExpiresAt: true,
      deletedAt: true
    }
  });

  // ── 3. Already subscribed ─────────────────────────────────────────────────

  if (existing && existing.status === "CONFIRMED" && existing.deletedAt === null) {
    /**
     * ⚠ NOTHING ON THE ROW IS CHANGED, INCLUDING THE CONSENT STAMP.
     *
     * They are already subscribed on the strength of a consent they gave and CONFIRMED. Overwriting that
     * record with the details of a submission that may have been typed by somebody else would replace
     * good evidence with worse — the stored `consentAt`/`ipAddress` would then describe a stranger's
     * keystrokes rather than the act that actually created the subscription.
     */
    await notifyAlreadySubscribed({
      emailKey,
      to: existing.email,
      subscriberId: existing.id,
      now
    });

    return succeed({
      wantsJson,
      json: { received: true, message: CONFIRMATION_PROMISE },
      basePath: BASE_PATH,
      state: "sent"
    });
  }

  // ── 1, 2, 4 and the erasure case: everything that needs a confirmation ────

  const challenge = newConfirmationChallenge(now);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠ THE COOLDOWN IS MEASURED ON THE ROW, NOT ON THE CONNECTION, AND IT DEFENDS A THIRD PARTY.
   *
   * The rate limit above protects the server from one connection. This protects a person whose address
   * somebody else typed into the box: without it, five submissions an hour — comfortably inside the rate
   * limit, sustained for a week, from as many addresses as the attacker likes — is a campaign of
   * harassment conducted entirely through legitimate use of a public form. `confirmationSentAt` is the
   * column the schema documents for exactly this, so this is the read that makes it reached rather than
   * merely stored.
   *
   * ⚠ AND IT SUPPRESSES A SEND **ONLY WHEN A USABLE LINK IS ALREADY IN THAT INBOX.** That second
   * condition is not caution, it is the difference between a cooldown and a trap.
   *
   * Suppressing the message means telling the reader "a message is on its way" and sending nothing. That
   * is honest ONLY if an earlier message is genuinely sitting there and its link genuinely still works —
   * and the link works only while the nonce it was signed over is still on the row and still unexpired.
   * Two ordinary sequences leave `confirmationSentAt` recent while the nonce is gone or dead:
   *
   *   • **They unsubscribed.** Both unsubscribe paths CLEAR `confirmationToken` on purpose, so that an
   *     old confirmation link cannot put somebody back on a list they asked to leave. A sign-up minutes
   *     later would find a recent `confirmationSentAt` and no nonce.
   *   • **They confirmed, then were erased and signed up again** — same shape: the nonce was spent.
   *
   * Without the `hasUsableChallenge` test, both of those produce a PENDING row with NO nonce and NO
   * message — a subscriber who is told to check their inbox, has nothing to find, and *can never confirm*,
   * because the only thing that could issue them a new link is the sign-up they just made. That is
   * precisely the "silently stranded subscriber, indistinguishable from a person who never signed up"
   * that the header of lib/newsletter/delivery.ts calls the worst failure this feature has.
   *
   * ⚠ IT DOES NOT WEAKEN THE PROTECTION. To reach the send inside the window an attacker needs the nonce
   * to be absent, and the only things that clear it are acts of the ADDRESS'S OWNER (confirming, or
   * unsubscribing). So the worst case is one extra message per action the owner themselves took — bounded,
   * not a loop, because this send writes `confirmationSentAt` again and restores a live nonce.
   *
   * ⚠ WHEN THE COOLDOWN DOES BITE, THE NONCE AND EXPIRY ARE LEFT EXACTLY AS THEY ARE. Replacing them
   * would invalidate the link in the message the reader is about to go and find — the one this branch is
   * relying on. So this is the one path that writes neither.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const cooldownUntil = existing?.confirmationSentAt
    ? new Date(existing.confirmationSentAt.getTime() + CONFIRMATION_RESEND_COOLDOWN_MINUTES * 60_000)
    : null;

  /**
   * ⚠ AN ERASED ROW HAS NO USABLE CHALLENGE, WHATEVER ITS COLUMNS SAY. That first clause is not
   * defensive tidying; it is what keeps two other paragraphs in this file true.
   *
   * A row erased while it was still PENDING can carry a live nonce (the studio's erase action clears it,
   * but a row erased by hand in the database, or by any earlier version of that action, need not have) —
   * and `deletedAt` is precisely the state in which the sentence this test exists to justify cannot be
   * asserted. That sentence is "a message with a WORKING link is already sitting in that inbox, so
   * sending another would be harassment". The message it refers to belonged to a subscription that has
   * since been erased at that person's own request; relying on it is relying on evidence this
   * application has just been asked to forget.
   *
   * ⚠ AND IT IS WHAT KEEPS THE FIFTH STATE IN THE HEADER TRUE. That paragraph promises an erased row is
   * revived "as PENDING with a new consent record", and the consent block is now written only alongside a
   * fresh challenge (see the `upsert`). Without this clause a revival could land on the cooldown branch
   * and bring the row back on the strength of the consent record that was erased — the exact opposite of
   * what the header says, and a comment contradicting its own code is the worst defect this repository
   * produces.
   *
   * ⚠ IT DOES NOT WEAKEN THE COOLDOWN. To reach the send inside the window an attacker still needs the
   * nonce to be absent or dead, or the row to be erased — and only a member of staff can erase a row, so
   * no public submission can put a row into this state in order to farm an extra message out of it.
   */
  const hasUsableChallenge =
    existing !== null &&
    existing.deletedAt === null &&
    typeof existing.confirmationToken === "string" &&
    existing.confirmationToken.length > 0 &&
    existing.confirmationExpiresAt !== null &&
    existing.confirmationExpiresAt > now;

  const withinCooldown = cooldownUntil !== null && cooldownUntil > now && hasUsableChallenge;

  /**
   * The fields that describe THIS sign-up, applied whether the row is new or being re-used.
   *
   * ⚠ THE CONSENT BLOCK IS DELIBERATELY **NOT** IN HERE. It used to be spread in at the bottom of this
   * object, which meant every write of any kind rewrote the consent evidence; that was a real defect and
   * the reasoning is at the `upsert` below. What remains here is descriptive metadata, and the difference
   * between the two kinds of field is the whole point:
   *
   *   • `email` (the spelling), `source` and `sourcePath` describe the MOST RECENT submission. The studio
   *     renders them as "the address as typed" and "where they signed up", never as proof of anything, so
   *     the newest values are the honest ones and a repeat submission is entitled to update them.
   *   • `consentText`/`consentVersion`/`consentAt`/`ipAddress`/`userAgent` are EVIDENCE. They answer
   *     "what did this person agree to, when, and from where", and the answer has to describe the act
   *     that actually created the subscription — which is the act whose confirmation link gets clicked.
   *
   * ⚠ `unsubscribedAt` IS NOT CLEARED, AND `deletedAt` IS.
   *
   * The unsubscribe date is the record that this person once asked to stop, and schema fact 2 keeps that
   * record on purpose — the studio renders it, so "did they leave and come back?" stays answerable.
   * Nothing reads it as a suppression: `mailableSubscriberWhere()` tests `status` and `deletedAt` and
   * NOTHING ELSE — `unsubscribedAt` is not in it — so a row that goes on to confirm is mailable again with
   * its history intact. (The sentence here used to say "filters on `status` alone", which was one column
   * short of the truth; the point it was making survives, but a reader checking it would have found the
   * `deletedAt: null` and been left wondering what else was wrong.)
   *
   * `deletedAt` MUST be cleared, because every read path filters on it. A revived row that kept it would
   * be invisible to the studio, to the export and to any mailing while still occupying the unique
   * `emailKey` — a subscriber who exists, cannot be seen, and blocks their own address from ever being
   * used again. See the fifth state in the header for why reviving is the choice at all.
   */
  const thisSignup = {
    // The spelling they typed THIS time. `emailKey` is the identity and is never rewritten.
    email,
    status: "PENDING",
    source,
    sourcePath,
    deletedAt: null
  } as const;

  /** A fresh challenge, written unless an earlier usable one is being relied on. See the cooldown note. */
  const freshChallenge = {
    confirmationToken: challenge.nonce,
    confirmationExpiresAt: challenge.expiresAt,
    confirmationSentAt: now
  } as const;

  /**
   * ⚠ `upsert` RATHER THAN A READ-THEN-BRANCH, AND IT IS THE RACE THAT DECIDES IT.
   *
   * The obvious shape is `if (existing) update else create`, which is what this route did first. It has a
   * defect that only shows under concurrency: `emailKey` is `@unique`, so two submissions of the SAME
   * address arriving together both read `existing === null`, both attempt `create`, and the loser gets a
   * `P2002` unique violation — which `route()` turns into a 500 and an alarming "something went wrong" for
   * somebody whose sign-up in fact succeeded. `upsert` resolves that inside the database.
   *
   * ⚠ The COOLDOWN decision is still made from the row as it was READ, so in that same race both
   * requests may send a confirmation. That is the correct direction to be wrong in — the alternative is a
   * reader who is told a message is coming and never gets one — and it is self-limiting, because the
   * second write leaves one live nonce and a fresh `confirmationSentAt`.
   *
   * `select: { id: true }` because the id is all that is wanted, and it also keeps the address out of the
   * value this handler carries around after the write.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * ██  ⚠ THE CONSENT BLOCK AND THE CHALLENGE TRAVEL TOGETHER. ALWAYS. NEVER ONE WITHOUT THE OTHER.  ██
   *
   * `...consent` appears in exactly the two places `...freshChallenge` appears, and that pairing is the
   * whole rule: **a consent record may only be written by the same statement that issues the link which
   * will prove it.** It is written down at this length because the code that broke it looked completely
   * reasonable, typechecked, and was wrong in a way no type could catch.
   *
   * WHAT WENT WRONG. `...consent` used to be spread into `thisSignup`, which is applied on EVERY branch
   * including the cooldown-suppressed one. So:
   *
   *     10:00  the address's real owner signs up from 1.1.1.1. Row PENDING, nonce N,
   *            consentAt 10:00, ipAddress 1.1.1.1. A confirmation carrying N is in their inbox.
   *     10:05  a stranger at 9.9.9.9 types the same address into the footer form and ticks the box.
   *            `hasUsableChallenge` is true and the cooldown bites, so — correctly — no message is
   *            sent and nonce N is left alone. But the old code still applied `thisSignup`, which
   *            carried the consent block: consentAt became 10:05, ipAddress 9.9.9.9, userAgent the
   *            stranger's browser.
   *     10:20  the owner opens the link in their OWN inbox. It still works, because N was preserved.
   *            The row becomes CONFIRMED.
   *
   * The subscription is now confirmed, lawfully, by the owner — and its stored evidence names a stranger's
   * IP, a stranger's browser and a timestamp five minutes after the agreement that actually happened. That
   * record is what the studio prints under "What they agreed to, and the evidence" and what the CSV's
   * "Agreed (UTC)" and "Address they signed up from" columns carry, so the one artefact anybody would
   * produce in a consent dispute would have been provably inconsistent with the challenge that confirmed
   * the subscription.
   *
   * ⚠ IT IS THE SAME ARGUMENT THE CONFIRMED BRANCH ALREADY MAKES, ONLY STRONGER. That branch refuses to
   * rewrite consent because it "would replace good evidence with worse". A PENDING row is the one that can
   * still BECOME a subscription, so the evidence being overwritten there is the evidence that will actually
   * be relied upon.
   *
   * ⚠ AND `create` NEEDS NO CONDITION. Prisma requires `consentText`, `consentVersion` and `consentAt`
   * (they are non-null in the schema), so a row cannot exist without consent and the "first consent" case
   * is exactly and only the `create` branch. There is no third case to forget.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const row = await prisma.newsletterSubscriber.upsert({
    where: { emailKey },
    create: { ...thisSignup, emailKey, ...consent, ...freshChallenge },
    update: withinCooldown ? thisSignup : { ...thisSignup, ...consent, ...freshChallenge },
    select: { id: true }
  });
  const subscriberId = row.id;

  if (!withinCooldown) {
    /**
     * ⚠ `deliverNewsletterMail` NEVER THROWS (see its header), so this is deliberately NOT wrapped in a
     * try/catch. A reader whose row and consent are safely written must not be told "something went wrong"
     * because a mail provider had a bad minute — the unsent message is a `newsletter_deliveries` row that
     * the studio counts, states on screen, and can replay once a provider exists.
     */
    await sendConfirmationEmail({
      to: email,
      emailKey,
      subscriberId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt
    });
  }

  return succeed({
    wantsJson,
    json: { received: true, message: CONFIRMATION_PROMISE },
    basePath: BASE_PATH,
    state: "sent"
  });
});

/**
 * The "you are already subscribed" message, under the same cooldown as a confirmation.
 *
 * ⚠ IT NEEDS ITS OWN CLOCK, AND `confirmationSentAt` CANNOT BE IT. That column means "when a confirmation
 * was last handed to the seam" (schema), and a CONFIRMED row has not been sent one for however long it
 * has been subscribed — so measuring from it would let this message be sent on every single submission,
 * which is the mail-bombing hole the cooldown exists to close, reopened for the one group of people who
 * are definitely real: confirmed subscribers.
 *
 * So the clock is the OUTBOX, which records every message of every kind. It costs one indexed query on
 * `(emailKey)` and it needs no new column — which matters, because a migration mid-run would break every
 * other agent working in this repository. It is also strictly more honest: it throttles on what was
 * actually handed to the provider rather than on what a column is named after.
 */
async function notifyAlreadySubscribed(input: {
  emailKey: string;
  to: string;
  subscriberId: string;
  now: Date;
}): Promise<void> {
  const since = new Date(input.now.getTime() - CONFIRMATION_RESEND_COOLDOWN_MINUTES * 60_000);

  const recent = await prisma.newsletterDelivery.findFirst({
    where: {
      emailKey: input.emailKey,
      kind: "ALREADY_SUBSCRIBED",
      createdAt: { gt: since }
    },
    select: { id: true }
  });

  if (recent) return;

  await sendAlreadySubscribedEmail({
    to: input.to,
    emailKey: input.emailKey,
    subscriberId: input.subscriberId
  });
}
