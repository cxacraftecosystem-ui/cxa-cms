import "server-only";
import { Prisma, type Role } from "@prisma/client";

import { conflict, forbidden } from "@/lib/api";
import { mutateWithHistory, type AuditContext, type TxClient } from "@/lib/audit";
import { countActiveByRole, domainKeyOf, normaliseEmail } from "@/lib/auth/access";
import { prisma } from "@/lib/db";
import { canEraseAccount, type PermissionSubject } from "@/lib/permissions";
import { found } from "@/lib/studio/crud";

/**
 * Deleting an account for good — the master administrator's "Delete permanently".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A TOMBSTONE, NOT A HARD DELETE, AND THE SCHEMA IS WHY. Every table that points at `users` declares
 * `ON DELETE SET NULL` (posts, revisions, media, files, announcements, enquiries, audit logs, the access
 * list) or `CASCADE` (sessions, linked sign-ins, edit locks). A hard delete would therefore keep the
 * content but leave it attributed to NOBODY — "who wrote this?" would have no answer at all. So the row
 * stays, under its own id, and every personal field on it is cleared: the name becomes `Deleted admin`
 * (or `Deleted account`), the address becomes `erased+<id>@erased.invalid`, the password, second factor,
 * avatar and title go, and `erasedAt` marks it as something that can never be restored. Everything the
 * person wrote keeps pointing at that one placeholder, and nothing is lost.
 *
 * WHAT IS REMOVED OUTRIGHT: every session (so no refresh token renews and no device stays signed in),
 * every linked Google/Microsoft/Yahoo sign-in, every edit lock, and the person's own EMAIL entry on the
 * studio access list — without that, they could sign in again tomorrow and be given a fresh account. A
 * DOMAIN entry that still covers the address is reported, not touched: it governs other people too.
 *
 * WHAT IS KEPT: the audit trail. The deletion itself is ONE audit row — who did it (`actorId`,
 * `actorEmail`), when (`createdAt`), and which account (`entityId`, the `Name <address>` label and the
 * snapshot in `before`, including how much content pointed at it). That row is the only surviving record
 * of the address, which is the point of an audit log.
 *
 * THE GUARDS ARE THE ONES THE USERS ROUTE KEEPS, TAKEN THE SAME WAY: never your own account, never the
 * last active master administrator, never the last active administrator, never the last master-admin
 * entry on the access list. Each is checked early for a readable refusal and again INSIDE the writing
 * transaction with the rows locked (`FOR UPDATE`), because two deletions running together would
 * otherwise each count two and leave none — see `lockActiveAdministrators` in
 * app/api/studio/users/[id]/route.ts for the full argument.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Where a tombstone's address points. `.invalid` is reserved (RFC 2606) and can never receive mail. */
export const ERASED_EMAIL_DOMAIN = "erased.invalid";

export function erasedEmailFor(userId: string): string {
  return `erased+${userId}@${ERASED_EMAIL_DOMAIN}`;
}

/** The name content keeps once its author is gone. */
export function placeholderNameFor(role: Role): string {
  return role === "ADMINISTRATOR" || role === "MASTER_ADMIN" ? "Deleted admin" : "Deleted account";
}

export const LAST_MASTER_ADMIN_ERASE =
  "This is the only master administrator on this installation, so the account cannot be deleted. Nobody " +
  "could ever add another colleague to the studio access list again. Make somebody else a master " +
  "administrator first.";

export const LAST_ADMINISTRATOR_ERASE =
  "This is the only active administrator on this installation, so the account cannot be deleted. Nobody " +
  "could manage users, settings, navigation or the recycle bin. Make somebody else an administrator first.";

export const LAST_MASTER_GRANT_ERASE =
  "This address holds the only master-administrator entry on the studio access list, so the account cannot " +
  "be deleted. Give somebody else a master-administrator entry first.";

const RACE =
  "Somebody else changed an administrator's account at the same moment. Nothing has been deleted — " +
  "reload the screen and try again.";

const targetSelect = {
  id: true,
  name: true,
  email: true,
  title: true,
  role: true,
  isActive: true,
  avatarId: true,
  twoFactorEnabled: true,
  lastLoginAt: true,
  createdAt: true,
  deletedAt: true,
  erasedAt: true,
  _count: {
    select: {
      sessions: true,
      oauthAccounts: true,
      locks: true,
      authoredPosts: true,
      revisions: true,
      uploadedMedia: true,
      uploadedFiles: true,
      announcements: true,
      assignedInquiries: true,
      auditLogs: true,
      accessGrantsAdded: true,
      accessGrantsRevoked: true
    }
  }
} as const satisfies Prisma.UserSelect;

export interface EraseAccountInput {
  context: AuditContext;
  /** The person pressing the button. Must pass `canEraseAccount`. */
  actor: PermissionSubject;
  targetId: string;
  /**
   * The address the actor typed to confirm. Compared after normalising; a mismatch is refused, so a
   * request built for one account can never delete another.
   */
  confirmEmail: string;
  /** Recorded in the audit row's `after` when the deletion did not come from the studio screen. */
  via?: string;
}

export interface EraseAccountResult {
  id: string;
  placeholderName: string;
  sessionsEnded: number;
  accessEntriesRemoved: number;
  /** A DOMAIN entry that would still admit this address, if one exists. Reported, never changed. */
  domainEntryStillAdmits: string | null;
  contentKept: number;
}

/** Same SQL as the users route; see its notes. Locks every active administrator's row. */
async function lockActiveAdministrators(tx: TxClient): Promise<number> {
  await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "users"
               WHERE "role" = 'ADMINISTRATOR' AND "isActive" = true AND "deletedAt" IS NULL
               ORDER BY "id"
               FOR UPDATE`
  );
  return countActiveByRole(tx as never, "ADMINISTRATOR");
}

async function lockActiveMasterAdmins(tx: TxClient): Promise<number> {
  await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "users"
               WHERE "role" = 'MASTER_ADMIN' AND "isActive" = true AND "deletedAt" IS NULL
               ORDER BY "id"
               FOR UPDATE`
  );
  return countActiveByRole(tx as never, "MASTER_ADMIN");
}

/** Unrevoked master-admin entries on the access list, other than `exceptEmail`'s, with the rows locked. */
async function lockOtherMasterGrants(tx: TxClient, exceptEmail: string): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "studio_access"
               WHERE "grantedRole" = 'MASTER_ADMIN' AND "revokedAt" IS NULL AND "email" <> ${exceptEmail}
               ORDER BY "id"
               FOR UPDATE`
  );
  return rows.length;
}

export async function eraseAccount(input: EraseAccountInput): Promise<EraseAccountResult> {
  const { actor, context, targetId } = input;

  if (!isPermitted(actor, targetId)) {
    throw forbidden(
      targetId === actor.id
        ? "You cannot delete your own account. Ask another master administrator to do it."
        : "Only a master administrator can delete an account permanently."
    );
  }

  const target = found(
    await prisma.user.findUnique({ where: { id: targetId }, select: targetSelect }),
    "That account"
  );
  if (target.erasedAt) throw conflict("That account has already been deleted permanently.");

  const email = normaliseEmail(target.email);
  if (normaliseEmail(input.confirmEmail) !== email) {
    throw conflict(
      "The address typed to confirm does not match this account, so nothing has been deleted. Type the account's email address exactly."
    );
  }

  /** Is the account one the lockout counts include? A switched-off or soft-deleted one is not. */
  const counted = target.isActive && target.deletedAt === null;
  const removesAdministrator = counted && target.role === "ADMINISTRATOR";
  const removesMasterAdmin = counted && target.role === "MASTER_ADMIN";

  // The early answers, for a readable refusal. The guards that hold are inside the transaction.
  if (removesMasterAdmin && (await countActiveByRole(prisma as never, "MASTER_ADMIN")) <= 1) {
    throw conflict(LAST_MASTER_ADMIN_ERASE);
  }
  if (removesAdministrator && (await countActiveByRole(prisma as never, "ADMINISTRATOR")) <= 1) {
    throw conflict(LAST_ADMINISTRATOR_ERASE);
  }

  const ownGrants = await prisma.studioAccess.findMany({
    where: { email, kind: "EMAIL" },
    select: { id: true, grantedRole: true, revokedAt: true }
  });
  const holdsMasterGrant = ownGrants.some((grant) => grant.grantedRole === "MASTER_ADMIN" && grant.revokedAt === null);

  const domainKey = domainKeyOf(email);
  const domainEntry = domainKey
    ? await prisma.studioAccess.findFirst({
        where: { email: domainKey, kind: "DOMAIN", revokedAt: null },
        select: { email: true }
      })
    : null;

  const counts = target._count;
  const contentKept =
    counts.authoredPosts +
    counts.revisions +
    counts.uploadedMedia +
    counts.uploadedFiles +
    counts.announcements +
    counts.assignedInquiries;
  const placeholderName = placeholderNameFor(target.role);
  const erasedAt = new Date();

  const result = await mutateWithHistory<{
    id: string;
    sessionsEnded: number;
    accessEntriesRemoved: number;
  }>(
    context,
    {
      action: "DELETE",
      entityType: "User",
      entityLabel: `${target.name} <${target.email}>`,
      revise: false,
      summary: "The account was deleted permanently",
      // The only surviving record of the account. No secret column is selected (see `targetSelect`).
      before: {
        id: target.id,
        name: target.name,
        email: target.email,
        title: target.title,
        role: target.role,
        isActive: target.isActive,
        twoFactorEnabled: target.twoFactorEnabled,
        hadAvatar: target.avatarId !== null,
        lastLoginAt: target.lastLoginAt,
        createdAt: target.createdAt,
        deletedAt: target.deletedAt,
        references: counts,
        accessEntries: ownGrants.map((grant) => ({ id: grant.id, grantedRole: grant.grantedRole, revokedAt: grant.revokedAt }))
      }
    },
    async (tx) => {
      // ⚠ THE REAL GUARDS, in a fixed order (administrators, master admins, access list) so two of these
      // running together cannot deadlock.
      if (removesAdministrator && (await lockActiveAdministrators(tx)) <= 1) throw conflict(RACE);
      if (removesMasterAdmin && (await lockActiveMasterAdmins(tx)) <= 1) throw conflict(RACE);
      if (holdsMasterGrant && (await lockOtherMasterGrants(tx, email)) < 1) throw conflict(LAST_MASTER_GRANT_ERASE);

      const sessions = await tx.session.deleteMany({ where: { userId: target.id } });
      await tx.oAuthAccount.deleteMany({ where: { userId: target.id } });
      await tx.contentLock.deleteMany({ where: { userId: target.id } });
      const grants = await tx.studioAccess.deleteMany({ where: { email, kind: "EMAIL" } });

      await tx.user.update({
        where: { id: target.id },
        data: {
          email: erasedEmailFor(target.id),
          name: placeholderName,
          title: null,
          passwordHash: null,
          avatarId: null,
          role: "VIEWER",
          isActive: false,
          canPublish: false,
          canManageMedia: false,
          twoFactorEnabled: false,
          twoFactorSecret: null,
          twoFactorRecoveryCodes: [],
          failedLogins: 0,
          lockedUntil: null,
          deletedAt: target.deletedAt ?? erasedAt,
          erasedAt
        },
        select: { id: true }
      });

      // The audit row's `after`. Facts about what happened, and nothing personal.
      return {
        id: target.id,
        erased: true,
        erasedAt: erasedAt.toISOString(),
        placeholderName,
        sessionsEnded: sessions.count,
        accessEntriesRemoved: grants.count,
        contentKept,
        ...(input.via ? { via: input.via } : {})
      };
    }
  );

  return {
    id: result.id,
    placeholderName,
    sessionsEnded: result.sessionsEnded,
    accessEntriesRemoved: result.accessEntriesRemoved,
    domainEntryStillAdmits: domainEntry?.email ?? null,
    contentKept
  };
}

function isPermitted(actor: PermissionSubject, targetId: string): boolean {
  return canEraseAccount(actor, { id: targetId });
}
