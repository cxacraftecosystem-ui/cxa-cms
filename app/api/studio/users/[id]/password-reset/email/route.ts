import type { NextRequest } from "next/server";
import { assertSameOrigin, ok, route } from "@/lib/api";
import { RESET_TTL_HOURS } from "@/lib/auth/credential-token";
import { requireCapability } from "@/lib/auth/current-user";
import {
  REVOCATION_NOTE,
  emailResetLinkToAccount,
  loadResetTarget,
  resetRefusal
} from "@/lib/auth/password-reset";
import { canManageUsers } from "@/lib/permissions";
import { buildAuditContext } from "@/lib/studio/crud";

/**
 * Email somebody a link to set a new password, through Amazon SES.
 *
 * Serves `POST /api/studio/users/{id}/password-reset/email`, called by "Email them a password link" in
 * `app/studio/users/UserManager.tsx`, beside "Make a password link" (the parent route) and "Sign out of
 * every device".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SAME ACT AS "MAKE A PASSWORD LINK", DELIVERED DIFFERENTLY — and nothing else may differ:
 *
 *   • THE SAME PERMISSION. `requireCapability(canManageUsers)`, then `resetRefusal` — the one function
 *     the parent route also calls — so who may reset whom cannot drift between the two buttons.
 *   • THE SAME TOKEN, to the account's OWN stored address only. The address is read from the row; nothing
 *     in the request can name a recipient, and the handler reads no body for the same reason the parent
 *     route gives.
 *   • THE SAME CONSEQUENCES, but ONLY ONCE SES HAS ACCEPTED THE MESSAGE: the audit entry, the cleared
 *     throttle, and every session revoked (`recordAdminReset`). Revoking before a send that then failed
 *     would sign the person out with no way back in.
 *
 * ⚠ NEVER SILENT. No sender configured → 503; a refused or failed send → 502. Both sentences say nothing
 * changed and point at "Make a password link", which always works. See `emailResetLinkToAccount`.
 *
 * ⚠ THE LINK IS NEVER IN THE RESPONSE. It went to the person's mailbox; returning it too would put a live
 * credential on an administrator's screen for no reason, which is what emailing it was meant to avoid.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const POST = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageUsers,
      "Emailing a password link needs administrator access. Ask an administrator to do it."
    );

    const { id } = await params;
    const target = await loadResetTarget(id);

    const refusal = resetRefusal(actor, target, "email");
    if (refusal) throw refusal;

    const { expiresAt, sessionsEnded } = await emailResetLinkToAccount(
      buildAuditContext(request, actor),
      target
    );

    return ok({
      emailed: true,
      expiresAt,
      sessionsEnded,
      sessionsRevoked: true,
      message:
        `A link has been emailed to ${target.email}. It is good for ${RESET_TTL_HOURS} hours and works once. ` +
        `${target.name} has been signed out of every device, so they will have to use the link before they can ` +
        `sign in again. If it does not arrive, make a link instead and pass it on yourself. ${REVOCATION_NOTE}`
    });
  }
);
