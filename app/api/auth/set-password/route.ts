import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, assertSameOrigin, clientIp, ok, parseJson, route, userAgent } from "@/lib/api";
import { mutateWithHistory, recordEvent, type AuditContext } from "@/lib/audit";
import {
  ACCESS_REFUSED_MESSAGE,
  describeRefusal,
  markGrantUsed,
  resolveAccess
} from "@/lib/auth/access";
import {
  credentialFingerprintMatches,
  verifyCredentialToken
} from "@/lib/auth/credential-token";
import { hashPassword, passwordProblems } from "@/lib/auth/password";
import { applySession, clearSession } from "@/lib/auth/respond";
import { createSession, markSignedIn, revokeAllSessionsForUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/ratelimit";

/**
 * Claim an account: set a password using an invitation or password link.
 *
 * This is the endpoint behind `app/studio/set-password`, and between them they are the ONLY way an
 * invited colleague can ever sign in. `app/api/studio/users/route.ts` creates an invited account with
 * `passwordHash: null` and hands back a link; without this route that link went nowhere and the
 * account could never be claimed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * SEVEN RULES. NONE OF THEM IS OPTIONAL.
 *
 * 1. THE FINGERPRINT CHECK IS WHAT MAKES THE LINK SINGLE-USE. The token carries a short digest of the
 *    account's `passwordHash` at the moment it was minted (`credentialFingerprint`). Setting a password
 *    changes the hash, so the digest no longer matches and a replayed link is refused — with no table
 *    to mark as spent, no job to expire rows, and no window in which a used link still works. A caller
 *    that verified only the signature and the expiry would have built a link that works for ever.
 *
 * 2. ONE REFUSAL, ONE SENTENCE, FOR EVERY TOKEN FAILURE. A forged token, an expired one, an unknown
 *    account, a switched-off account and an already-used link all answer the same thing. This endpoint
 *    is unauthenticated, so a message that distinguished "no such account" from "wrong token" would be
 *    an account-existence oracle — and this institution's staff directory is public, so that oracle
 *    would be pointed at a list of real addresses. The SCREEN is allowed to be more specific, because
 *    it only becomes specific once a valid signature has proved the visitor holds a link this
 *    installation issued.
 *
 * 3. RATE LIMITED. The token is the credential here, so this is the one endpoint where guessing a
 *    signature is the attack. It is also the only place in the application that will hash a password
 *    on behalf of somebody with no session, and bcrypt at cost 12 is ~250 ms of server time per call.
 *
 * 4. EVERY EXISTING SESSION IS REVOKED BEFORE A NEW ONE IS ISSUED. A link that sat in an inbox may have
 *    been read by somebody else, and the person setting a password now is entitled to assume they are
 *    the only one in the account afterwards. The order matters: revoking after `createSession` would
 *    kill the session just issued and sign the reader straight back out.
 *
 * 5. ⚠ AN ACCOUNT WITH A SECOND FACTOR IS **NOT** SIGNED IN HERE. This is a deliberate departure from
 *    "set the password, then sign them in like the login route does", and the reason is that the login
 *    route demands a code from the authenticator app before it will issue a session. Signing somebody
 *    in straight from a password link would make every password link a way round two-step verification
 *    — an administrator issuing a reset would be handing out a second-factor bypass, which is exactly
 *    what the second factor is bought to prevent. So the password is set, every session is revoked, and
 *    the answer says `signedIn: false`; the screen sends them to sign in and present their code. The
 *    second factor is left completely alone: clearing it here would be the same bypass by another name.
 *
 * 6. THE ACTOR IN THE AUDIT ENTRY IS THE PERSON THEMSELVES. Nobody else was present. Filing it against
 *    the administrator who issued the link would say they set the password, which is the one claim this
 *    whole design exists to make untrue.
 *
 * 7. ⚠ THE STUDIO ACCESS LIST IS CONSULTED BEFORE ANY SESSION IS ISSUED, exactly as the login route and
 *    the OAuth callback do. This rule was MISSING and the route was a way in around the allow-list: an
 *    invitation creates the `User` row but no grant (see `app/api/studio/users/route.ts`, which writes
 *    none), so an invited colleague was normally not on the list at all — and yet this route handed back
 *    live cookies, after which their next ordinary sign-in was refused 403 by the very list this door had
 *    ignored. One account, admitted here and refused there. The same gap admitted somebody whose grant
 *    had been revoked while an unused link was still in their inbox, which is precisely the case the
 *    access screen promises revoking will stop. Authorisation is a separate question from authentication
 *    and holding a link only answers the second one.
 *
 *    The password is still SET when the list refuses, and deliberately: the fingerprint in rule 1 is what
 *    makes the link single-use, so leaving the hash untouched would leave a working link in circulation
 *    for an account somebody has already decided may not sign in. What is withheld is the session.
 *
 * NOTHING SECRET IS RETURNED. The response carries no user row at all — only what happened and what to
 * do next — so there is nothing to keep out of it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The limit lives in `RATE_LIMITS.setPassword` (lib/ratelimit.ts), NOT here.
 *
 * An earlier version of this file declared its own local constant on the reasoning that the numbers are
 * quoted nowhere else. That reasoning is wrong in the way that matters: `RATE_LIMITS` is where somebody
 * tuning the site's throttles looks, and a policy that is not in it is a policy that will not be found
 * when the others are reviewed — so it drifts by being forgotten rather than by being edited.
 *
 * ⚠ The limiter is per process and is a speed bump, not a guarantee — its own header explains why, and
 * nothing here rests on it: the token SIGNATURE is what actually refuses a guess.
 */

/** See rule 2. Every token failure answers with this, and only this. */
const REFUSED =
  "This link cannot be used to set a password. It may have expired, or it may already have been used — a " +
  "link stops working the moment a password is set. Ask an administrator for a new one.";

function refused(): ApiError {
  return new ApiError(400, REFUSED, { code: "invalid_credential_link" });
}

const Body = z.object({
  token: z
    .string()
    .trim()
    .min(1, "This page was opened without a link code, so there is nothing to check.")
    .max(1024, "That link code is too long to be one this site issued."),
  /**
   * The cap is a shape guard, not the policy. `passwordProblems` owns every rule a reader can act on
   * (including the 200-character ceiling) and its sentences are what the form prints; refusing at 400
   * here only stops a megabyte of text being hashed.
   */
  password: z
    .string()
    .min(1, "Choose a password.")
    .max(400, "That password is far longer than 200 characters. Shorten it.")
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const limited = enforceRateLimit(
    request,
    "auth:set-password",
    RATE_LIMITS.setPassword,
    (phrase) =>
      `Too many attempts to set a password from this connection. Try again in ${phrase}. If you have run out of ` +
      "attempts by mistake, an administrator can send you a fresh link."
  );
  if (limited) return limited;

  const body = await parseJson(request, Body);

  // Signature, shape and expiry. See `verifyCredentialToken`: it deliberately does NOT check the
  // fingerprint, because that needs the account's current hash — which is the next step.
  const verdict = verifyCredentialToken(body.token);
  if (!verdict.ok) throw refused();

  const user = await prisma.user.findUnique({
    where: { id: verdict.payload.sub },
    // Explicit, and short. `passwordHash` is here for the fingerprint comparison and for nothing else;
    // `twoFactorSecret` and `twoFactorRecoveryCodes` are not selected at all, because this route has no
    // business with either.
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      deletedAt: true,
      passwordHash: true,
      twoFactorEnabled: true
    }
  });

  // ⚠ ONE ANSWER for all four of these. See rule 2 — separating them would confirm which addresses on
  // a public staff list have accounts here, and which of those are switched off.
  if (!user || !user.isActive || user.deletedAt) throw refused();
  if (!credentialFingerprintMatches(user.passwordHash, verdict.payload.cred)) throw refused();

  /**
   * The policy, from the one function that owns it.
   *
   * Every problem is returned, not just the first: a reader told "too short" who then discovers it also
   * contains a common word has been sent round the loop twice for one decision. The banner takes the
   * first sentence and `fieldErrors.password` carries them all, which is the shape the form reads.
   */
  const problems = passwordProblems(body.password);
  if (problems.length > 0) {
    throw new ApiError(422, problems[0] ?? "That password cannot be used.", {
      code: "validation_failed",
      fieldErrors: { password: problems }
    });
  }

  const passwordHash = await hashPassword(body.password);

  /**
   * Counted before anything is revoked, so the answer can say how many devices this signed out. A reader
   * who is setting a password because they think somebody else has been in the account needs that number.
   */
  const sessionsEnded = await prisma.session.count({
    where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } }
  });

  // Rule 6: the person themselves. Nobody else was here.
  const context: AuditContext = {
    actor: { id: user.id, email: user.email },
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };

  await mutateWithHistory<{ id: string }>(
    context,
    {
      action: "PERMISSION_CHANGE",
      entityType: "User",
      entityLabel: user.email,
      // No revision: a user row is not versioned content. The audit entry holds what changed.
      revise: false,
      /**
       * Facts about the change, never the change itself. `hadPassword` is what separates an invitation
       * being claimed from a password being reset — the two are the same act on a different account
       * state, and an administrator reading the log needs to tell them apart. `redact()` strips secret
       * columns by name as a backstop; naming nothing secret here is the control.
       */
      before: {
        hadPassword: user.passwordHash !== null,
        activeSessions: sessionsEnded,
        linkPurpose: verdict.payload.purpose
      }
    },
    async (tx) =>
      tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          // The throttle is cleared. Somebody arriving here has usually just failed to sign in several
          // times, and a fifteen-minute lock would block the password they have this second chosen.
          failedLogins: 0,
          lockedUntil: null
        },
        select: { id: true }
      })
  );

  // ⚠ Rule 4, and it must happen before `createSession`.
  await revokeAllSessionsForUser(user.id);

  /**
   * ⚠ Rule 7. The gate every other sign-in path goes through, asked here for the same reason and with
   * the same refusal.
   *
   * It is asked BEFORE the second-factor branch below, not after it, because the answer changes what
   * this person should be told: an account that may not sign in at all should not be sent off to find
   * its phone for a code that will get it no further. `existingUser` is passed so the grace path in
   * lib/auth/access.ts still admits an installation whose access list has not been populated yet — the
   * account has already been proved active and undeleted above, which is the condition grace rests on.
   *
   * ⚠ THIS TELLS THE READER NOTHING THEY DID NOT ALREADY KNOW. Rule 2's silence protects an anonymous
   * caller guessing at addresses; whoever is here has presented a valid signature over this account's
   * id, so naming the account's own state to them reveals nothing further — the same trade the login
   * route makes when it answers 403 after a correct password rather than pretending the password was
   * wrong.
   */
  const access = await resolveAccess({
    email: user.email,
    provider: "PASSWORD",
    existingUser: user
  });

  if (!access.ok) {
    // The specific reason goes to the audit log, where the people who can act on it read it; the
    // reader gets `ACCESS_REFUSED_MESSAGE`, which is the same sentence for every reason.
    await recordEvent(context, {
      action: "LOGIN_FAILED",
      entityType: "User",
      entityId: user.id,
      entityLabel: user.email,
      after: {
        email: user.email,
        reason: "access-refused",
        detail: describeRefusal(access.reason),
        provider: "PASSWORD",
        via: `password link (${verdict.payload.purpose})`
      }
    });

    const refusal = ok({
      signedIn: false,
      twoFactorRequired: false,
      sessionsEnded,
      // Both facts, because either alone misleads: the password really was changed, and it will still
      // not get them in. Saying only the first sends them to a sign-in screen that refuses them with no
      // idea why; saying only the second leaves them believing the link is still unspent.
      message:
        "Your password is set, and any device that was signed in has been signed out. " +
        ACCESS_REFUSED_MESSAGE
    });

    // The same reasoning as the second-factor branch below: no session is being issued, so a stale
    // cookie from whoever used this browser last must not be left in place to be mistaken for one.
    return clearSession(refusal);
  }

  /**
   * ⚠ Rule 5. A second factor means the password alone is not enough to get in, and that has to remain
   * true of a password set from a link.
   */
  if (user.twoFactorEnabled) {
    const challenge = ok({
      signedIn: false,
      twoFactorRequired: true,
      sessionsEnded,
      message:
        "Your password is set. This account also asks for a code from your authenticator app, so sign in " +
        "with your new password and have your phone to hand. Any device that was signed in has been signed out."
    });

    /**
     * ⚠ THE COOKIES ARE CLEARED, and this is not tidying up.
     *
     * A link may be opened on a shared machine where SOMEBODY ELSE is still signed in — the screen warns
     * about exactly that. In the branch below `applySession` overwrites their cookies, so the warning
     * comes true; here there is no session to put in their place, and without this the browser would
     * arrive at the sign-in screen still carrying the other person's identity, be redirected onward as
     * them, and the reader would conclude the password had not been set.
     */
    return clearSession(challenge);
  }

  const session = await createSession({
    userId: user.id,
    userAgent: userAgent(request),
    ipAddress: clientIp(request)
  });

  // Only NOW is this a sign-in — the same rule the login route follows. `markSignedIn` swallows its own
  // failures, so a bookkeeping write cannot turn a real session into a reported failure.
  await markSignedIn(user.id);

  // "Last used" on the grant, stamped by every door alike: a list whose figures only count one of the
  // ways in is a list nobody can safely prune. Never throws. There is no grant on the grace path, which
  // is the state the audit entry below records.
  if (access.grant) await markGrantUsed(access.grant.id, "PASSWORD");

  const response = ok({
    signedIn: true,
    twoFactorRequired: false,
    sessionsEnded,
    message:
      "Your password is set and you are signed in. Any other device that was signed in to this account has " +
      "been signed out."
  });
  await applySession(response, user, session);

  await recordEvent(context, {
    action: "LOGIN",
    entityType: "User",
    entityId: user.id,
    entityLabel: user.email,
    // Named so an account's history distinguishes this from an ordinary sign-in: it is the one entry
    // that explains a first-ever session on an invited account. `admittedWithoutGrant` is recorded
    // under the same name the login route and the OAuth callback use, so one query answers "who is
    // getting in on the grace path?" across every door rather than most of them.
    after: {
      method: `password link (${verdict.payload.purpose})`,
      provider: "PASSWORD",
      admittedWithoutGrant: access.viaGrace
    }
  });

  return response;
});
