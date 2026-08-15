import type { NextRequest } from "next/server";
import { assertSameOrigin, forbidden, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { canManageUser, canManageUsers } from "@/lib/permissions";
import { buildAuditContext, found } from "@/lib/studio/crud";

/**
 * Sign one person out of every device.
 *
 * Serves `DELETE /api/studio/users/{id}/sessions`, called by "Sign out of every device" in
 * `app/studio/users/UserManager.tsx`. Until this file existed the button did nothing at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THREE THINGS IN HERE ARE DECISIONS, NOT DETAIL.
 *
 * 1. IT IS ALLOWED ON YOUR OWN ACCOUNT, so `canManageUser` — which refuses self by design — is NOT
 *    the whole test. Signing yourself out everywhere is not a privilege escalation; it is the correct
 *    answer to a lost laptop, and the screen offers it for yourself in those words ("Sign yourself
 *    out of every device?"). Gating it on `canManageUser` alone would put a 403 behind a button the
 *    client deliberately renders. For ANYBODY ELSE the predicate is the boundary, and it refuses a
 *    peer or a superior — an editor cannot end an administrator's sessions.
 *
 * 2. THE ANSWER IS HONEST ABOUT THE WINDOW. `revokeAllSessionsForUser` kills the refresh chains, so
 *    nothing can be renewed — but an access token already in a browser lives out its own clock, up to
 *    half an hour. An administrator dealing with a lost laptop needs to know whether it is done, so
 *    the response says so rather than implying the person is out this instant.
 *
 * 3. THE SIGN-IN THROTTLE IS CLEARED WITH IT. A sign-out-everywhere is usually part of helping
 *    somebody back in, and eight failed attempts followed by a fifteen-minute lock would block their
 *    first attempt afterwards.
 *
 * NO SECRET COLUMN IS SELECTED. `passwordHash`, `twoFactorSecret`, `twoFactorRecoveryCodes` and
 * `refreshTokenHash` are named nowhere here; the `select` is explicit, because `select: undefined`
 * hands back the whole row and that is how a hash leaves a CMS.
 *
 * THERE IS NO `GET`. The devices-signed-in count the screen prints comes from the LIST response
 * (`activeSessions` in `GET /api/studio/users`, which computes it for the whole page in one grouped
 * query). A second endpoint for the same number would be a second thing to keep in step.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * The sentence every revocation answers with. Word-for-word the one in
 * `app/api/studio/users/[id]/route.ts`, because the same act performed from two endpoints must not be
 * described two ways.
 */
const REVOCATION_NOTE =
  "Every device they were signed in on has to sign in again. A page they already have open may keep " +
  "reading the studio for up to half an hour until its short-lived token expires, but it cannot renew and " +
  "every change it attempts is checked against the account as it is now.";

async function countActiveSessions(userId: string): Promise<number> {
  return prisma.session.count({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }
  });
}

export const DELETE = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageUsers,
      "Ending somebody's sessions needs administrator access. Ask an administrator to do it."
    );

    const { id } = await params;
    const target = found(
      await prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, role: true, deletedAt: true }
      }),
      "That account"
    );

    // ⚠ NO REFUSAL FOR A DELETED ACCOUNT, unlike the other two actions on this person. A deleted
    // account that still has live sessions is a deleted account that can still read the studio, so
    // this is precisely the case where ending them must remain possible.

    if (target.id !== actor.id && !canManageUser(actor, { id: target.id, role: target.role })) {
      throw forbidden(
        "You cannot end this person's sessions, because they are at the same level of access as you or above it. Only somebody with more access than they have can do it."
      );
    }

    /**
     * Counted BEFORE the revocation, because afterwards there is nothing to count and the number is
     * the whole answer: "3 devices signed out" is what tells an administrator the lost laptop was one
     * of them.
     */
    const sessionsEnded = await countActiveSessions(target.id);

    await revokeAllSessionsForUser(target.id);

    /**
     * THE LOG IS WRITTEN AFTER THE REVOCATION, and the order is a choice.
     *
     * The sessions are many rows and none of them is the entity, so there is no single row for this
     * write to be atomic WITH. Rather than fall back to `recordEvent` — a log entry with no change
     * beside it — the account row is touched in the same transaction as the entry, which keeps the
     * property lib/audit.ts exists to provide: the entry cannot exist without a change, nor the
     * change without it.
     *
     * Doing it in this order means a failure here answers 500 for work that DID happen. That is the
     * better failure: revoking again is a no-op, so the administrator's retry succeeds and logs. The
     * reverse order would risk an audit entry claiming a revocation that never ran, and a log that
     * records things which did not happen is worse than useless during an incident.
     *
     * Same shape as the `revoke-sessions` action in `app/api/studio/users/[id]/route.ts`.
     */
    await mutateWithHistory<{ id: string }>(
      buildAuditContext(request, actor),
      {
        action: "PERMISSION_CHANGE",
        entityType: "User",
        entityLabel: `${target.name} <${target.email}>`,
        // No revision: a user row is not versioned content, and a revision of one would only be a
        // second copy of the audit entry.
        revise: false,
        before: { activeSessions: sessionsEnded }
      },
      async (tx) =>
        tx.user.update({
          where: { id: target.id },
          // See point 3 in the header: the throttle would otherwise block their first attempt back in.
          data: { failedLogins: 0, lockedUntil: null },
          select: { id: true }
        })
    );

    const who = target.id === actor.id ? "You have" : `${target.name} has`;

    return ok({
      sessionsEnded,
      sessionsRevoked: true,
      message:
        sessionsEnded === 0
          ? `No devices appeared to be signed in as ${target.name}. Any that were are now signed out. ${REVOCATION_NOTE}`
          : `${sessionsEnded === 1 ? "1 device" : `${sessionsEnded} devices`} signed out. ${who} to sign in again. ${REVOCATION_NOTE}`
    });
  }
);
