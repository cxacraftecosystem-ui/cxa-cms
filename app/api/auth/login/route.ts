import type { NextRequest } from "next/server";
import type { User } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  ApiError,
  assertSameOrigin,
  clientIp,
  forbidden,
  ok,
  parseJson,
  route,
  unauthorized,
  userAgent
} from "@/lib/api";
import { createSession, markSignedIn, verifyCredentials } from "@/lib/auth/session";
import {
  ACCESS_REFUSED_MESSAGE,
  describeRefusal,
  markGrantUsed,
  resolveAccess
} from "@/lib/auth/access";
import { verifyPassword } from "@/lib/auth/password";
import { canonicalRecoveryCode, decryptSecret, verifyTotp } from "@/lib/auth/totp";
import { applySession } from "@/lib/auth/respond";
import { recordEvent, type AuditContext } from "@/lib/audit";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/ratelimit";

/**
 * Sign in.
 *
 * FOUR THINGS THIS ROUTE IS CAREFUL ABOUT, all of them about what an answer reveals:
 *
 *  1. **One message for a wrong email and a wrong password.** A staff directory is public; the login
 *     form must not confirm which of those addresses can sign in. `verifyCredentials` already pays
 *     the hashing cost for an unknown address so the two also take the same time.
 *  2. **A missing second factor answers 200, not 401.** `{ twoFactorRequired: true }` is not a
 *     failure — the password was right and the form now needs one more thing. Answering 401 would be
 *     indistinguishable from a wrong password, and the form could not tell the reader what to do
 *     next.
 *  3. **The password never reaches the audit log.** A failed attempt records the attempted address
 *     and nothing else. An audit log is read by more people than the users table is, and it is
 *     exported.
 *  4. **The studio allow-list is consulted LAST, not first** — see the block that calls
 *     `resolveAccess` below. Authentication answers "who is this?"; authorisation answers "should
 *     they be here?", and asking the second question before the first is what would turn this form
 *     into a directory of who works at the Centre.
 */

export const dynamic = "force-dynamic";

const LoginBody = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address.")
    .max(320)
    .email("That does not look like an email address."),
  password: z.string().min(1, "Enter your password.").max(200),
  /**
   * The six digits from an authenticator app. The form may put a recovery code in this same box —
   * see `looksLikeRecoveryCode` — so a reader who has lost their phone does not have to find a
   * second field first.
   */
  totp: z.string().trim().max(64).optional(),
  /** A separate box, for a form that offers one. Either field is accepted. */
  recoveryCode: z.string().trim().max(64).optional()
});

/** The single answer to a wrong address and a wrong password. */
const CREDENTIALS_MESSAGE = "That email address and password do not match. Check both and try again.";

const SECOND_FACTOR_MESSAGE =
  "That verification code is not right. Check the current code in your authenticator app, or enter one of your recovery codes.";

/**
 * Could this string be a recovery code at all?
 *
 * `generateRecoveryCodes` emits ten hexadecimal characters in two groups, so a six-digit string
 * never is one. The check exists to keep a mistyped authenticator code from paying for ten bcrypt
 * comparisons — at cost 12 that is several seconds of server time for a value that could not
 * possibly match.
 */
function looksLikeRecoveryCode(input: string): boolean {
  return /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(input);
}

/**
 * Verify a recovery code and CONSUME it.
 *
 * The removal is a compare-and-swap: the update only applies if the stored array is still exactly
 * what we read, so two requests presenting the same code cannot both succeed, and a concurrent
 * change cannot be overwritten with a stale copy of the list that would resurrect a spent code. A
 * plain "read, filter, write" is atomic per statement but not across the read, which is the gap that
 * makes a single-use code usable twice.
 *
 * The loop stops at the first match. Unlike a password comparison, an early exit here reveals only
 * how many unrelated codes preceded the matching one, which tells an attacker who already holds a
 * valid code nothing they can use.
 */
async function consumeRecoveryCode(user: User, submitted: string): Promise<boolean> {
  const canonical = canonicalRecoveryCode(submitted);
  const stored = user.twoFactorRecoveryCodes;

  let matched: string | null = null;
  for (const hash of stored) {
    if (await verifyPassword(canonical, hash)) {
      matched = hash;
      break;
    }
  }
  if (matched === null) return false;

  const remaining = stored.filter((hash) => hash !== matched);
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, twoFactorRecoveryCodes: { equals: stored } },
    data: { twoFactorRecoveryCodes: remaining }
  });
  return count === 1;
}

/** The session shape the studio renders from. Matches `SessionUser` in lib/auth/current-user.ts. */
function toSessionUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarId: user.avatarId,
    canPublish: user.canPublish,
    canManageMedia: user.canManageMedia,
    twoFactorEnabled: user.twoFactorEnabled
  };
}

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  /**
   * RATE LIMIT BEFORE READING THE BODY, and before any database work.
   *
   * ⚠ NOT REDUNDANT WITH THE PER-ACCOUNT LOCKOUT in lib/auth/session.ts. That locks one account after
   * eight consecutive failures, which stops somebody grinding at one person's password. It does nothing
   * about the attack that actually happens to an institution whose staff directory is public:
   * CREDENTIAL STUFFING — one guess against each of two hundred known addresses, where no single account
   * ever reaches its own threshold and nothing anywhere counts the sweep.
   *
   * Placing it first also means a flood costs one map lookup rather than a bcrypt comparison. At cost 12
   * that is ~250ms of CPU per attempt, so an unthrottled login endpoint is a denial-of-service vector
   * against the whole application quite apart from being a guessing oracle.
   */
  const limited = enforceRateLimit(
    request,
    "auth/login",
    RATE_LIMITS.login,
    (phrase) => `Too many sign-in attempts from this connection. Try again ${phrase}.`
  );
  if (limited) return limited;

  const body = await parseJson(request, LoginBody);

  const email = body.email.toLowerCase();
  const context: AuditContext = {
    actor: null,
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };

  const result = await verifyCredentials(email, body.password);

  if (!result.ok) {
    await recordEvent(context, {
      action: "LOGIN_FAILED",
      entityType: "User",
      entityLabel: email,
      // The attempted address and the reason. Never the password, and never a hint of it.
      after: { email, reason: result.reason }
    });

    if (result.reason === "locked") {
      const minutes = result.retryAfterMinutes ?? 15;
      throw new ApiError(
        429,
        `Too many sign-in attempts on this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        { code: "rate_limited" }
      );
    }
    if (result.reason === "inactive") {
      throw forbidden("This account has been deactivated. An administrator can restore your access.");
    }
    throw unauthorized(CREDENTIALS_MESSAGE);
  }

  const user = result.user;
  let method: "password" | "authenticator" | "recovery code" = "password";

  if (user.twoFactorEnabled) {
    const submittedCode = (body.totp ?? "").trim();
    const submittedRecovery = (body.recoveryCode ?? "").trim();

    if (!submittedCode && !submittedRecovery) {
      // 200 with no session. See point 2 in the header comment.
      return ok({ twoFactorRequired: true });
    }

    /**
     * A SECOND, TIGHTER LIMIT for the second factor.
     *
     * Reaching this line means the password was already correct, so an attacker here is guessing a
     * six-digit code — one chance in a million per attempt, and every reason to keep going. The
     * `login` bucket above is sized for a person mistyping a password and is too generous for this.
     *
     * ⚠ The `failedLogins` bump below is NOT a throttle and the comment there says so: it is reset
     * whenever the password is right, so an attacker who holds the password resets it on every
     * attempt. This limit is what actually bounds the guessing, and it is keyed per IP rather than
     * per account so it cannot be reset by anything the attacker controls.
     */
    const secondFactorLimited = enforceRateLimit(
      request,
      "auth/login/second-factor",
      RATE_LIMITS.secondFactor,
      (phrase) => `Too many verification attempts. Try again ${phrase}.`
    );
    if (secondFactorLimited) return secondFactorLimited;

    let verified = false;

    if (submittedCode && user.twoFactorSecret) {
      // An undecryptable secret means this account's 2FA is broken rather than that the code is
      // wrong — but it must not open the door either. The recovery path below is the way back in,
      // which is exactly what recovery codes are for.
      const secret = decryptSecret(user.twoFactorSecret);
      if (secret && verifyTotp(secret, submittedCode)) {
        verified = true;
        method = "authenticator";
      }
    }

    if (!verified) {
      const candidates = [submittedRecovery, submittedCode].filter(
        (candidate) => candidate.length > 0 && looksLikeRecoveryCode(candidate)
      );
      for (const candidate of candidates) {
        if (await consumeRecoveryCode(user, candidate)) {
          verified = true;
          method = "recovery code";
          break;
        }
      }
    }

    if (!verified) {
      // The counter is bumped so an administrator can see the account being probed on the users
      // screen. It is deliberately NOT the throttle: `verifyCredentials` resets it whenever the
      // password is right, so somebody who holds the password clears it on every attempt. The
      // per-IP `secondFactor` limit above is what actually bounds the guessing, because nothing the
      // attacker controls can reset it. This bump and the audit event are the DETECTION surface.
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: { increment: 1 } }
      });
      await recordEvent(context, {
        action: "LOGIN_FAILED",
        entityType: "User",
        entityId: user.id,
        entityLabel: email,
        after: { email, reason: "second-factor" }
      });
      throw unauthorized(SECOND_FACTOR_MESSAGE);
    }
  }

  /**
   * THE STUDIO ALLOW-LIST — AND IT IS CHECKED HERE, NOT AT THE TOP OF THE HANDLER.
   *
   * ⚠ THE POSITION IS THE WHOLE POINT. Checking the list before the password would make this form an
   * oracle for who is on it: an address with no grant would be refused instantly, without a bcrypt
   * comparison and with a different sentence, while a listed address with a wrong password would take
   * ~250ms and say something else. Anybody could then sort the public staff directory into "has studio
   * access" and "does not", which is the shortlist a phishing campaign is built from. Verifying the
   * credentials first means both journeys do exactly the same work and end at the same wall.
   *
   * By this line the password — and any second factor — is already correct, so the only remaining
   * question is whether this person is allowed in at all. The same call, with the same refusal, is
   * made by the OAuth callback: a provider proves an identity and never grants access.
   *
   * `existingUser` enables the grace path in lib/auth/access.ts. `verifyCredentials` has already
   * refused a deactivated or deleted account, so passing `user` here admits an active account whose
   * grant is missing — an installation that predates the allow-list, or one whose backfill has not run
   * — rather than locking an institution out of its own CMS on the morning of an upgrade. A REVOKED
   * grant is still a refusal: that is a decision somebody made, not a gap.
   */
  const access = await resolveAccess({
    email: user.email,
    provider: "PASSWORD",
    existingUser: user
  });

  if (!access.ok) {
    // The specific reason goes HERE, where the people who can act on it will read it. The reader gets
    // `ACCESS_REFUSED_MESSAGE`, which is identical for every reason — see lib/auth/access.ts.
    await recordEvent(context, {
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user.id,
      entityLabel: user.email,
      after: {
        email: user.email,
        reason: "access-refused",
        detail: describeRefusal(access.reason),
        provider: "PASSWORD"
      }
    });
    // 403, not 401: the credentials were right. A 401 would tell the form to ask for them again, and
    // the reader would retype a password that was never the problem.
    throw forbidden(ACCESS_REFUSED_MESSAGE);
  }

  const session = await createSession({
    userId: user.id,
    userAgent: userAgent(request),
    ipAddress: clientIp(request)
  });

  // Only NOW is this a sign-in. `verifyCredentials` deliberately leaves `lastLoginAt` alone, because a
  // correct password on a 2FA account can still end with no session — and a timestamp that records
  // attempts tells the account's owner they signed in when they did not.
  await markSignedIn(user.id);

  // "Last used" on the grant, which is the figure that makes an access list prunable — a list nobody
  // can tell is stale is a list nobody dares tidy. Never throws; see `markGrantUsed`. There is no grant
  // to stamp on the grace path, which is exactly the state the audit entry below records.
  if (access.grant) await markGrantUsed(access.grant.id, "PASSWORD");

  // `twoFactorRequired: false` is stated rather than omitted, so the form reads one field to tell
  // the challenge from the success instead of inferring it from a missing key.
  const response = ok({ twoFactorRequired: false, user: toSessionUser(user) });
  await applySession(response, user, session);

  await recordEvent(
    { ...context, actor: { id: user.id, email: user.email } },
    {
      action: "LOGIN",
      entityType: "User",
      entityId: user.id,
      entityLabel: user.email,
      // `admittedWithoutGrant` is recorded rather than inferred, under the same name the OAuth callback
      // uses, so one query answers "who has been getting in on the grace path?" across both doors. It
      // is a sign-in an administrator should follow up by writing the grant, and a server-console
      // warning nobody tails is not where that belongs.
      after: { method, provider: "PASSWORD", admittedWithoutGrant: access.viaGrace }
    }
  );

  return response;
});
