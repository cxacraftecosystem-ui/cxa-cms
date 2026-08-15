import { createHash, createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
// `Prisma` is imported as a VALUE, not merely as a type: `Prisma.sql` is the tagged template `$queryRaw`
// needs for the administrator lock. See `lockActiveAdministrators`.
import { Prisma, type AuthProvider, type Role } from "@prisma/client";
import { assertSameOrigin, badRequest, conflict, forbidden, ok, route } from "@/lib/api";
import { countActiveByRole } from "@/lib/auth/access";
import { requireCapability } from "@/lib/auth/current-user";
import { OAUTH_PROVIDERS } from "@/lib/auth/oauth";
import { revokeAllSessionsForUser } from "@/lib/auth/session";
import { mutateWithHistory, type TxClient } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { authEnv, siteUrl } from "@/lib/env";
import {
  ROLES_DESCENDING,
  ROLE_LABELS,
  canAssignRole,
  canManageUser,
  canManageUsers
} from "@/lib/permissions";
import { buildAuditContext, found, parseStudioJson } from "@/lib/studio/crud";

/**
 * One person's account: what they may do, whether they may sign in, and helping them back in.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * A ROLE CHANGE REVOKES THE TARGET'S SESSIONS. THIS IS THE MOST IMPORTANT LINE IN THE FILE.
 *
 * An access token is a bearer of claims, not a session: it carries the role so middleware can route
 * without a database read, and it stays valid until it expires — up to thirty minutes by default. Without
 * a revocation, a demoted editor keeps a token that still SAYS "editor" for that whole window, and the
 * demotion is a request rather than a fact. Every write already re-reads the row (`requireUser()` does),
 * so the damage is bounded — but "bounded" is not "none", and a demotion taken during an incident has to
 * take effect at once.
 *
 * `revokeAllSessionsForUser()` kills the refresh chains, so nothing can be renewed. The remaining access
 * tokens die on their own clock, and the response SAYS SO rather than implying the person is out
 * immediately: an administrator who has just removed somebody's access needs to know whether it is done.
 *
 * DEACTIVATION REVOKES TOO, for the same reason. A SOFT DELETE revokes as well.
 *
 * NO SECRET COLUMN IS EVER SELECTED INTO A RESPONSE. `passwordHash`, `twoFactorSecret` and
 * `twoFactorRecoveryCodes` appear in no answer this file gives. Every read and every update names its
 * columns; `select: undefined` returning the whole row is how a hash leaks. `passwordHash` IS read in one
 * place — to bind the password link to the account's current credential state — and it is turned into a
 * 16-character digest before it goes anywhere.
 *
 * NOBODY HERE SETS SOMEBODY ELSE'S PASSWORD. A reset issues a single-use, time-limited link; it never
 * generates a password, never emails one and never returns one. It also REVOKES EVERY SESSION, and the
 * response says that in words the UI can print — a reset is the answer to "somebody may be in my account",
 * and it is worth nothing if their devices stay signed in.
 *
 * ⚠ THE LAST ACTIVE ADMINISTRATOR CANNOT BE DEMOTED, DEACTIVATED OR DELETED. `canAssignRole` deliberately
 * PERMITS self-demotion — the ladder is not what stops this — so the guard is a COUNT, checked here. The
 * users screen refuses it too; that is a courtesy, and this is the boundary. Without it one click locks
 * every person out of users, settings, navigation and the recycle bin, with no way back in through the
 * application at all.
 *
 * ⚠ AND THE COUNT THAT GUARDS IT IS TAKEN WITH THE ADMINISTRATORS' ROWS LOCKED, INSIDE THE TRANSACTION THAT
 * WRITES. A count taken beforehand is a reading of the past: two administrators demoting each other at the
 * same moment each see two, each pass the guard, and the installation ends with nobody who can administer
 * it. There is no way back from that through the application. `lockActiveAdministrators` is what makes the
 * two requests take their turns; the count outside the transaction is kept as well, because it can refuse
 * the ordinary case earlier and with a better sentence.
 *
 * ⚠ THE SAME GUARD RUNS AGAIN, SEPARATELY, FOR MASTER ADMINISTRATORS — and the separate one is the more
 * important of the two. An installation with administrators but no master admin still looks healthy: pages
 * publish, settings save, nothing errors. What has silently gone is the ability to put ANYBODY ELSE on the
 * studio access list, so no colleague can ever be added again and the loss is discovered weeks later by
 * somebody who cannot fix it. Two counts, two locks, two refusals: a master admin is not an administrator
 * by role, so one count could never have covered both.
 *
 * ⚠ A SIGN-IN METHOD MAY NOT BE UNLINKED IF IT IS THE LAST ONE ON AN ACCOUNT WITH NO PASSWORD. Somebody
 * invited who signed in with Google and never set a password has exactly one door; removing it leaves an
 * account that exists, is active, has a role — and can never be entered again by anybody, including a
 * master admin. The refusal NAMES that rule, because "cannot unlink" with no reason reads as a fault.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const RESET_TTL_HOURS = 2;
const SET_PASSWORD_PATH = "/studio/set-password";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The credential token
//
// ⚠ A VERBATIM COPY of the construction in `app/api/studio/users/route.ts`. Next type-checks a `route.ts`
// against a fixed set of allowed exports, so a helper cannot be shared between two of them. **The two
// copies must stay identical**: a token minted by one and refused by the other is a colleague locked out
// holding a link that looks perfectly valid. It belongs in `lib/auth/` — lift it there when that directory
// is next touched, and delete both copies in the same commit.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

interface CredentialTokenPayload {
  v: 1;
  sub: string;
  purpose: "invite" | "reset";
  exp: number;
  cred: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A short digest of "what the password is now" — the entire single-use guarantee.
 *
 * The hash itself never goes into the token; 16 hex characters of a SHA-256 of it do, which is not enough
 * to attack and is enough to notice a change. Once a password is set the digest differs and every token
 * minted before it stops verifying, with no row to expire and no window in which a used link still works.
 */
function credentialFingerprint(passwordHash: string | null): string {
  return createHash("sha256").update(passwordHash ?? "no-password").digest("hex").slice(0, 16);
}

function mintCredentialToken(payload: CredentialTokenPayload): string {
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(createHmac("sha256", authEnv().secret).update(body).digest());
  return `${body}.${signature}`;
}

function issueResetLink(userId: string, passwordHash: string | null) {
  const expiresAt = new Date(Date.now() + RESET_TTL_HOURS * 60 * 60 * 1000);
  const token = mintCredentialToken({
    v: 1,
    sub: userId,
    purpose: "reset",
    exp: Math.floor(expiresAt.getTime() / 1000),
    cred: credentialFingerprint(passwordHash)
  });
  return {
    token,
    link: `${siteUrl()}${SET_PASSWORD_PATH}?token=${encodeURIComponent(token)}`,
    expiresAt
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** ⚠ Written out, every time. See the header: `select: undefined` is how a bcrypt hash leaves the server. */
const safeSelect = {
  id: true,
  name: true,
  email: true,
  title: true,
  role: true,
  avatarId: true,
  isActive: true,
  canPublish: true,
  canManageMedia: true,
  twoFactorEnabled: true,
  twoFactorRecoveryCodes: true,
  lastLoginAt: true,
  failedLogins: true,
  lockedUntil: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  /**
   * THE LINKED SIGN-IN METHODS. Nothing here is a secret — a provider's `sub` is an opaque identifier the
   * provider itself hands to anybody who signs in, and the email is already on the row above — and an
   * administrator investigating an account has to know it can be entered with a Google login. An account
   * screen that shows only "two-step verification: on" while a linked provider quietly opens the same door
   * is a screen that misleads the person auditing it.
   */
  oauthAccounts: {
    select: { id: true, provider: true, email: true, createdAt: true, lastUsedAt: true },
    // Oldest link first, so the list reads as a history rather than reshuffling between requests.
    orderBy: { createdAt: "asc" }
  }
} as const;

type SafeRow = Prisma.UserGetPayload<{ select: typeof safeSelect }>;

/**
 * Turn the one array that must never be returned into the number the screen actually wants.
 *
 * Destructured away rather than deleted from a copy: a `delete` on a spread object is one careless refactor
 * from being dropped, and this way the compiler is what keeps the codes out of the response.
 *
 * `hasPassword` is passed IN rather than read from the row, because `passwordHash` is deliberately not in
 * `safeSelect` — see `passwordIsSet`.
 */
function toRow(row: SafeRow, activeSessions: number, hasPassword: boolean) {
  const { twoFactorRecoveryCodes, ...rest } = row;
  return { ...rest, recoveryCodesLeft: twoFactorRecoveryCodes.length, activeSessions, hasPassword };
}

/**
 * The row as an audit snapshot.
 *
 * Deliberately NOT `toRow(row, 0)`: that would record "0 devices were signed in" as a fact when nobody
 * counted, and a number in an audit log is read as measured. `redact()` in lib/audit.ts strips the secret
 * columns by name as a backstop; this is the control.
 */
function toAuditSnapshot(row: SafeRow) {
  const { twoFactorRecoveryCodes, ...rest } = row;
  return { ...rest, recoveryCodesLeft: twoFactorRecoveryCodes.length };
}

function isRole(value: string): value is Role {
  return (ROLES_DESCENDING as readonly string[]).includes(value);
}

async function countActiveSessions(userId: string): Promise<number> {
  return prisma.session.count({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }
  });
}

/**
 * Does this account have a password at all?
 *
 * ⚠ A QUERY OF ITS OWN, ON PURPOSE. `passwordHash` is NOT in `safeSelect` and must not be added to it: the
 * moment it is, every `select: safeSelect` in this file — including the one whose result becomes an audit
 * payload — is carrying a bcrypt hash, and only a destructure stands between it and a response. Here the
 * column exists for the length of one expression and what leaves is a boolean.
 *
 * The screen needs the answer because it changes what is safe to do: an account with no password is one
 * whose linked providers are its ONLY way in.
 */
async function passwordIsSet(userId: string): Promise<boolean> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  return typeof row?.passwordHash === "string" && row.passwordHash.length > 0;
}

async function countActiveAdministrators(): Promise<number> {
  return prisma.user.count({ where: { deletedAt: null, isActive: true, role: "ADMINISTRATOR" } });
}

/**
 * How many active accounts hold `role`, from the SHARED counter in lib/auth/access.ts.
 *
 * Not a second `prisma.user.count` written here, because the access console counts master administrators to
 * decide whether a grant may be revoked and this route counts them to decide whether one may be demoted. Two
 * hand-rolled counts that disagree about whether an inactive-but-not-deleted account still counts is exactly
 * how one screen refuses what the other allows.
 *
 * ⚠ THE CAST IS ABOUT TWO TYPE SIGNATURES, NOT ABOUT THE RUNTIME. `countActiveByRole` accepts a structural
 * stand-in for a client — `{ user: { count: (args: unknown) => … } }` — and Prisma's `count` is an overloaded
 * generic whose parameter cannot satisfy that under `strictFunctionTypes`: a function that accepts a narrow
 * argument is not a function that accepts anything. What is passed is the real client, transaction or not.
 * Written once here so the cast appears in one place and every call site reads plainly.
 */
function countActiveHolders(client: TxClient, role: Role): Promise<number> {
  return countActiveByRole(client as never, role);
}

/** The early answer for the tier above administrator. See `lockActiveMasterAdmins` for the real guard. */
async function countActiveMasterAdmins(): Promise<number> {
  return countActiveHolders(prisma, "MASTER_ADMIN");
}

/**
 * The same count, taken INSIDE a transaction with every administrator's row held until it commits.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE GUARD. The count outside is an early answer, not a guarantee — and simply moving that count
 * inside the transaction would not have been one either, because at Postgres's default READ COMMITTED a
 * transaction cannot see another's uncommitted work: two requests demoting two different administrators
 * would both count two and both write.
 *
 * `FOR UPDATE` closes it. The second request blocks here until the first commits, and when it is released
 * Postgres re-tests the row it was waiting on against this `WHERE` clause: the administrator the first
 * request demoted no longer matches, so it is not returned. The second request therefore counts one, and
 * refuses. That re-test is why the count is the NUMBER OF ROWS THIS QUERY RETURNED rather than a separate
 * `count()` — the locked rows are the ones the answer must be built from.
 *
 * `ORDER BY "id"` is not cosmetic: two of these queries running together lock the same rows, and locking
 * them in a fixed order is what stops the pair deadlocking each other.
 *
 * Called ONLY on a write that can remove an administrator — a demotion, a deactivation, a deletion. An
 * ordinary save of somebody's name must not queue behind the administrators' rows.
 *
 * `"users"` is `User`'s table (`@@map`), and `"Role"` is the enum type the `role` column is declared with.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function lockActiveAdministrators(tx: TxClient): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "users"
               WHERE "role" = 'ADMINISTRATOR' AND "isActive" = true AND "deletedAt" IS NULL
               ORDER BY "id"
               FOR UPDATE`
  );
  return rows.length;
}

/**
 * The same protection for the tier above, and it is the one that matters more.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT IS A SECOND FUNCTION AND NOT A `role` PARAMETER. The role has to reach `FOR UPDATE` as part of the
 * statement, and interpolating an enum value into raw SQL — even one from a closed union — is a pattern that
 * survives exactly until somebody passes it a string from a request body. Two literal statements cannot be
 * misused, and there will never be a third tier above this one.
 *
 * WHY THE LOCK AND THEN `countActiveByRole`, RATHER THAN THE ROW COUNT. The `FOR UPDATE` is what serialises
 * two requests: the second blocks here until the first commits. The ANSWER then comes from the shared
 * counter, so this route and the access console can never disagree about how many master administrators
 * there are. That is safe because the count runs as a later statement in the same transaction, and at READ
 * COMMITTED each statement takes a fresh snapshot — so it sees the demotion the first request has just
 * committed, which is precisely the state the decision must be made against.
 *
 * Called ONLY on a write that can remove a master administrator. An ordinary save must not queue behind
 * rows it is not touching.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function lockActiveMasterAdmins(tx: TxClient): Promise<number> {
  await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "users"
               WHERE "role" = 'MASTER_ADMIN' AND "isActive" = true AND "deletedAt" IS NULL
               ORDER BY "id"
               FOR UPDATE`
  );
  return countActiveHolders(tx, "MASTER_ADMIN");
}

/**
 * The refusal when the race actually happened.
 *
 * A different sentence from the three checked before the transaction, because a different thing has
 * occurred: the reader's screen was right when they pressed the button and somebody else changed the
 * answer in the meantime. Saying so is what stops them pressing it again.
 */
const LAST_ADMINISTRATOR_RACE =
  "Somebody else changed an administrator's access at the same moment, and this is now the only active " +
  "administrator on this installation. Nothing has been changed — if it had, nobody could manage users, " +
  "settings, navigation or the recycle bin, and there would be no way back in through the site itself. " +
  "Make somebody else an administrator first, then try again.";

/**
 * The master administrator refusals.
 *
 * They say what is actually lost, which is different from what an administrator's loss would be and far
 * easier to overlook: the site goes on working perfectly, and only the ability to let a new colleague in
 * has gone. Somebody told "this would leave no master administrator" and nothing else would reasonably
 * conclude it did not matter.
 */
const LAST_MASTER_ADMIN =
  "This is the only master administrator on this installation, so their access cannot be lowered. Nothing " +
  "would appear to break — pages would still publish and settings would still save — but nobody could ever " +
  "add another colleague to the studio access list again, and no account could be promoted back to master " +
  "administrator from inside the studio. Make somebody else a master administrator first.";

const LAST_MASTER_ADMIN_RACE =
  "Somebody else changed a master administrator's account at the same moment, and this is now the only one " +
  "left. Nothing has been changed. If it had, nobody could ever add another colleague to the studio access " +
  "list again. Make somebody else a master administrator first, then try again.";

/**
 * The sentence every revocation answers with.
 *
 * Honest about the window rather than claiming the person is out this instant: their refresh chains are
 * dead, so nothing renews, but an access token already in a browser lives out its own clock.
 */
const REVOCATION_NOTE =
  "Every device they were signed in on has to sign in again. A page they already have open may keep " +
  "reading the studio for up to half an hour until its short-lived token expires, but it cannot renew and " +
  "every change it attempts is checked against the account as it is now.";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const GET = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    await requireCapability(
      canManageUsers,
      "Managing people needs administrator access. Ask an administrator to look it up for you."
    );

    const { id } = await params;
    const row = found(await prisma.user.findUnique({ where: { id }, select: safeSelect }), "That account");

    return ok({
      user: toRow(row, await countActiveSessions(row.id), await passwordIsSet(row.id)),
      activeAdministrators: await countActiveAdministrators(),
      /**
       * Both counts, on every answer. The screen needs them to explain why a control is absent, and the
       * two are separate numbers because the two lockouts are separate failures.
       */
      activeMasterAdmins: await countActiveMasterAdmins()
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PATCH — change fields
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PatchBody = z.object({
  name: z.string().trim().min(1, "A name is needed.").max(200).optional(),
  title: z.string().trim().max(200).optional(),
  role: z.string().trim().max(40).optional(),
  isActive: z.boolean().optional(),
  canPublish: z.boolean().optional(),
  canManageMedia: z.boolean().optional(),
  /** Clears `deletedAt`. The only way back for a soft-deleted account — see the note where it is used. */
  restore: z.literal(true).optional()
});

export const PATCH = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageUsers,
      "Changing what somebody can do needs administrator access."
    );

    const { id } = await params;
    const body = await parseStudioJson(request, PatchBody);

    const target = found(await prisma.user.findUnique({ where: { id }, select: safeSelect }), "That account");

    /**
     * A DELETED ACCOUNT ACCEPTS ONLY A RESTORE.
     *
     * Accounts are not in the recycle bin (that screen explains why), so without this branch a row that had
     * been soft-deleted through the API could never come back and no screen would ever show it again.
     * Editing one otherwise would be changing what a person who cannot sign in is allowed to do.
     */
    if (target.deletedAt && body.restore !== true) {
      throw conflict(
        "That account has been deleted, so nothing about it can be changed. Restore it first, then set what it may do."
      );
    }

    const changes: Prisma.UserUpdateInput = {};
    const reasons: string[] = [];
    /** Set by any change that must not leave a valid token behind. See the file header. */
    let revokeSessions = false;
    /**
     * Set by any change that takes an ACTIVE ADMINISTRATOR out of that set — a demotion or a deactivation.
     * It decides whether the write takes the administrator lock, so an ordinary edit does not queue behind
     * rows it is not touching.
     */
    let mayRemoveAnAdministrator = false;
    /**
     * The same, for the tier above. A SEPARATE flag rather than one "may remove somebody important",
     * because the two locks are separate statements over separate rows and a single flag would make every
     * demotion of an editor queue behind both sets.
     */
    let mayRemoveAMasterAdmin = false;

    // ── The level of access ─────────────────────────────────────────────────────────────────────
    if (body.role !== undefined) {
      if (!isRole(body.role)) {
        throw badRequest(
          `There is no level of access called “${body.role}”. The levels on this site are: ${ROLES_DESCENDING.join(", ")}.`
        );
      }
      const nextRole: Role = body.role;

      if (nextRole !== target.role) {
        /**
         * THE LADDER, from the predicate. Three rules live in `canAssignRole`: only an administrator manages
         * users; nobody assigns a role above their own tier; nobody manages a user at or above their tier,
         * except themselves. Restating any of them here would be the second rank test that eventually
         * disagrees with the first.
         */
        if (!canAssignRole(actor, { id: target.id, role: target.role }, nextRole)) {
          throw forbidden(
            target.id === actor.id
              ? "You cannot raise your own level of access. Ask an administrator with more access than you have."
              : "You cannot change this person's level of access, because they are at the same level as you or above it. Only somebody with more access than they have can change it."
          );
        }

        // ⚠ THE COUNT, not a permission. See the file header. This one is the EARLY answer; the count that
        // actually guards the invariant is taken inside the transaction below.
        const demotingAnAdministrator =
          target.role === "ADMINISTRATOR" &&
          nextRole !== "ADMINISTRATOR" &&
          target.isActive &&
          !target.deletedAt;

        if (demotingAnAdministrator && (await countActiveAdministrators()) <= 1) {
          throw conflict(
            "This is the only active administrator on this installation, so their access cannot be lowered. If it were, nobody could manage users, settings, navigation or the recycle bin, and there would be no way back in through the site itself. Make somebody else an administrator first."
          );
        }
        if (demotingAnAdministrator) mayRemoveAnAdministrator = true;

        // ⚠ AND THE SAME QUESTION FOR THE TIER ABOVE, asked separately. A master admin does not hold the
        // role `ADMINISTRATOR`, so the count above never saw them and never could have.
        const demotingAMasterAdmin =
          target.role === "MASTER_ADMIN" &&
          nextRole !== "MASTER_ADMIN" &&
          target.isActive &&
          !target.deletedAt;

        if (demotingAMasterAdmin && (await countActiveMasterAdmins()) <= 1) {
          throw conflict(LAST_MASTER_ADMIN);
        }
        if (demotingAMasterAdmin) mayRemoveAMasterAdmin = true;

        changes.role = nextRole;
        // ⚠ NOT OPTIONAL. Without this the demotion is a request rather than a fact.
        revokeSessions = true;
        reasons.push(
          `Their level of access is now ${ROLE_LABELS[nextRole].toLowerCase()}, and every device they were signed in on has been signed out.`
        );
      }
    }

    // ── The two grants ──────────────────────────────────────────────────────────────────────────
    /**
     * `canPublish` and `canManageMedia` only ever WIDEN a role (lib/permissions.ts ORs them into the rank
     * test), so granting one to yourself is self-escalation. `canManageUser` returns false for yourself,
     * which is exactly the refusal wanted — and it also refuses a target at or above the actor's tier.
     */
    const grantsRequested = body.canPublish !== undefined || body.canManageMedia !== undefined;
    const nameRequested = body.name !== undefined || body.title !== undefined;

    if ((grantsRequested || nameRequested || body.isActive !== undefined) &&
        !canManageUser(actor, { id: target.id, role: target.role })) {
      throw forbidden(
        target.id === actor.id
          ? "You cannot change your own account from this screen. Your name, your picture and your password are on your own account screen, where changing the way you sign in asks for your password first."
          : "You cannot change this account, because this person is at the same level of access as you or above it. Only somebody with more access than they have can do it."
      );
    }

    if (body.canPublish !== undefined && body.canPublish !== target.canPublish) {
      changes.canPublish = body.canPublish;
      reasons.push(
        body.canPublish
          ? "They can put things on the public site now, without an editor's access to everybody else's work."
          : "They can no longer publish beyond what their level of access allows."
      );
    }
    if (body.canManageMedia !== undefined && body.canManageMedia !== target.canManageMedia) {
      changes.canManageMedia = body.canManageMedia;
      reasons.push(
        body.canManageMedia
          ? "They can look after the media library and the file store now."
          : "They no longer have media access beyond what their level of access allows."
      );
    }

    if (body.name !== undefined && body.name !== target.name) changes.name = body.name;
    if (body.title !== undefined) {
      // `""` from a cleared box means NO title, which is null — not an empty string in a column that is
      // read as "has a title".
      changes.title = body.title.length > 0 ? body.title : null;
    }

    // ── Switching the account off, or back on ───────────────────────────────────────────────────
    if (body.isActive !== undefined && body.isActive !== target.isActive) {
      if (!body.isActive) {
        // The early answer again. `target.isActive` is true here — this branch only runs when the value is
        // changing — so an administrator being switched off is always one of the counted ones.
        const deactivatingAnAdministrator = target.role === "ADMINISTRATOR" && !target.deletedAt;

        if (deactivatingAnAdministrator && (await countActiveAdministrators()) <= 1) {
          throw conflict(
            "This is the only active administrator on this installation. Switching the account off would lock everybody out of users, settings, navigation and the recycle bin. Make somebody else an administrator first."
          );
        }
        if (deactivatingAnAdministrator) mayRemoveAnAdministrator = true;

        // Switching off is as complete a removal as a demotion, so the master-administrator count is asked
        // here too. A switched-off master admin cannot sign in, and therefore cannot add anybody.
        const deactivatingAMasterAdmin = target.role === "MASTER_ADMIN" && !target.deletedAt;

        if (deactivatingAMasterAdmin && (await countActiveMasterAdmins()) <= 1) {
          throw conflict(
            "This is the only master administrator on this installation. Switching the account off would leave nobody able to add a colleague to the studio access list, and nothing on screen would look wrong until somebody tried. Make somebody else a master administrator first."
          );
        }
        if (deactivatingAMasterAdmin) mayRemoveAMasterAdmin = true;

        changes.isActive = false;
        // ⚠ A switched-off account whose devices stay signed in is not switched off.
        revokeSessions = true;
        reasons.push("The account cannot sign in, and every device it was signed in on has been signed out.");
      } else {
        changes.isActive = true;
        // Deliberately NOT a revocation: switching an account back on restores access, and there is nothing
        // to protect against by signing out sessions that are already dead.
        changes.failedLogins = 0;
        changes.lockedUntil = null;
        reasons.push("They can sign in again, with the level of access they had before.");
      }
    }

    // ── Restoring a deleted account ─────────────────────────────────────────────────────────────
    if (body.restore === true) {
      if (!canManageUser(actor, { id: target.id, role: target.role })) {
        throw forbidden(
          "You cannot restore this account, because this person is at the same level of access as you or above it."
        );
      }
      if (!target.deletedAt) {
        throw conflict("That account has not been deleted, so there is nothing to restore.");
      }
      const clash = await prisma.user.findFirst({
        where: { email: target.email, deletedAt: null, id: { not: target.id } },
        select: { id: true }
      });
      if (clash) {
        // Two live rows on one address is a coin toss over which one signs in, and `email` is unique — so
        // this is refused with the reason rather than left to a constraint violation nobody can read.
        throw conflict(
          "Another account now uses that email address, so this one cannot be brought back under it. Change the other account's address first."
        );
      }
      changes.deletedAt = null;
      /**
       * Restored SWITCHED OFF, whatever it was before. Bringing an account back and letting it sign in the
       * same instant is two decisions taken with one click; an administrator who wanted both makes the
       * second one deliberately.
       */
      changes.isActive = false;
      reasons.push(
        "The account is back, switched off. Switch it on when you are satisfied it should be able to sign in again."
      );
    }

    if (Object.keys(changes).length === 0) {
      // Not an error. A no-op save is what a checkbox toggled twice produces, and answering 422 for it
      // would put an error banner on a screen where nothing is wrong.
      return ok({
        user: toRow(target, await countActiveSessions(target.id), await passwordIsSet(target.id)),
        changed: false,
        sessionsRevoked: false,
        activeAdministrators: await countActiveAdministrators(),
        activeMasterAdmins: await countActiveMasterAdmins(),
        message: "Nothing was different, so nothing has been changed."
      });
    }

    const context = buildAuditContext(request, actor);
    /**
     * PERMISSION_CHANGE when the level or a grant moved, UPDATE otherwise.
     *
     * The audit screen colours PERMISSION_CHANGE as an `error` tone on purpose: it is the entry class
     * somebody reads first during an incident, and mislabelling a role change as an ordinary update would
     * bury it among a hundred content saves.
     */
    const isPermissionChange =
      changes.role !== undefined ||
      changes.canPublish !== undefined ||
      changes.canManageMedia !== undefined ||
      changes.isActive !== undefined ||
      changes.deletedAt !== undefined;

    const updated = await mutateWithHistory<SafeRow>(
      context,
      {
        action: isPermissionChange ? "PERMISSION_CHANGE" : "UPDATE",
        entityType: "User",
        entityLabel: `${target.name} <${target.email}>`,
        // No revision: a user row is not versioned content. The audit entry holds the before and after.
        revise: false,
        before: toAuditSnapshot(target)
      },
      async (tx) => {
        /**
         * ⚠ THE REAL GUARD, immediately before the write and inside its transaction.
         *
         * The count near the top of this handler ran before any transaction existed, so by the time the
         * write lands it describes a state that may be two demotions old. This one holds the
         * administrators' rows until the transaction commits, which is what makes two simultaneous
         * demotions take their turns instead of both succeeding. See `lockActiveAdministrators`.
         */
        if (mayRemoveAnAdministrator && (await lockActiveAdministrators(tx)) <= 1) {
          throw conflict(LAST_ADMINISTRATOR_RACE);
        }
        // ⚠ AND THE SAME, SEPARATELY, for the tier above. Two master admins demoting each other at the same
        // moment would otherwise each count two and leave none — an installation that can still publish and
        // can never again add a colleague.
        if (mayRemoveAMasterAdmin && (await lockActiveMasterAdmins(tx)) <= 1) {
          throw conflict(LAST_MASTER_ADMIN_RACE);
        }

        return tx.user.update({ where: { id: target.id }, data: changes, select: safeSelect });
      }
    );

    /**
     * REVOKED AFTER THE ROW IS WRITTEN, and outside its transaction.
     *
     * The order is deliberate. If the revocation failed and the write had not happened, the account would
     * be signed out of a change that was never made — confusing, and it would look like the demotion had
     * taken effect. This way the worst case is a demoted account whose sessions survive their own expiry,
     * which the response reports so an administrator can end them by hand.
     */
    let sessionsRevoked = false;
    if (revokeSessions) {
      await revokeAllSessionsForUser(target.id);
      sessionsRevoked = true;
    }

    return ok({
      user: toRow(updated, await countActiveSessions(updated.id), await passwordIsSet(updated.id)),
      changed: true,
      sessionsRevoked,
      activeAdministrators: await countActiveAdministrators(),
      activeMasterAdmins: await countActiveMasterAdmins(),
      message: [...reasons, ...(sessionsRevoked ? [REVOCATION_NOTE] : [])].join(" ") ||
        "The account has been saved."
    });
  }
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// POST — the actions that are not field changes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ActionBody = z.object({
  action: z.enum(["password-reset", "revoke-sessions", "disable-two-factor", "unlink-provider"]),
  /**
   * Which linked sign-in method to remove. Required by `unlink-provider` and ignored by the others — a
   * discriminated union would be tidier and would make the client build a different body per action, which
   * is a cost paid on every call for one optional field.
   *
   * `OAUTH_PROVIDERS` rather than the whole `AuthProvider` enum: PASSWORD is not a linked account and there
   * is no row to remove for it.
   */
  provider: z.enum(OAUTH_PROVIDERS).optional()
});

/**
 * Every way into an account, as a person reads it.
 *
 * Written out here rather than taken from `providerConfig().label`, because that returns null for a provider
 * whose credentials are no longer configured — and a provider being switched off is one of the reasons an
 * administrator unlinks it. A refusal reading "cannot unlink null" would be the result.
 *
 * A TOTAL `Record<AuthProvider, …>`, so adding a provider to the enum is a compile error here rather than a
 * blank word in a refusal. `PASSWORD` is phrased to sit in a list — "they can still sign in with a password
 * or Google" — because that is the only sentence it appears in.
 */
const METHOD_LABELS: Record<AuthProvider, string> = {
  PASSWORD: "a password",
  GOOGLE: "Google",
  MICROSOFT: "Microsoft",
  YAHOO: "Yahoo"
};

export const POST = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(
      canManageUsers,
      "This needs administrator access."
    );

    const { id } = await params;
    const { action, provider } = await parseStudioJson(request, ActionBody);

    /**
     * `passwordHash` IS read here — and only here — because the password link is bound to the account's
     * current credential state, which is what makes it single-use. It becomes a 16-character digest inside
     * `issueResetLink` and never leaves this function in any other form.
     */
    const target = found(
      await prisma.user.findUnique({ where: { id }, select: { ...safeSelect, passwordHash: true } }),
      "That account"
    );
    if (target.deletedAt) {
      throw conflict("That account has been deleted. Restore it before helping somebody back into it.");
    }

    const context = buildAuditContext(request, actor);
    /**
     * Pulled out on its own line so it is obvious that this value is used for ONE thing and never returned.
     * `target` itself is never put in a response by this handler — check that before adding one.
     */
    const { passwordHash } = target;

    // ── Sign out of every device ────────────────────────────────────────────────────────────────
    if (action === "revoke-sessions") {
      /**
       * ALLOWED ON YOUR OWN ACCOUNT. Signing yourself out everywhere is not a privilege escalation and it
       * is the correct answer to a lost laptop, so `canManageUser` — which refuses self — is not the test
       * here. For anybody else it is.
       */
      if (target.id !== actor.id && !canManageUser(actor, { id: target.id, role: target.role })) {
        throw forbidden(
          "You cannot end this person's sessions, because they are at the same level of access as you or above it."
        );
      }

      const before = await countActiveSessions(target.id);
      await revokeAllSessionsForUser(target.id);
      /**
       * The sessions are many rows and none of them is the entity, so there is no single row for this write
       * to be atomic WITH. Rather than fall back to `recordEvent` — a log entry with no change beside it —
       * the account row is touched in the same transaction as the log entry, which keeps the property
       * lib/audit.ts exists to provide: the entry cannot exist without a change, nor the change without it.
       */
      await mutateWithHistory<{ id: string }>(
        context,
        {
          action: "PERMISSION_CHANGE",
          entityType: "User",
          entityLabel: `${target.name} <${target.email}>`,
          revise: false,
          before: { activeSessions: before }
        },
        // `failedLogins` is reset because a sign-out-everywhere is usually part of helping somebody back in,
        // and a throttle left running would block their first attempt after it.
        async (tx) =>
          tx.user.update({
            where: { id: target.id },
            data: { failedLogins: 0, lockedUntil: null },
            select: { id: true }
          })
      );

      return ok({
        sessionsEnded: before,
        message:
          before === 0
            ? `No devices appeared to be signed in as ${target.name}. Any that were are now signed out. ${REVOCATION_NOTE}`
            : `${before === 1 ? "1 device" : `${before} devices`} signed out. ${REVOCATION_NOTE}`
      });
    }

    // ── Switch off two-step verification ────────────────────────────────────────────────────────
    if (action === "disable-two-factor") {
      if (target.id === actor.id) {
        /**
         * REFUSED FOR YOURSELF, and the reason is not tidiness. Switching your own second factor off asks
         * for your password on the account screen, because a session is not proof of presence — somebody
         * at an unlocked laptop must not be able to remove the control that exists to stop them. This route
         * has no password to check, so it must not become the way round that.
         */
        throw forbidden(
          "Switch your own two-step verification off from your account screen, where it asks for your password first. A session on its own is not proof that it is you."
        );
      }
      if (!canManageUser(actor, { id: target.id, role: target.role })) {
        throw forbidden(
          "You cannot change this person's two-step verification, because they are at the same level of access as you or above it."
        );
      }
      if (!target.twoFactorEnabled) {
        throw conflict("Two-step verification is not switched on for that account.");
      }

      await mutateWithHistory<{ id: string }>(
        context,
        {
          action: "PERMISSION_CHANGE",
          entityType: "User",
          entityLabel: `${target.name} <${target.email}>`,
          revise: false,
          before: { twoFactorEnabled: true, recoveryCodesLeft: target.twoFactorRecoveryCodes.length }
        },
        async (tx) =>
          tx.user.update({
            where: { id: target.id },
            data: {
              twoFactorEnabled: false,
              twoFactorSecret: null,
              /**
               * CLEARED WITH THE SECRET. A recovery code is a password that bypasses the second factor;
               * codes left behind would still open the account, so a "switched off" second factor would go
               * on holding ten live credentials nobody remembers exist.
               */
              twoFactorRecoveryCodes: []
            },
            select: { id: true }
          })
      );

      return ok({
        twoFactorEnabled: false,
        message:
          `${target.name}'s account needs only a password again, until they set two-step verification up on ` +
          "a new device from their own account screen. Any recovery codes they still hold have stopped working. " +
          "This is in the audit log with your name on it."
      });
    }

    // ── Remove a linked sign-in method ──────────────────────────────────────────────────────────
    if (action === "unlink-provider") {
      if (provider === undefined) {
        throw badRequest(
          "The request did not say which sign-in method to remove. Choose one from the list on the account."
        );
      }
      const label = METHOD_LABELS[provider];

      /**
       * ALLOWED ON YOUR OWN ACCOUNT, for the same reason as ending your own sessions: removing a way into
       * your own account is not a privilege escalation. The rule that actually protects anybody here is the
       * last-method one below, and it applies to yourself exactly as it does to a colleague.
       */
      if (target.id !== actor.id && !canManageUser(actor, { id: target.id, role: target.role })) {
        throw forbidden(
          "You cannot change how this person signs in, because they are at the same level of access as you or above it."
        );
      }

      const linked = target.oauthAccounts.find((account) => account.provider === provider);
      if (!linked) {
        throw conflict(
          `${target.name}'s account is not linked to ${label}, so there is nothing to remove. The list on the account shows the methods it does have.`
        );
      }

      /**
       * ⚠ THE RULE THAT REFUSES, AND IT IS NAMED IN THE MESSAGE.
       *
       * An account with no password is entered ONLY through its linked providers. Taking the last one away
       * leaves a row that exists, is active and holds a role, and that nobody — not its owner, not a master
       * admin — can ever sign in to again. The way out is offered in the same sentence, because "no" with no
       * next step is what makes somebody try the same button twice.
       */
      const accountHasPassword = typeof passwordHash === "string" && passwordHash.length > 0;
      if (!accountHasPassword && target.oauthAccounts.length === 1) {
        throw conflict(
          `${label} is the only way into ${target.name}'s account, because it has no password set. Removing it would leave an account that exists, is active and holds a level of access, and that nobody — at any level — could ever sign in to again. Issue them a password link first, under “Help them back in”, and the ${label} link can be removed once they have used it.`
        );
      }

      await mutateWithHistory<{ id: string }>(
        context,
        {
          action: "PERMISSION_CHANGE",
          entityType: "User",
          entityLabel: `${target.name} <${target.email}>`,
          revise: false,
          before: {
            unlinkedProvider: provider,
            unlinkedProviderEmail: linked.email,
            linkedSince: linked.createdAt,
            lastUsedAt: linked.lastUsedAt,
            signInMethodsBefore: target.oauthAccounts.length + (accountHasPassword ? 1 : 0)
          },
          summary: `A ${label} sign-in was unlinked`
        },
        async (tx) => {
          /**
           * `deleteMany` with the user id in its `where`, not `delete` by id: a link belonging to ANOTHER
           * account could not then be removed by passing its provider here, whatever the row said.
           */
          await tx.oAuthAccount.deleteMany({ where: { userId: target.id, provider } });
          /**
           * The account row is touched in the same transaction as the log entry, exactly as the sign-out
           * action does and for the same reason: the deleted link is not the audited entity, and an entry
           * with no change beside it is the one thing lib/audit.ts exists to prevent. An empty `data` still
           * writes `updatedAt`, which is the honest record that the account changed.
           */
          return tx.user.update({ where: { id: target.id }, data: {}, select: { id: true } });
        }
      );

      const remaining = target.oauthAccounts.length - 1;
      const ways = [
        ...(accountHasPassword ? [METHOD_LABELS.PASSWORD] : []),
        ...target.oauthAccounts
          .filter((account) => account.provider !== provider)
          .map((account) => METHOD_LABELS[account.provider])
      ];

      // `join` rather than an index: under `noUncheckedIndexedAccess` reading `ways[0]` is `string |
      // undefined`, and the one thing this sentence must not print is the word "undefined".
      const waysSentence =
        ways.length === 1
          ? `They now sign in with ${ways.join("")} only.`
          : `They can still sign in with ${ways.join(" or ")}.`;

      return ok({
        unlinked: provider,
        remainingProviders: remaining,
        message:
          `${label} can no longer be used to sign in to ${target.name}'s account. ${waysSentence} ` +
          "Anybody already signed in on that account stays signed in — use “Sign out of every device” if that " +
          "is what you meant to do. This is in the audit log with your name on it."
      });
    }

    // ── A way to set a new password ─────────────────────────────────────────────────────────────
    if (target.id !== actor.id && !canManageUser(actor, { id: target.id, role: target.role })) {
      throw forbidden(
        "You cannot issue a password link for this person, because they are at the same level of access as you or above it."
      );
    }

    const { token, link, expiresAt } = issueResetLink(target.id, passwordHash);

    const sessionsEnded = await countActiveSessions(target.id);

    await mutateWithHistory<{ id: string }>(
      context,
      {
        action: "PERMISSION_CHANGE",
        entityType: "User",
        entityLabel: `${target.name} <${target.email}>`,
        revise: false,
        // METADATA ONLY. The token is a credential: an audit log is read by more people than the users table
        // is, and it gets exported. `redact()` would not catch this one, because it is not a known name.
        before: { activeSessions: sessionsEnded },
        summary: "A password link was issued"
      },
      async (tx) =>
        tx.user.update({
          where: { id: target.id },
          // The sign-in throttle is cleared: a reset is issued because somebody cannot get in, and eight
          // failed attempts followed by a fifteen-minute lock is the usual reason they asked.
          data: { failedLogins: 0, lockedUntil: null },
          select: { id: true }
        })
    );

    /**
     * ⚠ EVERY SESSION IS REVOKED, and the response says so.
     *
     * A password reset is the answer to "somebody else may be able to get into my account". Leaving their
     * existing sessions alive would leave whoever that was signed in — the reset would change the lock and
     * leave the intruder inside. The client must print this: an administrator who does not know the person
     * has been signed out cannot warn them.
     */
    await revokeAllSessionsForUser(target.id);

    return ok({
      emailed: false,
      link,
      token,
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DELETE — a soft delete, and the studio prefers switching off
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const DELETE = route(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    assertSameOrigin(request);

    const actor = await requireCapability(canManageUsers, "Deleting an account needs administrator access.");

    const { id } = await params;
    const target = found(await prisma.user.findUnique({ where: { id }, select: safeSelect }), "That account");
    if (target.deletedAt) throw conflict("That account has already been deleted.");

    if (!canManageUser(actor, { id: target.id, role: target.role })) {
      throw forbidden(
        target.id === actor.id
          ? "You cannot delete your own account. An administrator who did that while being the only one would lock everybody out of the studio, with no way back in through the site itself."
          : "You cannot delete this account, because this person is at the same level of access as you or above it."
      );
    }
    // The early answer. `target.deletedAt` was refused above, so an active administrator here is always one
    // of the counted ones. The count that guards the invariant is taken inside the transaction below.
    const deletingAnAdministrator = target.role === "ADMINISTRATOR" && target.isActive;

    if (deletingAnAdministrator && (await countActiveAdministrators()) <= 1) {
      throw conflict(
        "This is the only active administrator on this installation. Make somebody else an administrator first."
      );
    }

    // ⚠ AND SEPARATELY for the tier above. A deleted master admin is as gone as a demoted one, and the loss
    // is quieter: nothing breaks except the ability to add anybody else, ever.
    const deletingAMasterAdmin = target.role === "MASTER_ADMIN" && target.isActive;

    if (deletingAMasterAdmin && (await countActiveMasterAdmins()) <= 1) {
      throw conflict(
        "This is the only master administrator on this installation. Deleting the account would leave nobody able to add a colleague to the studio access list. Make somebody else a master administrator first."
      );
    }

    /**
     * A SOFT DELETE, and the account is switched off with it.
     *
     * ⚠ ACCOUNTS ARE NOT IN THE RECYCLE BIN. That screen says so and explains why: switching an account off
     * keeps everything the person wrote attributed to them and keeps the audit trail readable, which a
     * deletion does not. So the studio offers deactivation and this endpoint exists for the rarer case
     * where a row must genuinely go — and the only way back is `PATCH … { "restore": true }`, which is
     * named in the response because nothing on screen will offer it.
     */
    const deletedAt = new Date();
    await mutateWithHistory<{ id: string }>(
      buildAuditContext(request, actor),
      {
        action: "DELETE",
        entityType: "User",
        entityLabel: `${target.name} <${target.email}>`,
        revise: false,
        before: toAuditSnapshot(target)
      },
      async (tx) => {
        // ⚠ THE REAL GUARD, for the same reason as in PATCH: a deletion and a demotion running together
        // would otherwise each see two administrators and leave none.
        if (deletingAnAdministrator && (await lockActiveAdministrators(tx)) <= 1) {
          throw conflict(LAST_ADMINISTRATOR_RACE);
        }
        if (deletingAMasterAdmin && (await lockActiveMasterAdmins(tx)) <= 1) {
          throw conflict(LAST_MASTER_ADMIN_RACE);
        }

        return tx.user.update({
          where: { id: target.id },
          data: { deletedAt, isActive: false },
          select: { id: true }
        });
      }
    );

    // A deleted account with live sessions is a deleted account that can still read the studio.
    await revokeAllSessionsForUser(target.id);

    return ok({
      deleted: true,
      deletedAt,
      message:
        `${target.name}'s account has been deleted and signed out everywhere. Everything they wrote keeps ` +
        "their name on it. Accounts are not shown in the recycle bin, so bringing this one back means asking " +
        "for it by id — switching an account off is almost always the better answer. " +
        REVOCATION_NOTE
    });
  }
);
