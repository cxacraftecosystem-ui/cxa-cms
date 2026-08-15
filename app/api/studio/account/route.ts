import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { ApiError, assertSameOrigin, badRequest, conflict, ok, route } from "@/lib/api";
import { requireUser } from "@/lib/auth/current-user";
import { REFRESH_COOKIE } from "@/lib/auth/cookies";
import { hashPassword, passwordProblems, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import { mutateWithHistory } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";

/**
 * Your own account: your details, the address you sign in with, and your password.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ A PASSWORD CHANGE REQUIRES THE CURRENT PASSWORD. THIS IS THE RULE THE FILE EXISTS FOR.
 *
 * A session cookie is NOT sufficient authorisation to change the credential that session rests on. If it
 * were, a stolen session — a shared laptop left unlocked for two minutes, a cookie lifted from a browser —
 * would become a permanent account takeover: the thief sets a new password, the owner is locked out, and
 * every session revocation in the world is now working for the wrong person. Asking for the current password
 * turns a temporary compromise back into a temporary one.
 *
 * The same reasoning covers the SIGN-IN ADDRESS, which is the other half of the credential: changing it
 * without the password would let somebody redirect the account's password-reset route to an address they own.
 *
 * ⚠ A PASSWORD CHANGE REVOKES EVERY OTHER SESSION AND KEEPS THIS ONE ALIVE.
 *
 * Every other device, because a password change is the answer to "somebody else may have my password" and it
 * is worth nothing if the device they were using stays signed in. THIS one, because signing the reader out of
 * the screen they are standing at is a cost with no security benefit — they have just proved they know the
 * old password and they hold the session that proves it.
 *
 * The current session is found by hashing the refresh cookie: `Session.refreshTokenHash` is a SHA-256 and the
 * token itself is never stored (lib/auth/session.ts), so the same hash identifies the row without the token
 * ever being compared to anything. If the cookie is absent — a caller with only an access token — every
 * session is revoked including this one, and the response SAYS SO rather than leaving the reader to discover
 * it on their next click.
 *
 * ⚠ AND THE ANSWER IS HONEST ABOUT WHAT A REVOCATION DOES NOT DO. Revoking a session row kills its refresh
 * chain, so nothing can be renewed — but an access token already sitting in another browser lives out its own
 * clock, up to half an hour. A response that claimed the other devices were out THIS INSTANT would be wrong,
 * and it is the wrong thing to be wrong about.
 *
 * `requireUser()` and nothing more. Editing your own profile is not a privilege — but every action re-reads
 * the row rather than trusting the token, because a token minted before a deactivation stays valid until it
 * expires.
 *
 * ⚠ TWO-STEP VERIFICATION IS NOT HERE. Setting it up needs the pending secret to never touch JavaScript,
 * which is why it lives in `app/studio/account/page.tsx` (Server Actions, an httpOnly cookie) and in
 * `app/api/auth/two-factor/route.ts` for a client. Adding a third implementation would be a third opinion
 * about the cryptography.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/** ⚠ Never `passwordHash`, never `twoFactorSecret`, never `twoFactorRecoveryCodes`. */
const accountSelect = {
  id: true,
  name: true,
  email: true,
  title: true,
  role: true,
  avatarId: true,
  canPublish: true,
  canManageMedia: true,
  twoFactorEnabled: true,
  twoFactorRecoveryCodes: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true
} as const;

type AccountRow = Prisma.UserGetPayload<{ select: typeof accountSelect }>;

/**
 * The codes become a count and the array is destructured away, so the compiler is what keeps it out of the
 * response rather than a `delete` somebody may drop in a refactor.
 */
function toAccount(row: AccountRow, activeSessions: number) {
  const { twoFactorRecoveryCodes, ...rest } = row;
  return {
    ...rest,
    recoveryCodesLeft: twoFactorRecoveryCodes.length,
    activeSessions,
    roleLabel: ROLE_LABELS[row.role],
    roleDescription: ROLE_DESCRIPTIONS[row.role]
  };
}

/**
 * The session row this request is riding on, by hashing the refresh cookie.
 *
 * Returns null when there is no cookie, or when the cookie names a session that has already been revoked —
 * in which case there is nothing to keep alive and the caller falls back to revoking everything.
 */
async function currentSessionId(request: NextRequest, userId: string): Promise<string | null> {
  const token = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!token) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
    select: { id: true, userId: true, revokedAt: true }
  });
  // The `userId` check is belt and braces: a cookie belonging to another account must never be treated as
  // this request's session, whatever else has gone wrong upstream.
  if (!session || session.userId !== userId || session.revokedAt !== null) return null;
  return session.id;
}

/** Revoke every session EXCEPT one. Returns how many were ended. */
async function revokeOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: { userId, revokedAt: null, id: { not: keepSessionId } },
    data: { revokedAt: new Date() }
  });
  return count;
}

const REVOCATION_NOTE =
  "A page already open on another device may keep reading the studio for up to half an hour until its " +
  "short-lived token expires, but it cannot renew and every change it attempts is checked against the " +
  "account as it is now.";

async function countActiveSessions(userId: string): Promise<number> {
  return prisma.session.count({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } } });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  const session = await requireUser();

  const row = await prisma.user.findUnique({ where: { id: session.id }, select: accountSelect });
  if (!row) {
    // `requireUser()` already refuses a deleted or deactivated account, so this is the race where it went
    // between the two reads. Reported as an ended session, which is what it is.
    throw new ApiError(401, "Your session has ended. Please sign in again.", { code: "unauthenticated" });
  }

  return ok({ account: toAccount(row, await countActiveSessions(row.id)) });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Three separate actions rather than one bag of optional fields.
 *
 * A discriminated union, because the three have different authorisation: a name is a preference, and an
 * address or a password is a credential. A single body with everything optional would make it one careless
 * `if` away from a password change that never asked for the old one.
 */
const PatchBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("profile"),
    name: z
      .string()
      .trim()
      .min(1, "A name is needed — it is what colleagues see beside everything you change.")
      .max(200, "Keep your name to 200 characters or fewer."),
    title: z.string().trim().max(200).optional(),
    /** `null` means no picture. Never the empty string, which would be an id nobody has. */
    avatarId: z.string().trim().max(64).nullable().optional()
  }),
  z.object({
    action: z.literal("email"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "An email address is needed — it is what you sign in with.")
      .max(254)
      /**
       * A very plain shape check, deliberately. Every stricter regex anybody writes rejects a real address
       * somewhere, and this value is somebody's only way back into the studio.
       */
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "That does not look like a complete email address."),
    currentPassword: z.string().min(1, "Your current password is needed to change how you sign in.")
  }),
  z.object({
    action: z.literal("password"),
    currentPassword: z.string().min(1, "Your current password is needed."),
    newPassword: z.string().min(1, "Choose a new password."),
    confirmPassword: z.string().min(1, "Type the new password a second time.")
  })
]);

export const PATCH = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const session = await requireUser();
  const body = await parseStudioJson(request, PatchBody);

  const stored = await prisma.user.findUnique({
    where: { id: session.id },
    select: { ...accountSelect, passwordHash: true }
  });
  if (!stored) {
    throw new ApiError(401, "Your session has ended. Please sign in again.", { code: "unauthenticated" });
  }

  /**
   * ⚠ SPLIT ON THE VERY NEXT LINE, and this is load-bearing rather than tidy.
   *
   * `toAccount()` spreads its argument, so handing it the row as read — which carries `passwordHash`, because
   * the two credential actions below need it — would put a bcrypt hash straight into the response. TypeScript
   * would not catch it: excess-property checking applies to object literals, not to a variable being passed.
   * So the hash is separated here, once, and `account` is the only thing any answer below is built from.
   */
  const { passwordHash, ...row } = stored;

  const context = buildAuditContext(request, session);

  // ── Your details ────────────────────────────────────────────────────────────────────────────────
  if (body.action === "profile") {
    if (body.avatarId) {
      /**
       * The picture has to exist and not be in the recycle bin. A dangling `avatarId` renders as a broken
       * image beside everything the person changes, and `onDelete: SetNull` only covers a real deletion — a
       * soft delete leaves the reference intact.
       */
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: body.avatarId, deletedAt: null },
        select: { id: true }
      });
      if (!asset) {
        throw badRequest(
          "That picture is not in the media library any more, so nothing has been changed. Choose another one."
        );
      }
    }

    const updated = await mutateWithHistory<AccountRow>(
      context,
      {
        action: "UPDATE",
        entityType: "User",
        entityLabel: row.email,
        // No revision: a user row is not versioned content, and one would be a second copy of the audit entry.
        revise: false,
        before: { name: row.name, title: row.title, avatarId: row.avatarId }
      },
      async (tx) =>
        tx.user.update({
          where: { id: row.id },
          data: {
            name: body.name,
            title: body.title && body.title.length > 0 ? body.title : null,
            // `""` from a cleared picker means NO picture, which is null.
            avatarId: body.avatarId && body.avatarId.length > 0 ? body.avatarId : null
          },
          select: accountSelect
        })
    );

    return ok({
      account: toAccount(updated, await countActiveSessions(row.id)),
      message: "Your details have been saved. They appear beside everything you change."
    });
  }

  // ── The address you sign in with ────────────────────────────────────────────────────────────────
  if (body.action === "email") {
    // ⚠ THE PASSWORD, because this changes the credential. See the file header.
    if (!(await verifyPassword(body.currentPassword, passwordHash))) {
      throw new ApiError(403, "That is not your current password, so nothing has been changed.", {
        code: "forbidden",
        fieldErrors: { currentPassword: ["That is not your current password."] }
      });
    }

    if (body.email === row.email) {
      return ok({
        account: toAccount(row, await countActiveSessions(row.id)),
        changed: false,
        message: "That is already your sign-in address, so nothing has been changed."
      });
    }

    const clash = await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } });
    if (clash && clash.id !== row.id) {
      throw conflict("Another account already uses that address. Nothing has been changed.");
    }

    const updated = await mutateWithHistory<AccountRow>(
      context,
      {
        action: "UPDATE",
        entityType: "User",
        entityLabel: body.email,
        revise: false,
        before: { email: row.email }
      },
      async (tx) =>
        tx.user.update({ where: { id: row.id }, data: { email: body.email }, select: accountSelect })
    );

    return ok({
      account: toAccount(updated, await countActiveSessions(row.id)),
      changed: true,
      message:
        "Your sign-in address has been changed. Use the new one next time you sign in. No confirmation " +
        "message is sent, so check the spelling now — if it is wrong, another administrator can put it right, " +
        "and if you are the only administrator, nobody can."
    });
  }

  // ── Your password ───────────────────────────────────────────────────────────────────────────────
  // ⚠ THE CURRENT PASSWORD. See the file header: a session cookie is not authorisation to replace the
  // credential it rests on.
  if (!(await verifyPassword(body.currentPassword, passwordHash))) {
    throw new ApiError(403, "That is not your current password, so nothing has been changed.", {
      code: "forbidden",
      fieldErrors: { currentPassword: ["That is not your current password."] }
    });
  }

  if (body.newPassword !== body.confirmPassword) {
    throw new ApiError(422, "The two new passwords were not the same, so nothing has been changed.", {
      code: "validation_failed",
      fieldErrors: { confirmPassword: ["This does not match the new password."] }
    });
  }
  if (body.newPassword === body.currentPassword) {
    throw badRequest("The new password is the same as the old one, so nothing has been changed.");
  }

  /**
   * `passwordProblems` — the SAME rules the sign-in and invitation flows use.
   *
   * A second list of rules written here would eventually accept a password one of the others refused, and the
   * sentences it returns are written to be printed verbatim under the box.
   */
  const problems = passwordProblems(body.newPassword);
  if (problems.length > 0) {
    throw new ApiError(422, problems[0] ?? "That password was refused.", {
      code: "validation_failed",
      fieldErrors: { newPassword: problems }
    });
  }

  /**
   * Hashed BEFORE the transaction opens.
   *
   * bcrypt at cost 12 is about a quarter of a second; doing it inside the transaction would hold it open for
   * that long for no reason, and a transaction held open across a CPU-bound wait is how a pooled connection
   * runs out under load.
   */
  const nextPasswordHash = await hashPassword(body.newPassword);

  const keepSessionId = await currentSessionId(request, row.id);

  await mutateWithHistory<{ id: string }>(
    context,
    {
      action: "PERMISSION_CHANGE",
      entityType: "User",
      entityLabel: row.email,
      revise: false,
      /**
       * METADATA ONLY, and never the hash. `redact()` in lib/audit.ts strips `passwordHash` by name as a
       * backstop; not putting it here is the control.
       */
      before: { passwordChanged: false },
      summary: "The account holder changed their own password"
    },
    async (tx) =>
      tx.user.update({
        where: { id: row.id },
        data: { passwordHash: nextPasswordHash },
        select: { id: true }
      })
  );

  /**
   * ⚠ EVERY OTHER SESSION, AFTER the write.
   *
   * The order matters: if the revocation ran first and the write then failed, every device would be signed
   * out of a password change that never happened — and the reader would be left believing the new password
   * works. This way the worst case is a changed password with other devices still holding live refresh
   * chains, which the response reports so they can be ended deliberately.
   */
  let otherSessionsEnded = 0;
  let thisDeviceStaysSignedIn = false;

  if (keepSessionId !== null) {
    otherSessionsEnded = await revokeOtherSessions(row.id, keepSessionId);
    thisDeviceStaysSignedIn = true;
  } else {
    /**
     * No refresh cookie to identify this device — a caller holding only an access token, or a cookie for a
     * session that has already been revoked. Everything goes, because the alternative is leaving sessions
     * alive that nobody can account for. Said out loud, because the reader is about to be signed out.
     */
    const before = await countActiveSessions(row.id);
    await revokeAllSessionsForUser(row.id);
    otherSessionsEnded = before;
  }

  return ok({
    passwordChanged: true,
    otherSessionsEnded,
    /** ⚠ The client must print this: whether the reader is about to be asked to sign in again. */
    thisDeviceStaysSignedIn,
    message:
      (thisDeviceStaysSignedIn
        ? otherSessionsEnded === 0
          ? "Your password has been changed. No other device was signed in. You are still signed in here."
          : `Your password has been changed and ${otherSessionsEnded === 1 ? "1 other device has" : `${otherSessionsEnded} other devices have`} been signed out. You are still signed in here.`
        : "Your password has been changed and every device has been signed out, including this one, because " +
          "this request could not prove which session it was using. Sign in again with the new password.") +
      ` ${REVOCATION_NOTE}`
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — sign out of every device
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "Sign me out everywhere", including this device.
 *
 * Deliberately ALL of them rather than the others: this is what somebody presses after lending out a laptop
 * or losing a phone, and a version that spared the current session would leave the reader wondering which
 * one it spared. There is no `keep` option for the same reason — an option here is a decision taken under
 * mild alarm.
 *
 * ⚠ THIS DOES NOT CLEAR THE COOKIES. It cannot: the access cookie is set on the response, and a route that
 * cleared it would sign the caller out of the request they are making before they read the answer. A client
 * calling this must follow with `POST /api/auth/logout`, which is the endpoint that owns the cookies —
 * `app/studio/account/page.tsx` does exactly that in its own action.
 */
export const DELETE = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const session = await requireUser();
  const before = await countActiveSessions(session.id);

  await mutateWithHistory<{ id: string }>(
    buildAuditContext(request, session),
    {
      action: "LOGOUT",
      entityType: "User",
      entityLabel: session.email,
      revise: false,
      before: { activeSessions: before },
      summary: "The account holder signed out of every device"
    },
    // The row is touched so the log entry and a real change are written in one transaction, which is the
    // property lib/audit.ts exists to provide.
    async (tx) =>
      tx.user.update({
        where: { id: session.id },
        data: { failedLogins: 0, lockedUntil: null },
        select: { id: true }
      })
  );

  await revokeAllSessionsForUser(session.id);

  return ok({
    sessionsEnded: before,
    message:
      `${before === 1 ? "1 device has" : `${before} devices have`} been signed out, including this one. Sign in ` +
      `again to carry on. ${REVOCATION_NOTE} Call the sign-out endpoint next so this browser's cookies are ` +
      "cleared as well."
  });
});
