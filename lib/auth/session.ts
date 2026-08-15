import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { authEnv } from "./config";
import { verifyPassword } from "./password";

/**
 * Refresh-token sessions, with rotation and reuse detection.
 *
 * THE TOKEN IS NEVER STORED. Only its SHA-256 is, so a database leak yields nothing replayable. The
 * token itself is 32 bytes of CSPRNG output, base64url — long enough that guessing is not a threat
 * model, short enough to sit in a cookie.
 *
 * ROTATION: every successful refresh issues a NEW token and marks the old row `rotatedTo`. If a
 * token that has already been rotated is presented again, exactly one of two things happened — a
 * legitimate client retried after a lost response, or an attacker is replaying a stolen token — and
 * there is no way to tell them apart. The safe reading is theft, so the WHOLE FAMILY is revoked and
 * everyone holding it is signed out. A refresh chain that tolerates reuse provides no more security
 * than a permanent token.
 *
 * `familyId` is what makes that possible: rotation preserves it, so revoking a family revokes every
 * descendant of the login that started it without touching the user's other devices.
 */

const REFRESH_TOKEN_BYTES = 32;

/** Login throttling. Both figures are deliberately generous — this stops scripts, not people. */
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

/** Constant-time comparison of two hex digests of equal length. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export interface IssuedSession {
  sessionId: string;
  familyId: string;
  refreshToken: string;
  expiresAt: Date;
}

export async function createSession(input: {
  userId: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  /** Continues an existing chain on rotation; omitted for a fresh login. */
  familyId?: string;
}): Promise<IssuedSession> {
  const { refreshTtlDays } = authEnv();
  const token = newToken();
  const expiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);
  const familyId = input.familyId ?? randomBytes(16).toString("hex");

  const session = await prisma.session.create({
    data: {
      userId: input.userId,
      refreshTokenHash: hashToken(token),
      familyId,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      ipAddress: input.ipAddress ?? null,
      expiresAt
    }
  });

  return { sessionId: session.id, familyId, refreshToken: token, expiresAt };
}

export type RotateResult =
  | { ok: true; user: User; session: IssuedSession }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "reused" | "user-inactive" };

/** Only the session table is ever written through these helpers, and the type says so. */
type SessionWriter = Pick<Prisma.TransactionClient, "session">;

/** What the rotation transaction decided, before the caller-facing token is attached to it. */
type RotationOutcome =
  | { ok: true; user: User; sessionId: string; familyId: string }
  | { ok: false; reason: Exclude<RotateResult, { ok: true }>["reason"] };

/**
 * Thrown inside the rotation transaction when the guarded update finds the parent already spent.
 *
 * Throwing rather than returning is what undoes the child row created a moment earlier: Prisma rolls
 * an interactive transaction back on a throw, so the loser of the race leaves nothing behind. The
 * family is carried on the error because the revocation has to happen AFTER that rollback — a write
 * made inside the doomed transaction would be rolled back with it.
 */
class RotationRaceLost extends Error {
  constructor(readonly familyId: string) {
    super("refresh token was already rotated by a concurrent request");
    this.name = "RotationRaceLost";
  }
}

/**
 * Exchange a refresh token for a new one.
 *
 * ⚠ THE READ AND THE ROTATION ARE ONE TRANSACTION, AND THE ROTATION IS A COMPARE-AND-SWAP. Both
 * halves matter, and an earlier version of this function had neither: it looked the row up outside
 * `$transaction` and then rotated it with an unconditional `update`, so two refreshes presenting the
 * same stolen token could both read `rotatedTo: null`, both pass the reuse test and both mint a live
 * child. Two chains from one parent means the reuse detector never fires again for that token and the
 * theft it exists to catch goes unnoticed.
 *
 * The lookup now happens on `tx`, and the parent is spent with an `updateMany` whose WHERE clause
 * carries the precondition (`rotatedTo: null, revokedAt: null`). Under Postgres read-committed the
 * second transaction blocks on the row lock and then RE-EVALUATES that clause against the committed
 * row, so it matches nothing and reports `count: 0` — the database, not this code, is what makes a
 * token spendable exactly once. Re-reading the row inside the transaction would not have been enough
 * on its own, because read-committed does not retro-validate a read.
 */
export async function rotateSession(input: {
  refreshToken: string;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<RotateResult> {
  const presentedHash = hashToken(input.refreshToken);
  const { refreshTtlDays } = authEnv();
  const token = newToken();
  const expiresAt = new Date(Date.now() + refreshTtlDays * 24 * 60 * 60 * 1000);

  let outcome: RotationOutcome;

  try {
    outcome = await prisma.$transaction(async (tx): Promise<RotationOutcome> => {
      const existing = await tx.session.findUnique({
        where: { refreshTokenHash: presentedHash },
        include: { user: true }
      });

      if (!existing) return { ok: false, reason: "unknown" };
      // Re-compare in constant time. The unique-index lookup above already leaked nothing (the hash
      // is not a secret), but this keeps the comparison honest if the lookup is ever widened.
      if (!digestsMatch(existing.refreshTokenHash, presentedHash)) {
        return { ok: false, reason: "unknown" };
      }

      if (existing.rotatedTo || existing.revokedAt) {
        // REUSE. Cannot be distinguished from theft, so the family dies. Revoked here rather than
        // afterwards so the refusal and the revocation commit together.
        await revokeFamilyOn(tx, existing.familyId);
        return { ok: false, reason: existing.rotatedTo ? "reused" : "revoked" };
      }

      if (existing.expiresAt.getTime() <= Date.now()) {
        return { ok: false, reason: "expired" };
      }

      if (!existing.user.isActive || existing.user.deletedAt) {
        await revokeFamilyOn(tx, existing.familyId);
        return { ok: false, reason: "user-inactive" };
      }

      const now = new Date();
      const next = await tx.session.create({
        data: {
          userId: existing.userId,
          refreshTokenHash: hashToken(token),
          familyId: existing.familyId,
          userAgent: input.userAgent?.slice(0, 512) ?? existing.userAgent,
          ipAddress: input.ipAddress ?? existing.ipAddress,
          expiresAt
        }
      });

      const { count } = await tx.session.updateMany({
        where: { id: existing.id, rotatedTo: null, revokedAt: null },
        data: { rotatedTo: next.id, revokedAt: now, lastUsedAt: now }
      });

      // Nothing matched, so somebody else spent this parent while we were working. Identical to a
      // replay as far as this request can tell, and treated identically.
      if (count !== 1) throw new RotationRaceLost(existing.familyId);

      return { ok: true, user: existing.user, sessionId: next.id, familyId: existing.familyId };
    });
  } catch (error) {
    if (!(error instanceof RotationRaceLost)) throw error;
    await revokeFamily(error.familyId, "refresh token reuse detected");
    return { ok: false, reason: "reused" };
  }

  if (!outcome.ok) return { ok: false, reason: outcome.reason };

  return {
    ok: true,
    user: outcome.user,
    session: {
      sessionId: outcome.sessionId,
      familyId: outcome.familyId,
      refreshToken: token,
      expiresAt
    }
  };
}

/** The revocation itself, so it can run on the request's transaction or on its own. */
async function revokeFamilyOn(client: SessionWriter, familyId: string): Promise<void> {
  await client.session.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

/** Revoke one chain. Idempotent — a second call on an already-revoked family is a no-op. */
export async function revokeFamily(familyId: string, _reason?: string): Promise<void> {
  await revokeFamilyOn(prisma, familyId);
}

export async function revokeSessionByToken(refreshToken: string): Promise<void> {
  const hash = hashToken(refreshToken);
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: hash } });
  if (!session) return;
  // Sign out THIS device only: logging out of one laptop must not sign the user out of their phone.
  await prisma.session.updateMany({
    where: { id: session.id, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

/** Every device. Used on password change, on demotion, and from the CMS's "sign out everywhere". */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Housekeeping. Expired-and-revoked rows carry no security value and grow without bound. */
export async function pruneExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] }
  });
  return count;
}

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; reason: "invalid" | "locked" | "inactive"; retryAfterMinutes?: number };

/**
 * Verify credentials.
 *
 * ONE FAILURE MESSAGE for a wrong email and a wrong password, and the same work done in both cases —
 * `verifyPassword` runs a dummy comparison when there is no hash, so the response time does not
 * reveal whether the address is registered. An institution's staff directory is public; its login
 * form must not confirm which of those addresses can sign in.
 */
export async function verifyCredentials(email: string, password: string): Promise<LoginResult> {
  const normalised = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalised } });

  if (!user) {
    // Still pay the hashing cost, then refuse.
    await verifyPassword(password, null);
    return { ok: false, reason: "invalid" };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const retryAfterMinutes = Math.max(
      1,
      Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
    );
    return { ok: false, reason: "locked", retryAfterMinutes };
  }

  const matches = await verifyPassword(password, user.passwordHash);

  if (!matches) {
    /**
     * ⚠ A LAPSED LOCK IS A FRESH START, AND THE COUNTER HAS TO SAY SO.
     *
     * Reaching this line with `lockedUntil` set means the lock has already expired — the branch above
     * returned while it had not. Carrying the old count forward is what an earlier version did, and it
     * quietly turned the allowance into ONE attempt for ever: at eight failures the account locks, and
     * every later wrong password made it nine, ten, eleven — each one over the threshold, each one
     * re-arming a full fifteen minutes. The person served the pause, came back, mistyped once and was
     * locked again, with the screen still promising eight tries. The figures above are meant to stop
     * scripts, and per-IP rate limiting is what actually does that; this counter must not become a
     * permanent penalty on somebody who has genuinely forgotten their password.
     *
     * `lockedUntil` is nulled whenever the new count is under the threshold, so a stale timestamp is
     * not left behind to be read as a lock that was never lifted.
     */
    const failedLogins = (user.lockedUntil ? 0 : user.failedLogins) + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins,
        lockedUntil:
          failedLogins >= MAX_FAILED_LOGINS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
            : null
      }
    });
    return { ok: false, reason: "invalid" };
  }

  // The account exists and the password is right — but it may still be disabled. This is checked
  // AFTER the password so a disabled account cannot be used to confirm a valid credential pair.
  if (!user.isActive || user.deletedAt) {
    return { ok: false, reason: "inactive" };
  }

  /**
   * The password was right, so the failure counter and any lockout are cleared here.
   *
   * ⚠ `lastLoginAt` IS DELIBERATELY *NOT* WRITTEN HERE. A correct password is not a sign-in: for an
   * account with a second factor the request may still end with `{ twoFactorRequired: true }` or a
   * rejected code and no session at all. Stamping the column at this point means anybody holding a
   * 2FA-protected editor's password can move "last signed in" to the present minute without ever
   * getting in — so the real owner's account screen tells them they signed in when they did not, and
   * whoever investigates a suspected compromise reads a timestamp that describes an attempt rather than
   * an entry. `markSignedIn()` below is called by the login route once a session genuinely exists.
   */
  const refreshed = await prisma.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null }
  });

  return { ok: true, user: refreshed };
}

/**
 * Record that a sign-in COMPLETED.
 *
 * Called by the login route after `createSession`, never before — see the note above. Failures are
 * swallowed: a session that exists must not be reported as a failed login because a bookkeeping write
 * lost a race, and the worst consequence of a missed stamp is one stale timestamp.
 */
export async function markSignedIn(userId: string): Promise<void> {
  try {
    await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  } catch (error) {
    console.error("[auth] could not record lastLoginAt", userId, error);
  }
}
