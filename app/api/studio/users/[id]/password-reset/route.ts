import type { NextRequest } from "next/server";
import { assertSameOrigin, ok, route } from "@/lib/api";
import {
  RESET_TTL_HOURS,
  issueCredentialLink
} from "@/lib/auth/credential-token";
import { requireCapability } from "@/lib/auth/current-user";
import {
  REVOCATION_NOTE,
  loadResetTarget,
  recordAdminReset,
  resetRefusal
} from "@/lib/auth/password-reset";
import { canManageUsers } from "@/lib/permissions";
import { buildAuditContext } from "@/lib/studio/crud";

/**
 * Give somebody a way to set a new password.
 *
 * Serves `POST /api/studio/users/{id}/password-reset`, called by "Make a password link" in
 * `app/studio/users/UserManager.tsx`. Its sibling `./email/route.ts` serves "Email them a password link":
 * the SAME checks (`resetRefusal`), the SAME token and the SAME audit-and-revoke (`recordAdminReset`), all
 * from lib/auth/password-reset.ts, with SES delivering the link instead of this response.
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

export const POST = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageUsers,
      "Making a password link needs administrator access. Ask an administrator to do it."
    );

    const { id } = await params;

    /**
     * `passwordHash` is read by `loadResetTarget` — see point 3 in the header. It goes straight into
     * `issueCredentialLink`, which turns it into a 16-character digest, and the row itself is never put in
     * a response by this handler. Check that before adding one.
     */
    const target = await loadResetTarget(id);

    // Deleted, switched off, or at/above the actor's level — the one rule both buttons share.
    const refusal = resetRefusal(actor, target, "link");
    if (refusal) throw refusal;

    const { link, expiresAt } = issueCredentialLink({
      userId: target.id,
      passwordHash: target.passwordHash,
      purpose: "reset"
    });

    // The audit entry, the cleared throttle and — ⚠ point 4 — every session revoked.
    const sessionsEnded = await recordAdminReset(buildAuditContext(request, actor), target, {
      expiresAt,
      emailed: false
    });

    /**
     * THIS BUTTON HANDS THE LINK BACK, ALWAYS — even now that SES can send mail. It is the way in that
     * works when email does not (no SES, the sandbox, an address that bounces), and the administrator
     * passes it on by a means they trust; the screen says exactly that beside it. Emailing is the other
     * button, `./email/route.ts`, which never returns the link.
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
