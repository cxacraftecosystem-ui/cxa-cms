import type { Metadata } from "next";

import { authMailInfo } from "@/lib/auth/auth-mail";
import { prisma } from "@/lib/db";
import { requireStudioCapability } from "@/lib/auth/current-user";
import { canManageUsers } from "@/lib/permissions";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";
import { UserManager } from "./UserManager";

/**
 * Users — who can sign in to this studio, and what each of them is allowed to change.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageUsers)` IS THE FIRST STATEMENT — administrator only, and it is the same
 * predicate the `/api/studio/users/*` handlers call and the same one `StudioNav` hides the sidebar entry
 * with. It THROWS rather than rendering (contract §1.8).
 *
 * THE AUTHORITATIVE ROW, NOT THE TOKEN. `requireCapability` goes through `currentUser()`, which re-reads
 * the row rather than trusting the signed token — an access token minted before a demotion stays valid for
 * up to half an hour, and a screen that could hand out administrator access on the strength of one would be
 * the worst possible place for that window to matter.
 *
 * TWO FACTS ARE HANDED DOWN THAT ONLY THE SERVER CAN KNOW:
 *
 *   • WHO IS LOOKING, in the shape the predicates want. `canAssignRole` and `canManageUser` are then called
 *     with the same subject the route handler will use, so the control the reader sees and the answer the
 *     server gives cannot disagree (contract §1.7).
 *   • HOW MANY ACTIVE ADMINISTRATORS THERE ARE, AND HOW MANY ACTIVE MASTER ADMINISTRATORS. Those counts are
 *     the guard against the last one demoting or switching off their own account and locking everybody
 *     out — and they are counts rather than permissions, because `canAssignRole` deliberately PERMITS
 *     self-demotion (its own comment says so).
 *     ⚠ The route handler must enforce the same counts. This screen refusing it is a courtesy.
 *
 * THE LIST ITSELF IS FETCHED BY THE CLIENT COMPONENT. Every action here — a role change, a sign-out, a
 * password link — has to leave the reader looking at the same row, which a server-rendered list cannot do.
 *
 * ⚠ EVERYTHING THIS FILE COUNTS IS READ ONCE, AT FIRST PAINT. Inviting somebody, or moving them in or out
 * of a tier, changes all three numbers below and nothing here can know it — so `UserManager` calls
 * `router.refresh()` after every write to re-run this function. Without that the header went on saying
 * "6 accounts" beside a table of seven, and the lockout warnings went on describing an installation that
 * had already been fixed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Users"
};

export default async function StudioUsersPage() {
  const user = await requireStudioCapability(
    canManageUsers,
    "Managing people needs administrator access. Ask an administrator to make the change, or to raise your access."
  );

  /**
   * ⚠ THE TWO LOCKOUT COUNTS ARE COUNTED SEPARATELY, AND NEITHER INCLUDES THE OTHER.
   *
   * `role` holds ONE value, so a master administrator does not hold `ADMINISTRATOR` and is not in the first
   * count — which is correct, because the two lockouts are different losses with different remedies, and
   * `UserManager` says so in different words. Counting them together would let the last master
   * administrator demote themselves on the strength of there being three administrators, which is exactly
   * the case the second warning exists for.
   *
   * ⚠ `activeMasterAdmins` WAS NOT BEING COUNTED HERE AT ALL, AND NOTHING ELSE SUPPLIED IT. The prop is
   * optional and `UserManager` treats an absent count as "nobody has told this screen", which it handles by
   * claiming nothing — so the master-administrator warning never appeared on any installation and
   * `isLastMasterAdmin` was permanently false. The screen looked healthy and the guard was not there.
   * `GET /api/studio/users` does not return this number either; when it does, the client already prefers
   * the answer over this prop and will pick it up with no change here.
   */
  const [activeAdministrators, activeMasterAdmins, total] = await prisma.$transaction([
    prisma.user.count({ where: { deletedAt: null, isActive: true, role: "ADMINISTRATOR" } }),
    prisma.user.count({ where: { deletedAt: null, isActive: true, role: "MASTER_ADMIN" } }),
    prisma.user.count({ where: { deletedAt: null } })
  ]);

  /**
   * Whether an INVITATION can be delivered by email.
   *
   * Still `false`: `app/api/studio/users/route.ts` does not send invitations, so the screen offers a
   * one-off link to pass on by hand. A screen that promised an email nobody would receive would leave a
   * colleague waiting for days. ⚠ When that route starts sending through lib/auth/auth-mail.ts, this is
   * the line to change.
   */
  const canSendEmail = false;

  /**
   * Whether a PASSWORD LINK can be emailed — Amazon SES set up for account mail (lib/auth/auth-mail.ts).
   * Read from the environment, server-side, because `lib/env.ts` must never reach the client. When it is
   * false the "Email them a password link" button is absent and a sentence says why; "Make a password
   * link" works either way.
   */
  const canEmailPasswordLinks = authMailInfo().configured;

  return (
    <div className="mx-auto w-full max-w-[100rem] space-y-6">
      <StudioPageHeader
        title="Users"
        description="Everybody who can sign in to this studio. Give each person the least access that lets them do their work — every level can be raised in a moment, and a level somebody does not need is a level they can make a mistake at."
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {total === 1 ? "1 account" : `${total} accounts`}
          </span>
        }
      />

      <UserManager
        // The subject the predicates read: the id and the role decide everything, and the two grants are
        // carried because `canPublish`/`canManageMedia` are OR-ed into the rank test.
        currentUser={{
          id: user.id,
          name: user.name,
          role: user.role,
          canPublish: user.canPublish,
          canManageMedia: user.canManageMedia
        }}
        activeAdministrators={activeAdministrators}
        activeMasterAdmins={activeMasterAdmins}
        canSendEmail={canSendEmail}
        canEmailPasswordLinks={canEmailPasswordLinks}
      />
    </div>
  );
}
