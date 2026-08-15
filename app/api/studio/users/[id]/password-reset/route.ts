import type { NextRequest } from "next/server";
import { assertSameOrigin, conflict, forbidden, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import {
  RESET_TTL_HOURS,
  issueCredentialLink
} from "@/lib/auth/credential-token";
import { requireCapability } from "@/lib/auth/current-user";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { canManageUser, canManageUsers } from "@/lib/permissions";
import { buildAuditContext, found } from "@/lib/studio/crud";

/**
 * Give somebody a way to set a new password.
 *
 * Serves `POST /api/studio/users/{id}/password-reset`, called by "Make a password link" /
 * "Email a password link" in `app/studio/users/UserManager.tsx`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * NOBODY HERE SETS SOMEBODY ELSE'S PASSWORD. That is the whole design, and it has four parts.
 *
 * 1. NO PASSWORD IS GENERATED, RETURNED OR SENT. A password that has existed in a mailbox is a
 *    password that is no longer a secret, and one an administrator has seen makes "only you know your
 *    password" untrue for every account they touched. What is issued is a single-use, time-limited
 *    link that lets the person choose their own.
 *
 * 2. IT IS THE SAME LINK THE INVITATION USES — `issueCredentialLink` from
 *    `lib/auth/credential-token.ts`, pointing at the same `/studio/set-password` screen. One claim
 *    flow, not two: a second flow is a second thing to keep working, and the one nobody exercises is
 *    the one that is broken when it is finally needed.
 *
 * 3. THE LINK IS SINGLE-USE WITH NO TABLE BEHIND IT. It is bound to the account's CURRENT
 *    `passwordHash` through a short digest, so the moment a password is set the link stops verifying.
 *    `passwordHash` is therefore READ here — and only here, and only into that digest. It is never
 *    returned, never logged and never held in a variable that reaches a response.
 *
 * 4. ⚠ EVERY EXISTING SESSION IS REVOKED, AND THE RESPONSE SAYS SO. A reset is the answer to
 *    "somebody else may be able to get into my account". Leaving their sessions alive would change the
 *    lock and leave the intruder inside — that is not a reset. The client prints the message, because
 *    an administrator who does not know the person has been signed out cannot warn them.
 *
 * ALLOWED ON YOUR OWN ACCOUNT. `canManageUser` refuses self by design; issuing yourself a link to
 * change your own password is not an escalation, and the screen offers it for yourself. For anybody
 * else the predicate is the boundary and refuses a peer or a superior.
 *
 * ⚠ THIS HANDLER READS NO BODY. `UserManager` calls `post(endpoint)` with no second argument, so the
 * request arrives with no body and no content type; parsing one would answer 400 to every click. There
 * is nothing to validate — the account comes from the path and everything else is decided here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** Word-for-word the note in `app/api/studio/users/[id]/route.ts`. One act, one description. */
const REVOCATION_NOTE =
  "Every device they were signed in on has to sign in again. A page they already have open may keep " +
  "reading the studio for up to half an hour until its short-lived token expires, but it cannot renew and " +
  "every change it attempts is checked against the account as it is now.";

async function countActiveSessions(userId: string): Promise<number> {
  return prisma.session.count({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }
  });
}

export const POST = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageUsers,
      "Making a password link needs administrator access. Ask an administrator to do it."
    );

    const { id } = await params;

    /**
     * `passwordHash` is selected here — see point 3 in the header. It goes straight into
     * `issueCredentialLink`, which turns it into a 16-character digest, and the row itself is never
     * put in a response by this handler. Check that before adding one.
     */
    const target = found(
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

    if (target.deletedAt) {
      throw conflict(
        "That account has been deleted, so there is nobody to let back in. Restore it first, then make a link."
      );
    }
    if (!target.isActive) {
      // Refused rather than issued. A link that sets a password on an account which cannot sign in
      // sends somebody through the whole exercise to be refused at the door, and it is not obvious to
      // them why. Switching the account back on is the missing step, so the message names it.
      throw conflict(
        `${target.name}'s account is switched off, so a new password would not let them in. Switch the account back on first, then make a link.`
      );
    }

    if (target.id !== actor.id && !canManageUser(actor, { id: target.id, role: target.role })) {
      throw forbidden(
        "You cannot make a password link for this person, because they are at the same level of access as you or above it. Only somebody with more access than they have can do it."
      );
    }

    const { link, expiresAt } = issueCredentialLink({
      userId: target.id,
      passwordHash: target.passwordHash,
      purpose: "reset"
    });

    const sessionsEnded = await countActiveSessions(target.id);

    await mutateWithHistory<{ id: string }>(
      buildAuditContext(request, actor),
      {
        action: "PERMISSION_CHANGE",
        entityType: "User",
        entityLabel: `${target.name} <${target.email}>`,
        revise: false,
        /**
         * METADATA ONLY. The token is a credential, and an audit log is read by more people than the
         * users table is and gets exported. `redact()` in lib/audit.ts strips secrets by NAME and would
         * not catch this one, so it simply never goes in.
         */
        before: {
          activeSessions: sessionsEnded,
          hadPassword: target.passwordHash !== null,
          linkExpiresAt: expiresAt
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

    // ⚠ See point 4 in the header. This is not tidying up; it is half of what a reset means.
    await revokeAllSessionsForUser(target.id);

    /**
     * NO MAIL TRANSPORT IS CONFIGURED ON THIS INSTALLATION — there is nothing for one in `lib/env.ts`,
     * and `app/studio/users/page.tsx` hands the screen `canSendEmail = false` to match. So the link
     * comes back for an administrator to pass on by a means they trust, and the screen says exactly
     * that beside it.
     *
     * ⚠ When a transport is added, this route sends the link and stops returning it. `emailed` is what
     * the client branches on, so its copy is already correct for both.
     *
     * The token is NOT returned separately. It is inside `link`, and a credential that appears twice in
     * one answer is a credential in two places that have to be kept out of logs.
     */
    return ok({
      emailed: false,
      link,
      expiresAt,
      sessionsEnded,
      sessionsRevoked: true,
      message:
        `The link is good for ${RESET_TTL_HOURS} hours and works once — it stops working the moment a password ` +
        `is set. ${target.name} has been signed out of every device, so they will have to use the link before ` +
        `they can sign in again. Nobody here can see or choose their password. ${REVOCATION_NOTE}`
    });
  }
);
