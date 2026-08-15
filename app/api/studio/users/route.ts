import { createHash, createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma, Role } from "@prisma/client";
import { assertSameOrigin, badRequest, conflict, forbidden, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { mutateWithHistory } from "@/lib/audit";
import { prisma } from "@/lib/db";
// `authEnv` is re-exported by lib/env.ts so everything that is not middleware has ONE import site for the
// token settings — its own header says so.
import { authEnv, siteUrl } from "@/lib/env";
import { ROLES_DESCENDING, canAssignRole, canManageUsers } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson, parseStudioQuery } from "@/lib/studio/crud";

/**
 * The people who can sign in to this studio: who they are, and inviting a new one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE MOST SECURITY-SENSITIVE ROUTES IN THE STUDIO. Five rules, and none of them is optional.
 *
 * 1. `canManageUsers` GUARDS THE COLLECTION, and `canAssignRole(actor, target, nextRole)` guards the role
 *    an invitation hands out. Both come from `lib/permissions.ts` and are NOT re-derived here — a second
 *    rank test that disagrees with the first is how a "nobody promotes above themselves" rule silently
 *    stops matching (contract §1.7). The users screen calls the same two functions to decide what to
 *    offer; this is the boundary that decides what happens.
 *
 * 2. NO SECRET COLUMN IS EVER SELECTED INTO A RESPONSE. `passwordHash`, `twoFactorSecret` and
 *    `twoFactorRecoveryCodes` are named nowhere in an answer. Every read uses an EXPLICIT `select`,
 *    because `select: undefined` hands back the whole row — which is how a bcrypt hash leaks out of a CMS
 *    into a browser's network tab, a proxy log and somebody's screenshot. `recoveryCodesLeft` is a COUNT,
 *    computed from the array and then discarded.
 *
 * 3. AN INVITATION CREATES THE ACCOUNT WITH NO PASSWORD. Nothing in this studio ever generates a password
 *    for somebody else, emails one, or returns one: a password that has existed in a mailbox is a password
 *    that is no longer a secret, and one that an administrator has seen makes "only you know your
 *    password" untrue for every account they created. What is issued instead is a single-use,
 *    time-limited token that lets the person set their own.
 *
 * 4. THE TOKEN IS SINGLE-USE WITHOUT A TABLE TO STORE IT IN, and the trick is worth understanding — see
 *    `mintCredentialToken` below. It is bound to the account's CURRENT credential state, so the moment a
 *    password is set the token stops verifying. There is no row to clean up and no window in which a used
 *    invitation still works.
 *
 * 5. THE ACCOUNT IS CREATED INACTIVE-UNTIL-CLAIMED IN EFFECT, NOT BY A FLAG. `verifyCredentials()` cannot
 *    authenticate a row with no `passwordHash` — `verifyPassword()` runs a dummy comparison and returns
 *    false (lib/auth/password.ts). So an invited account that is never claimed is not a way in.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Deep paging over a table this size is always a sign the search box is the better tool. */
const MAX_PAGE = 200;

/**
 * How long an invitation and a password link last.
 *
 * An invitation is generous: it may be passed on by hand, read on a Monday and acted on after a
 * conference. A password link is short, because it is issued in response to somebody saying "I am locked
 * out now" and a link that outlives that conversation is a spare key left under the mat.
 */
const INVITE_TTL_HOURS = 72;
const RESET_TTL_HOURS = 2;

/**
 * Where the person lands to set a password.
 *
 * ⚠ THIS SCREEN AND ITS VERIFYING ENDPOINT ARE NOT IN THIS FILE. What is defined here is the token, its
 * lifetime and its meaning; whatever consumes it MUST verify with the same construction below, and MUST
 * refuse a token whose `cred` no longer matches — that check is the entire single-use guarantee.
 */
const SET_PASSWORD_PATH = "/studio/set-password";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The credential token
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ NOTHING IN THIS SECTION IS EXPORTED, and that is a constraint rather than a preference: Next
 * type-checks a `route.ts` against a fixed set of allowed exports, so a helper cannot be shared from here.
 * The same construction is repeated in `app/api/studio/users/[id]/route.ts`, which mints the password link.
 * **The two copies must stay identical** — a token minted by one and refused by the other is a colleague
 * locked out with a link that looks perfectly valid. It belongs in `lib/auth/`; lift it there when that file
 * is next touched, and delete both copies in the same commit.
 */
interface CredentialTokenPayload {
  /** Bumped if the shape ever changes, so an old token is refused rather than misread. */
  v: 1;
  sub: string;
  purpose: "invite" | "reset";
  /** Seconds since the epoch. */
  exp: number;
  /**
   * A short digest of the account's CURRENT credential state — see `credentialFingerprint`. This is what
   * makes the token single-use with no table behind it.
   */
  cred: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * A short digest of "what the password is now".
 *
 * ⚠ THE HASH IS NEVER PUT IN THE TOKEN — only 16 hex characters of a SHA-256 of it, which is not enough to
 * attack and is enough to notice a change. A row with no password digests a fixed sentinel, so an
 * invitation is bound to "still has no password".
 *
 * The consequence, and it is the point: as soon as a password is set (by this link, by another link, or by
 * the person from their own account screen) every token minted before it stops verifying.
 */
function credentialFingerprint(passwordHash: string | null): string {
  return createHash("sha256").update(passwordHash ?? "no-password").digest("hex").slice(0, 16);
}

/**
 * Mint a token: `base64url(payload).base64url(HMAC-SHA256(payload))`.
 *
 * Signed with `JWT_SECRET` through `authEnv()`, which refuses to start on a weak or placeholder key — so
 * this cannot silently become a token anybody can forge. Deliberately NOT a JWT: `signAccessToken()` mints
 * an ACCESS token and anything shaped like one risks being accepted as one by a call site that only checks
 * the signature. A different construction cannot be confused for a session.
 */
function mintCredentialToken(payload: CredentialTokenPayload): string {
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(createHmac("sha256", authEnv().secret).update(body).digest());
  return `${body}.${signature}`;
}

function credentialLink(token: string): string {
  return `${siteUrl()}${SET_PASSWORD_PATH}?token=${encodeURIComponent(token)}`;
}

/** Mint an invitation or reset link for a user id, given the hash the account currently holds. */
function issueCredentialLink(input: {
  userId: string;
  passwordHash: string | null;
  purpose: "invite" | "reset";
}): { token: string; link: string; expiresAt: Date } {
  const hours = input.purpose === "invite" ? INVITE_TTL_HOURS : RESET_TTL_HOURS;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const token = mintCredentialToken({
    v: 1,
    sub: input.userId,
    purpose: input.purpose,
    exp: Math.floor(expiresAt.getTime() / 1000),
    cred: credentialFingerprint(input.passwordHash)
  });
  return { token, link: credentialLink(token), expiresAt };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The columns a studio answer may carry.
 *
 * ⚠ WRITTEN OUT, EVERY TIME. `twoFactorRecoveryCodes` is here because the screen shows how many are LEFT,
 * and it is turned into a number before the row is returned — see `toRow`. Nothing else secret appears.
 */
const listSelect = {
  id: true,
  name: true,
  email: true,
  title: true,
  role: true,
  isActive: true,
  canPublish: true,
  canManageMedia: true,
  twoFactorEnabled: true,
  twoFactorRecoveryCodes: true,
  lastLoginAt: true,
  failedLogins: true,
  lockedUntil: true,
  createdAt: true,
  deletedAt: true
} as const;

type ListRow = Prisma.UserGetPayload<{ select: typeof listSelect }>;

/**
 * One row, with every secret turned into a fact about it.
 *
 * The recovery codes are DESTRUCTURED AWAY rather than deleted from a copy: a `delete` on a spread object
 * is one refactor away from being dropped, and this way the compiler is what stops the array reaching the
 * response.
 */
function toRow(row: ListRow, activeSessions: number) {
  const { twoFactorRecoveryCodes, ...rest } = row;
  return {
    ...rest,
    recoveryCodesLeft: twoFactorRecoveryCodes.length,
    activeSessions
  };
}

function isRole(value: string): value is Role {
  return (ROLES_DESCENDING as readonly string[]).includes(value);
}

const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  role: z.string().trim().max(40).optional(),
  /**
   * `deleted` is offered deliberately. Accounts are NOT in the recycle bin — that screen says so, because
   * an account is switched off rather than deleted so its author credits and audit trail survive. A row
   * that has been soft-deleted through the API would otherwise be unreachable from anywhere.
   */
  status: z.enum(["active", "inactive", "deleted"]).optional(),
  page: z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, "The page must be a whole number.")
    .optional(),
  pageSize: z
    .string()
    .trim()
    .regex(/^\d{1,3}$/, "The page size must be a whole number.")
    .optional()
});

export const GET = route(async (request: NextRequest) => {
  await requireCapability(
    canManageUsers,
    "Managing people needs administrator access. Ask an administrator to make the change, or to raise your access."
  );

  const query = parseStudioQuery(request, ListQuery);

  const q = query.q ?? "";
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, query.pageSize ? Number.parseInt(query.pageSize, 10) : DEFAULT_PAGE_SIZE)
  );
  const page = Math.min(MAX_PAGE, Math.max(1, query.page ? Number.parseInt(query.page, 10) : 1));

  const role = query.role ?? "";
  if (role.length > 0 && !isRole(role)) {
    // Refused rather than ignored. A misspelled role that silently widened the filter would show an
    // administrator the whole staff list while they believed they were looking at the editors.
    throw badRequest(
      `There is no level of access called “${role}”. The levels on this site are: ${ROLES_DESCENDING.join(", ")}.`
    );
  }

  const where: Prisma.UserWhereInput = {
    ...(query.status === "deleted" ? { deletedAt: { not: null } } : { deletedAt: null }),
    ...(query.status === "active" ? { isActive: true } : {}),
    ...(query.status === "inactive" ? { isActive: false } : {}),
    ...(role.length > 0 ? { role: role as Role } : {}),
    ...(q.length > 0
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { title: { contains: q, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [rows, total, activeAdministrators] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      select: listSelect,
      // A TOTAL order. `name` alone is not total — two people share one often enough — and an unstable
      // sort renders a different page 2 on every request, which reads as accounts moving on their own.
      orderBy: [{ name: "asc" }, { email: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    prisma.user.count({ where }),
    prisma.user.count({ where: { deletedAt: null, isActive: true, role: "ADMINISTRATOR" } })
  ]);

  /**
   * How many devices each account has signed in.
   *
   * One grouped query for the page rather than a count per row: twenty-five accounts would otherwise be
   * twenty-five round trips for a number in a table cell.
   */
  const sessionCounts = new Map<string, number>();
  if (rows.length > 0) {
    const grouped = await prisma.session.groupBy({
      by: ["userId"],
      where: {
        userId: { in: rows.map((row) => row.id) },
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      _count: { _all: true }
    });
    for (const entry of grouped) sessionCounts.set(entry.userId, entry._count._all);
  }

  return ok({
    items: rows.map((row) => toRow(row, sessionCounts.get(row.id) ?? 0)),
    total,
    page,
    pageSize,
    /** A list that quietly stops is indistinguishable from a short one (contract §1.6). */
    truncated: page * pageSize < total,
    /**
     * The guard against the last administrator locking everybody out is a COUNT, not a permission —
     * `canAssignRole` deliberately permits self-demotion. The client needs the same number to explain why
     * the control is absent, and `PATCH /api/studio/users/{id}` enforces it.
     */
    activeAdministrators
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Inviting
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const InviteBody = z.object({
  name: z
    .string()
    .trim()
    .min(1, "A name is needed — it is what colleagues see beside everything this person changes.")
    .max(200, "Keep the name to 200 characters or fewer."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "An email address is needed — it is what they sign in with.")
    .max(254)
    .email("That does not look like an email address. Check for a missing @ or a typo in the domain."),
  title: z.string().trim().max(200).optional(),
  role: z.string().trim().min(1, "Choose what this person may do.").max(40)
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const actor = await requireCapability(
    canManageUsers,
    "Inviting somebody needs administrator access."
  );

  const body = await parseStudioJson(request, InviteBody);

  if (!isRole(body.role)) {
    throw badRequest(
      `There is no level of access called “${body.role}”. The levels on this site are: ${ROLES_DESCENDING.join(", ")}.`
    );
  }
  const nextRole: Role = body.role;

  /**
   * THE LADDER, from the predicate itself.
   *
   * The target is a NOTIONAL new account at the lowest tier, which is what an invitation creates — so this
   * asks exactly "may you hand out this level?" and refuses anything at or above the inviter's own. Writing
   * the comparison here instead would be the second rank test lib/permissions.ts exists to prevent.
   */
  if (!canAssignRole(actor, { id: "new", role: "VIEWER" }, nextRole)) {
    throw forbidden(
      "You cannot give somebody a level of access at or above your own. Ask an administrator with more access to do it."
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email: body.email },
    select: { id: true, deletedAt: true, isActive: true }
  });
  if (existing) {
    throw conflict(
      existing.deletedAt
        ? "There is already an account with that address, and it has been deleted. An administrator can bring it back rather than making a second one — two accounts on one address is a coin toss over which one signs in."
        : "There is already an account with that address. Change what that account can do rather than making a second one."
    );
  }

  const context = buildAuditContext(request, actor);

  const created = await mutateWithHistory<{ id: string; email: string; name: string; role: Role }>(
    context,
    {
      action: "CREATE",
      entityType: "User",
      entityLabel: `${body.name} <${body.email}>`,
      /**
       * NO REVISION. A user row is not versioned content, and a revision of one would only be a second
       * copy of the audit entry with its secrets redacted. `redact()` strips the secret columns by name
       * either way, which is the backstop rather than the control — the `select` below is the control.
       */
      revise: false
    },
    async (tx) =>
      tx.user.create({
        data: {
          name: body.name,
          email: body.email,
          title: body.title && body.title.length > 0 ? body.title : null,
          role: nextRole,
          /**
           * NO PASSWORD. Not a generated one, not a blank string — absent. `verifyPassword()` cannot
           * authenticate against `null` (it pays the hashing cost against a dummy and refuses), so this
           * account cannot be signed into until its owner sets one through the link below.
           */
          passwordHash: null,
          isActive: true
        },
        // Explicit, so nothing secret is in the value this function returns OR in the audit payload.
        select: { id: true, email: true, name: true, role: true }
      })
  );

  const { token, link, expiresAt } = issueCredentialLink({
    userId: created.id,
    passwordHash: null,
    purpose: "invite"
  });

  /**
   * NO MAIL TRANSPORT IS CONFIGURED ON THIS INSTALLATION — there is nothing for one in `lib/env.ts`, and
   * `app/studio/users/page.tsx` hands the screen `canSendEmail = false` to match. So the link comes back
   * for an administrator to pass on by a means they trust, and the screen says exactly that.
   *
   * ⚠ When a transport is added, this route sends the link and stops returning it. The response keeps its
   * shape either way: `emailed` says which happened, so the client's copy is already correct for both.
   */
  return ok({
    id: created.id,
    email: created.email,
    name: created.name,
    role: created.role,
    emailed: false,
    link,
    token,
    expiresAt,
    message:
      `${created.name} has an account but no password yet. The link is good for ${INVITE_TTL_HOURS} hours and ` +
      "works once — it stops working the moment a password is set. Nobody here has seen or chosen their password."
  });
});
