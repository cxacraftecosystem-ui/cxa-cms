import "server-only";
import { createHmac } from "node:crypto";
import { after } from "next/server";
import type { Role } from "@prisma/client";

import { ApiError, conflict, forbidden } from "@/lib/api";
import { mutateWithHistory, recordEvent, type AuditContext } from "@/lib/audit";
import { attemptedAddress } from "@/lib/audit-subject";
import { activeAuthMailer, renderPasswordResetEmail } from "@/lib/auth/auth-mail";
import { authEnv } from "@/lib/auth/config";
import { RESET_TTL_HOURS, issueCredentialLink } from "@/lib/auth/credential-token";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { MailSendError } from "@/lib/newsletter/mail-errors";
import { canManageUser, type PermissionSubject } from "@/lib/permissions";
import { RATE_LIMITS, consumeRateLimitAsync } from "@/lib/ratelimit";
import { found } from "@/lib/studio/crud";

/**
 * Password-reset links, from both doors: an administrator on Studio → Users ("Make a password link",
 * "Email them a password link"), and a signed-out person on "Forgot your password?".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE TOKEN MECHANISM, NOT TWO. Every link minted here is `issueCredentialLink({ purpose: "reset" })`
 * from lib/auth/credential-token.ts — the same signed, fingerprint-bound, single-use token the invitation
 * uses, landing on the same `/studio/set-password` screen and claimed through the same
 * `app/api/auth/set-password/route.ts`. So everything that route guarantees holds for an emailed link
 * too, and is NOT re-implemented here:
 *
 *   • single use — setting a password changes the fingerprint and every earlier link stops verifying;
 *   • the RESET_TTL_HOURS expiry (2 hours), unchanged;
 *   • every session revoked when the password is set;
 *   • ⚠ TWO-STEP VERIFICATION STILL REQUIRED — an account with a second factor is NOT signed in by the
 *     link; it is sent to sign in and present its code (rule 5 of that route). Nothing here touches
 *     `twoFactorEnabled`, and nothing may.
 *
 * And the link is built from `siteUrl()` — the configured origin — inside `credentialLink`, never from a
 * request header, so a forged `Host` / `X-Forwarded-Host` cannot choose where somebody's credential is
 * sent (lib/request-origin.ts says why that is the classic bug).
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The administrator's door
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Word-for-word the note in `app/api/studio/users/[id]/route.ts`. One act, one description. */
export const REVOCATION_NOTE =
  "Every device they were signed in on has to sign in again. A page they already have open may keep " +
  "reading the studio for up to half an hour until its short-lived token expires, but it cannot renew and " +
  "every change it attempts is checked against the account as it is now.";

/** The account a link is being made for. `passwordHash` is here ONLY to become the token's fingerprint. */
export interface ResetTarget {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  deletedAt: Date | null;
  passwordHash: string | null;
}

/**
 * Read the account, 404 when there is none.
 *
 * ⚠ `passwordHash` is selected — it goes straight into `issueCredentialLink`, which turns it into a
 * 16-character digest. No caller may put this row in a response. Check that before adding one.
 */
export async function loadResetTarget(id: string): Promise<ResetTarget> {
  return found(
    await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        deletedAt: true,
        passwordHash: true
      }
    }),
    "That account"
  );
}

/** How the link reaches the person — only the wording of a refusal depends on it. */
export type ResetDelivery = "link" | "email";

/**
 * May `actor` issue a password link for `target`? Null when yes; the refusal to throw when not.
 *
 * ══ THE SAME RULE FOR BOTH BUTTONS ══
 * "Make a password link" and "Email them a password link" are one act with two deliveries, so they are
 * refused by ONE function, in one order, with sentences that differ only in the verb. A second copy of
 * these checks in the email route is how the two would come to disagree about who may reset whom.
 *
 *   1. Deleted → 409. There is nobody to let back in.
 *   2. Switched off → 409. A password would not let them in, and the message names the missing step.
 *   3. Somebody else at or above the actor's level → 403. ALLOWED ON YOUR OWN ACCOUNT: `canManageUser`
 *      refuses self by design, but issuing yourself a link is not an escalation.
 *
 * Pure, so `tests/security/password-reset-email.test.ts` can pin it without a request or a database.
 * The capability itself (`canManageUsers`) is checked first, by `requireCapability` in each route.
 */
export function resetRefusal(
  actor: PermissionSubject & { id: string },
  target: Pick<ResetTarget, "id" | "name" | "role" | "isActive" | "deletedAt">,
  delivery: ResetDelivery
): ApiError | null {
  const then = delivery === "link" ? "then make a link" : "then email them a link";
  if (target.deletedAt) {
    return conflict(
      `That account has been deleted, so there is nobody to let back in. Restore it first, ${then}.`
    );
  }
  if (!target.isActive) {
    // Refused rather than issued. A link that sets a password on an account which cannot sign in sends
    // somebody through the whole exercise to be refused at the door, and it is not obvious to them why.
    return conflict(
      `${target.name}'s account is switched off, so a new password would not let them in. Switch the account back on first, ${then}.`
    );
  }
  if (target.id !== actor.id && !canManageUser(actor, { id: target.id, role: target.role })) {
    return forbidden(
      delivery === "link"
        ? "You cannot make a password link for this person, because they are at the same level of access as you or above it. Only somebody with more access than they have can do it."
        : "You cannot email a password link to this person, because they are at the same level of access as you or above it. Only somebody with more access than they have can do it."
    );
  }
  return null;
}

async function countActiveSessions(userId: string): Promise<number> {
  return prisma.session.count({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }
  });
}

/**
 * Everything an administrator's reset DOES besides minting the link, identically for both deliveries:
 * the audit entry, the cleared sign-in throttle, and — ⚠ — every session revoked. Returns how many
 * sessions were live, which the screen prints.
 *
 * ⚠ CALLED ONLY AFTER THE LINK HAS REACHED SOMEBODY. For "make a link" that is the response itself; for
 * "email" it is a send SES accepted. Revoking first and then failing to send would sign the person out of
 * everything and leave them no way back in.
 */
export async function recordAdminReset(
  context: AuditContext,
  target: Pick<ResetTarget, "id" | "name" | "email" | "passwordHash">,
  details: { expiresAt: Date; emailed: boolean }
): Promise<number> {
  const sessionsEnded = await countActiveSessions(target.id);

  await mutateWithHistory<{ id: string }>(
    context,
    {
      action: "PERMISSION_CHANGE",
      entityType: "User",
      entityLabel: `${target.name} <${target.email}>`,
      revise: false,
      /**
       * METADATA ONLY. The token is a credential, and an audit log is read by more people than the users
       * table is and gets exported. `redact()` in lib/audit.ts strips secrets by NAME and would not catch
       * this one, so it simply never goes in. `emailed` says which button was pressed.
       */
      before: {
        activeSessions: sessionsEnded,
        hadPassword: target.passwordHash !== null,
        linkExpiresAt: details.expiresAt,
        ...(details.emailed ? { emailed: true } : {})
      }
    },
    async (tx) =>
      tx.user.update({
        where: { id: target.id },
        // The sign-in throttle is cleared: a link is asked for because somebody cannot get in, and
        // eight failed attempts followed by a fifteen-minute lock is usually why they asked.
        data: { failedLogins: 0, lockedUntil: null },
        select: { id: true }
      })
  );

  // This is not tidying up; it is half of what a reset means. See the make-a-link route's header.
  await revokeAllSessionsForUser(target.id);
  return sessionsEnded;
}

/** Why an email was not sent, as a sentence an administrator can act on. Never contains an address. */
function sendFailureSentence(error: unknown): string {
  if (error instanceof MailSendError && error.disposition === "halt") {
    return (
      `Amazon SES refused to send it (${error.code}) — usually the sending address is not verified yet, or ` +
      "the account is still in the SES sandbox and this recipient is not a verified address."
    );
  }
  if (error instanceof MailSendError) return `Amazon SES did not accept it (${error.code}).`;
  return "The mail service could not be reached.";
}

/**
 * "Email them a password link": mint, SEND IMMEDIATELY through SES, and only then record and revoke.
 *
 * NEVER SILENT. No sender configured → 503 that says so; a send that fails → 502 that says so; both
 * suggest "Make a password link" instead, and in both NOTHING about the account has changed — no
 * sessions revoked, no throttle cleared. A failed attempt is still audited, because "I sent it" / "it
 * never arrived" is exactly the conversation the log has to settle.
 */
export async function emailResetLinkToAccount(
  context: AuditContext,
  target: ResetTarget
): Promise<{ expiresAt: Date; sessionsEnded: number }> {
  const mailer = activeAuthMailer();
  if (!mailer) {
    throw new ApiError(
      503,
      "Email is not set up on this site, so nothing was sent and nothing about the account has changed. Use " +
        "“Make a password link” instead and pass the link on yourself.",
      { code: "email_not_configured" }
    );
  }

  const { link, expiresAt } = issueCredentialLink({
    userId: target.id,
    passwordHash: target.passwordHash,
    purpose: "reset"
  });
  const message = renderPasswordResetEmail({
    name: target.name,
    link,
    ttlHours: RESET_TTL_HOURS,
    requestedBy: "administrator"
  });

  try {
    await mailer.send({
      to: target.email,
      subject: message.subject,
      bodyText: message.text,
      bodyHtml: message.html,
      tag: "password-reset"
    });
  } catch (error) {
    const sentence = sendFailureSentence(error);
    await recordEvent(context, {
      action: "PERMISSION_CHANGE",
      entityType: "User",
      entityId: target.id,
      entityLabel: `${target.name} <${target.email}>`,
      after: {
        event: "password-link-email-failed",
        error: error instanceof MailSendError ? error.code : "unknown"
      }
    });
    throw new ApiError(
      502,
      `The password link could not be emailed to ${target.email}. ${sentence} Nothing about the account has ` +
        "changed. Use “Make a password link” instead and pass the link on yourself.",
      { code: "email_failed" }
    );
  }

  const sessionsEnded = await recordAdminReset(context, target, { expiresAt, emailed: true });
  return { expiresAt, sessionsEnded };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The self-service door — "Forgot your password?"
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE ONLY ANSWER the forgot-password endpoint ever gives to a well-formed request — for a real account,
 * an unknown address, a switched-off account, an account with no password, a throttled address, a send
 * that failed and a site with no email at all. Distinguishing any of them would turn the form into a
 * directory of who has a studio account, and the Centre's staff list is public.
 *
 * ⚠ IT DOES NOT MENTION TWO-STEP VERIFICATION, and must not: whether an account has a second factor is
 * not something to tell a stranger who typed its address.
 */
export const FORGOT_PASSWORD_MESSAGE =
  "If that address belongs to a studio account that signs in with a password, a link to set a new password " +
  `is on its way. It works once and lasts ${RESET_TTL_HOURS} hours. If nothing arrives within a few minutes, ` +
  "check your spam folder, or ask an administrator to make you a link.";

/** What happened, for the audit log and the tests. Never shown to the person who asked. */
export type PasswordResetOutcome =
  | "emailed"
  | "unknown-address"
  | "inactive"
  | "no-password"
  | "address-rate-limited"
  | "email-not-configured"
  | "email-failed";

/**
 * The audit row a "Forgot your password?" request writes: its entity type, and the label built from the
 * typed address.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ NOT `PERMISSION_CHANGE`. This row is written for every ANONYMOUS request, for any address anybody
 * types, and the request changes nobody's access. Recorded as a permission change (as it first was), it
 * made the audit log say "Changed what somebody is allowed to do" in red and the dashboard say
 * "Somebody changed what one person is allowed to do — director@…" — a stranger could forge that line
 * about any real account, five times a quarter hour per connection, burying the genuine permission
 * changes and polluting the one filter used to investigate them.
 *
 * So it is what it is: an anonymous `CREATE` of a `PasswordResetRequest`, the shape the public contact
 * form already uses for an enquiry (`CREATE` of a `ContactSubmission`, no actor). Both screens render it
 * from their existing generic rules, with no change to their maps (which another piece of work owns):
 *
 *   • audit log  — "Created · a password-link request for asha@… · password reset request";
 *   • dashboard  — "Somebody created a password-link request for asha@…".
 *
 * `entityId` is null on purpose: the entity is the REQUEST, which has no table, and a User id in that
 * column would claim the row is about a User (and the audit screen joins `entityId` to accounts). The
 * account that matched, when one did, is `after.accountId` — readable by an investigator, ignored by
 * everything that joins on `entityId`. The label and `after.email` carry the typed address, the same
 * address-plus-IP record a refused sign-in keeps (owner decision, e4ec8e5).
 *
 * A dedicated `AuditAction` (say `PASSWORD_RESET_REQUESTED`) would read better still, but it needs a
 * migration and a new entry in the TOTAL action maps of app/studio/audit/page.tsx and app/studio/page.tsx;
 * it is a follow-up for whoever owns those screens, and this row's shape is what it would replace.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const PASSWORD_RESET_REQUEST_ENTITY = "PasswordResetRequest";

/** The row's label: reads as the object of "created" on both screens. `email` is already normalised. */
export function passwordResetRequestLabel(email: string): string {
  return `a password-link request for ${email}`;
}

/** Derived once; see `addressBucket`. */
let addressBucketKey: Buffer | null = null;

/**
 * The per-ADDRESS bucket key: an HMAC of the normalised address, keyed by a subkey of `JWT_SECRET`.
 *
 * KEYED, NOT A PLAIN HASH. Addresses are low-entropy and the Centre's staff list is public, so an unsalted
 * SHA-256 (as this first was) is reversed by hashing the staff list — and once a shared limiter store
 * (the Redis adapter lib/ratelimit.ts is ready for) is plugged in, those keys are readable by whoever can
 * read the store. Keyed, they are opaque to anybody
 * without the app secret, which is what "the limiter is not a list of addresses" actually needs.
 *
 * The subkey is `HMAC(JWT_SECRET, label)` rather than `JWT_SECRET` itself, so this value can never be
 * mistaken for (or collide with) a credential-token signature made with the same secret. Rotating
 * `JWT_SECRET` simply starts every address with a fresh bucket, which is harmless.
 */
export function addressBucket(email: string): string {
  addressBucketKey ??= createHmac("sha256", authEnv().secret)
    .update("cxa:rate-limit:password-reset-address:v1")
    .digest();
  const digest = createHmac("sha256", addressBucketKey).update(email).digest("hex").slice(0, 32);
  return `auth:password-reset:address:${digest}`;
}

/**
 * Handle one "Forgot your password?" request, after the response has been decided. NEVER THROWS.
 *
 *   1. Only an ACTIVE, undeleted account that HAS A PASSWORD gets mail. An account with none signs in with
 *      a provider or has not claimed its invitation; an administrator can still make it a link.
 *   2. The per-ADDRESS limit (`RATE_LIMITS.passwordResetAddress`), consumed ONLY for such an account —
 *      i.e. only when a message is about to be sent. The per-IP limit is the route's, and answers 429
 *      because it reveals nothing about any account; this one is SILENT — answering 429 for a throttled
 *      address would say the address had been tried, and the answer must not vary. It stops one person's
 *      inbox being flooded from many connections.
 *      Counting only mailable accounts means typing unknown addresses fills no buckets, and the limit
 *      measures exactly what it protects (emails sent). Looking the account up first reveals nothing:
 *      all of this runs after the one answer has gone (`deferUntilAfterResponse`).
 *      ⚠ KNOWN LIMITATION, INHERENT TO ANY PER-TARGET LIMIT: whoever knows a colleague's address can use
 *      up that colleague's three an hour, again every hour, and the colleague's own request is then
 *      silently not mailed (they still see "a link is on its way"). The way round it is an
 *      administrator's "Make a password link" / "Email them a password link", which this limit does not
 *      touch, and the audit log shows the `address-rate-limited` rows and the IPs that caused them.
 *      docs/SIGN-IN.md says so.
 *   3. Sent IMMEDIATELY through SES (lib/auth/auth-mail.ts) — not the newsletter outbox.
 *   4. EVERY request is audited, unknown addresses included, with the typed address in the label and in
 *      `after.email`, its keyed fingerprint and domain beside it, and the real client IP on the row (owner
 *      decision, e4ec8e5 — docs/AUDIT-PRIVACY.md) — as an anonymous `CREATE` of a `PasswordResetRequest`,
 *      NEVER a `PERMISSION_CHANGE`: see `PASSWORD_RESET_REQUEST_ENTITY` for why.
 *
 * ⚠ WHAT A REQUEST DELIBERATELY DOES **NOT** DO, unlike the administrator's reset: it revokes no session
 * and clears no sign-in throttle. Anybody can type anybody's address here. If asking were enough to sign
 * somebody out of every device, this form would be a way for a stranger to do that to the whole staff
 * list on a loop — and clearing the throttle would hand a password-guesser a fresh eight attempts per
 * request. The sessions ARE revoked when the link is USED, by the set-password route, which is the moment
 * the person has proved they hold the mailbox.
 */
export async function requestPasswordReset(input: {
  email: string;
  context: AuditContext;
}): Promise<PasswordResetOutcome> {
  const email = input.email.trim().toLowerCase();
  let outcome: PasswordResetOutcome = "unknown-address";
  let userId: string | null = null;
  let linkExpiresAt: Date | null = null;
  let errorCode: string | null = null;

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true, isActive: true, deletedAt: true, passwordHash: true }
    });
    userId = user?.id ?? null;

    if (!user || user.deletedAt) {
      outcome = "unknown-address";
    } else if (!user.isActive) {
      outcome = "inactive";
    } else if (user.passwordHash === null) {
      outcome = "no-password";
    } else if (!(await consumeRateLimitAsync(addressBucket(email), RATE_LIMITS.passwordResetAddress)).ok) {
      // Step 2: counted here and only here — for an account that would actually be mailed.
      outcome = "address-rate-limited";
    } else {
      const mailer = activeAuthMailer();
      if (!mailer) {
        outcome = "email-not-configured";
      } else {
        // Bound to the hash read a moment ago — see `issueCredentialLink` on why it must be fresh.
        const { link, expiresAt } = issueCredentialLink({
          userId: user.id,
          passwordHash: user.passwordHash,
          purpose: "reset"
        });
        const message = renderPasswordResetEmail({
          name: user.name,
          link,
          ttlHours: RESET_TTL_HOURS,
          requestedBy: "self"
        });
        try {
          await mailer.send({
            to: user.email,
            subject: message.subject,
            bodyText: message.text,
            bodyHtml: message.html,
            tag: "password-reset"
          });
          outcome = "emailed";
          linkExpiresAt = expiresAt;
        } catch (error) {
          outcome = "email-failed";
          errorCode = error instanceof MailSendError ? error.code : "unknown";
          // By code only: a provider message can quote the address (see `scrubAddresses`).
          console.warn(`[auth-mail] a password-reset email was not sent (${errorCode}).`);
        }
      }
    }
  } catch (error) {
    // A database or limiter fault. The person has already been given the one answer; what matters now is
    // that the fault is visible to an operator and recorded below.
    console.error("[auth] a password-reset request could not be processed", (error as Error)?.name);
    outcome = "email-failed";
    errorCode = errorCode ?? "internal";
  }

  // Step 4. ⚠ Not PERMISSION_CHANGE, and no User id in `entityId` — see `PASSWORD_RESET_REQUEST_ENTITY`.
  await recordEvent(input.context, {
    action: "CREATE",
    entityType: PASSWORD_RESET_REQUEST_ENTITY,
    entityId: null,
    entityLabel: passwordResetRequestLabel(email),
    after: {
      email,
      ...(userId ? { accountId: userId } : {}),
      ...attemptedAddress(email),
      event: "password-reset-requested",
      via: "forgot-password",
      outcome,
      ...(linkExpiresAt ? { linkExpiresAt } : {}),
      ...(errorCode ? { error: errorCode } : {})
    }
  });

  return outcome;
}

/**
 * Work started by `deferUntilAfterResponse` outside a request (the tests), so they can wait for it.
 * Empty in production, where Next's `after()` owns the work.
 */
const outsideRequest = new Set<Promise<void>>();

/**
 * Run `work` AFTER the response has been sent — which is what makes a known and an unknown address take
 * the same time to answer.
 *
 * The difference between the two paths is a database read and, for a real account, a round trip to
 * Amazon SES that can take hundreds of milliseconds. Done before answering, that is a stopwatch
 * enumeration oracle no matter how carefully the words match. Done in `after()` (which Vercel keeps alive
 * with `waitUntil`), the response is the same bytes at the same speed for every address.
 *
 * Outside a request scope `after()` throws; the work is then started at once without being awaited, and
 * `settleDeferredPasswordResets()` lets a test wait for it. ⚠ The work must never throw —
 * `requestPasswordReset` does not.
 */
export function deferUntilAfterResponse(work: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await work();
    } catch (error) {
      console.error("[auth] deferred password-reset work failed", (error as Error)?.name);
    }
  };
  try {
    after(run);
    return;
  } catch {
    // Not inside a request — see above.
  }
  const pending = run();
  outsideRequest.add(pending);
  void pending.finally(() => outsideRequest.delete(pending));
}

/** For the tests: wait until every reset started outside a request has finished. */
export async function settleDeferredPasswordResets(): Promise<void> {
  while (outsideRequest.size > 0) await Promise.all([...outsideRequest]);
}
