import type { NextRequest } from "next/server";
import { assertSameOrigin, conflict, forbidden, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageUser, canManageUsers } from "@/lib/permissions";
import { buildAuditContext, found } from "@/lib/studio/crud";

/**
 * Switch two-step verification OFF for a colleague who has lost the device it was on.
 *
 * Serves `DELETE /api/studio/users/{id}/two-factor`, called by "Switch it off — they have lost their
 * device" in `app/studio/users/UserManager.tsx`. Until this file existed, a locked-out colleague could
 * not be helped at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AN ADMINISTRATOR MAY REMOVE A SECOND FACTOR AND MAY NEVER READ ONE.
 *
 * There is no request anywhere in this application that returns `twoFactorSecret`, and this one
 * answers with a confirmation and nothing else. The secret is encrypted at rest (lib/auth/totp.ts)
 * precisely so that a database read is not an account takeover; a screen that decrypted it would hand
 * back everything that buys. What is offered instead is account RECOVERY — the ability to take the
 * second factor away so its owner can enrol a new device — which is a different power and is recorded.
 *
 * ⚠ THE RECOVERY CODES GO WITH THE SECRET. A recovery code is a password that bypasses the second
 * factor. Codes left behind would still open the account, so a "switched off" second factor would go on
 * holding up to ten live credentials nobody remembers exist.
 *
 * ⚠ AUDITED AS `PERMISSION_CHANGE`, NOT `UPDATE`. This WEAKENS somebody else's account, and the audit
 * trail is the only record of who did it and when. The audit screen colours `PERMISSION_CHANGE` as an
 * error tone on purpose: it is the entry class somebody reads first during an incident, and filing this
 * as an ordinary update would bury it among a hundred content saves.
 *
 * ⚠ REFUSED FOR YOUR OWN ACCOUNT, and the reason is not tidiness. Switching your own second factor off
 * asks for your password on the account screen (`app/api/auth/two-factor/route.ts`), because a session
 * is not proof of presence — somebody standing at an unlocked laptop must not be able to remove the
 * control that exists to stop them. This route has no password to check, so it must not become the way
 * round that.
 *
 * SESSIONS ARE DELIBERATELY LEFT ALONE. Removing a second factor does not mean the person's devices are
 * suspect, and signing an editor out of every machine in the middle of the working day is a real cost.
 * "Sign out of every device" is its own control beside this one, for when that IS the situation.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const DELETE = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageUsers,
      "Changing somebody's two-step verification needs administrator access. Ask an administrator to do it."
    );

    const { id } = await params;

    /**
     * `twoFactorRecoveryCodes` is selected to be COUNTED and for no other purpose — the audit entry
     * records how many live credentials this act destroyed, which is the figure somebody reviewing an
     * incident wants. The array itself is never returned; only `.length` leaves this handler.
     * `twoFactorSecret` is not selected at all.
     */
    const target = found(
      await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          deletedAt: true,
          twoFactorEnabled: true,
          twoFactorRecoveryCodes: true
        }
      }),
      "That account"
    );

    if (target.deletedAt) {
      throw conflict(
        "That account has been deleted, so there is nobody to help back in. Restore it first if this person is returning."
      );
    }

    if (target.id === actor.id) {
      throw forbidden(
        "Switch your own two-step verification off from your account screen, where it asks for your password first. A session on its own is not proof that it is you."
      );
    }

    if (!canManageUser(actor, { id: target.id, role: target.role })) {
      throw forbidden(
        "You cannot change this person's two-step verification, because they are at the same level of access as you or above it. Only somebody with more access than they have can do it."
      );
    }

    if (!target.twoFactorEnabled) {
      /**
       * REFUSED RATHER THAN TREATED AS DONE. The screen only offers this control for an account that
       * has two-step verification on, so reaching here means the list in front of the administrator is
       * out of date — and so is everything else it is telling them about this person. Answering "done"
       * would also let one administrator's action look like another's, which matters when two people are
       * working the same incident.
       */
      throw conflict(
        `Two-step verification is not switched on for ${target.name}'s account, so there is nothing to switch off. The list on screen may be out of date — reload it to see the account as it is now.`
      );
    }

    const recoveryCodesDestroyed = target.twoFactorRecoveryCodes.length;

    await mutateWithHistory<{ id: string }>(
      buildAuditContext(request, actor),
      {
        action: "PERMISSION_CHANGE",
        entityType: "User",
        entityLabel: `${target.name} <${target.email}>`,
        // No revision: a user row is not versioned content, and a revision of one would only be a
        // second copy of the audit entry with its secrets redacted.
        revise: false,
        before: { twoFactorEnabled: true, recoveryCodesLeft: recoveryCodesDestroyed }
      },
      async (tx) =>
        tx.user.update({
          where: { id: target.id },
          data: {
            twoFactorEnabled: false,
            twoFactorSecret: null,
            // ⚠ Cleared WITH the secret. See the header.
            twoFactorRecoveryCodes: []
          },
          select: { id: true }
        })
    );

    return ok({
      twoFactorEnabled: false,
      recoveryCodesLeft: 0,
      message:
        `${target.name}'s account needs only a password again, until they set two-step verification up on a ` +
        "new device from their own account screen. " +
        (recoveryCodesDestroyed > 0
          ? `The ${recoveryCodesDestroyed} recovery ${recoveryCodesDestroyed === 1 ? "code" : "codes"} they still held have stopped working. `
          : "They had no recovery codes left. ") +
        "This is in the audit log with your name on it."
    });
  }
);
