import type { Metadata } from "next";

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
 *   • HOW MANY ACTIVE ADMINISTRATORS THERE ARE. That count is the guard against the last one demoting or
 *     switching off their own account and locking everybody out — and it is a count rather than a
 *     permission, because `canAssignRole` deliberately PERMITS self-demotion (its own comment says so).
 *     ⚠ The route handler must enforce the same count. This screen refusing it is a courtesy.
 *
 * THE LIST ITSELF IS FETCHED BY THE CLIENT COMPONENT. Every action here — a role change, a sign-out, a
 * password link — has to leave the reader looking at the same row, which a server-rendered list cannot do.
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

  const [activeAdministrators, total] = await prisma.$transaction([
    prisma.user.count({ where: { deletedAt: null, isActive: true, role: "ADMINISTRATOR" } }),
    prisma.user.count({ where: { deletedAt: null } })
  ]);

  /**
   * Whether an invitation or a password link can actually be delivered.
   *
   * No mail transport is configured on this installation — there is nothing in `lib/env.ts` for one — so
   * this is `false` and the screen says so plainly, offering a one-off link to pass on by hand instead. A
   * screen that promised an email nobody would receive would leave a colleague waiting for days.
   *
   * ⚠ When a transport is added, this is the one line to change, and the route handler that mints the link
   * has to start sending it. The copy on the client already covers both cases.
   */
  const canSendEmail = false;

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
        canSendEmail={canSendEmail}
      />
    </div>
  );
}
