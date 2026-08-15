import "server-only";
import { cookies } from "next/headers";
// `forbidden` is enabled by `experimental.authInterrupts` in next.config.ts — see the long note on
// `requireStudioCapability` below for why a page cannot simply throw the way a route handler does.
import { forbidden as renderForbidden, redirect } from "next/navigation";
import { cache } from "react";
import type { Role, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { forbidden, unauthorized } from "@/lib/api";
import { ACCESS_COOKIE } from "./cookies";
import { verifyAccessToken } from "./tokens";
import { hasRank, type PermissionSubject } from "@/lib/permissions";

/**
 * "Who is making this request?" — for server components and route handlers.
 *
 * TWO LEVELS, and the difference matters:
 *
 *   • `currentClaims()` reads the signed token only. No database. Good enough to decide what to
 *     RENDER, and cheap enough to call in a layout on every navigation.
 *   • `currentUser()` re-reads the row. Authoritative. Anything that WRITES must use it, because an
 *     access token minted before a demotion stays valid until it expires, and a demotion has to take
 *     effect on the next write rather than up to thirty minutes later.
 *
 * `cache()` from React dedupes within one request, so a layout, a page and three server components
 * asking the same question cost one query rather than five.
 */

export interface SessionUser extends PermissionSubject {
  id: string;
  email: string;
  name: string;
  role: Role;
  avatarId: string | null;
  canPublish: boolean;
  canManageMedia: boolean;
  twoFactorEnabled: boolean;
}

function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarId: user.avatarId,
    canPublish: user.canPublish,
    canManageMedia: user.canManageMedia,
    twoFactorEnabled: user.twoFactorEnabled
  };
}

/** The verified token claims, or null. Never touches the database. */
export const currentClaims = cache(async () => {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  return verifyAccessToken(token);
});

/**
 * The authoritative user, or null.
 *
 * Returns null — not a stale user — when the row has since been deactivated or soft-deleted. A
 * token outliving the account it names is exactly the window this check closes.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const claims = await currentClaims();
  if (!claims) return null;

  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  if (!user || !user.isActive || user.deletedAt) return null;

  return toSessionUser(user);
});

/** The user, or a 401. Use in every route handler that reads CMS data. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw unauthorized("Your session has ended. Please sign in again.");
  return user;
}

/**
 * The user with at least `role`, or a 403.
 *
 * The message names the tier required rather than saying "forbidden": an editor who has been asked
 * to fix the footer and cannot needs to know whom to ask, not merely that the door is shut.
 */
export async function requireRole(role: Role): Promise<SessionUser> {
  const user = await requireUser();
  if (!hasRank(user, role)) {
    throw forbidden(
      `This needs ${role.toLowerCase().replace(/_/g, " ")} access or higher. An administrator can raise yours.`
    );
  }
  return user;
}

/**
 * The user, if a capability predicate passes.
 *
 * Takes the PREDICATE rather than a role so the server check and the UI check are literally the same
 * function — the single most repeated failure in a permissioned CMS is a screen that hides a button
 * using one rule while the endpoint behind it enforces another.
 */
export async function requireCapability(
  predicate: (subject: PermissionSubject | null | undefined) => boolean,
  message = "You do not have access to this."
): Promise<SessionUser> {
  const user = await requireUser();
  if (!predicate(user)) throw forbidden(message);
  return user;
}

/**
 * The same check, FOR A PAGE rather than for a route handler.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THERE ARE TWO OF THESE, AND WHICH ONE YOU WANT.
 *
 * `requireCapability` above throws an `ApiError`. That is exactly right inside a route handler, where
 * the `route()` wrapper catches it and turns it into `{ error: true, message, code }` with a 403 — the
 * shape `lib/client/fetcher.ts` knows how to read.
 *
 * It is exactly WRONG inside a Server Component. There is no wrapper there: the throw becomes an
 * unhandled server error, Next renders the nearest `error.tsx`, and the reader is told "something went
 * wrong on our side". That is false, and it is worse than unhelpful — an editor who was asked to fix
 * the footer and is shown a 500 reports a broken CMS, and somebody spends an afternoon looking for a
 * fault that does not exist. Telling somebody they lack access they do hold is the worse error; so is
 * telling them the system is broken when the refusal was deliberate.
 *
 * `error.tsx` cannot repair this from the outside. Next REDACTS a server error's message in production
 * — replacing it with a generic string plus a digest, so a stack trace cannot reach a browser — which
 * leaves the boundary no way to distinguish a permission refusal from a genuine fault.
 *
 * So a page uses THIS function, which calls Next's own `forbidden()`. That renders
 * `app/forbidden.tsx` in place with a real 403 status, and is distinguishable from a fault by
 * construction rather than by parsing a message.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ `forbidden()` never returns — its return type is `never` — so nothing after it runs and no `else`
 * is needed. It must NOT be wrapped in a try/catch: it signals by throwing a control-flow marker Next
 * recognises, and a `catch` that swallows it renders the page to somebody who was just refused.
 *
 * ⚠ `forbidden()` TAKES NO ARGUMENT, so `message` cannot travel with it. It is logged server-side
 * instead, where an operator debugging "why can this person not open Settings" will find the exact
 * sentence the guard intended. `app/forbidden.tsx` says what it can say without it — which tier the
 * reader holds and who can change it — and that is the half a reader can actually act on.
 */
export async function requireStudioCapability(
  predicate: (subject: PermissionSubject | null | undefined) => boolean,
  message = "You do not have access to this part of the studio."
): Promise<SessionUser> {
  const user = await currentUser();

  // Not signed in at all is a different answer from signed in without access, and middleware has
  // already redirected that case to the login screen. Reaching here means the cookie went stale
  // between the middleware check and this render, so send them to sign in rather than telling them
  // they lack a permission they may well hold.
  if (!user) redirect("/studio/login");

  if (!predicate(user)) {
    console.warn(`[studio] refused ${user.email} (${user.role}): ${message}`);
    renderForbidden();
  }

  return user;
}

/**
 * The page-level twin of `requireUser`: any signed-in user, or a redirect to the login screen.
 *
 * For the two studio screens that need no capability beyond being signed in — the dashboard and one's
 * own account. `requireUser()` would be wrong in both for the same reason it is wrong everywhere else in
 * a Server Component: it throws an `ApiError`, which becomes an unhandled server error and a **500**
 * telling the reader the site is broken.
 *
 * The case that actually reaches here is worth naming, because it is not hypothetical. An administrator
 * deactivates an editor; the editor's access token stays valid for up to its full lifetime by design, so
 * middleware lets the request through, `currentUser()` then returns null because the row is inactive —
 * and the editor gets a 500 on the dashboard while every other screen correctly sends them to sign in.
 * A redirect is the honest answer: their session really has ended.
 *
 * ⚠ SERVER ACTIONS ARE A DIFFERENT CASE and deliberately keep using `requireUser()`. An action's throw
 * is caught by React and surfaced through the calling component's error state, so an `ApiError` there
 * carries its message to the client instead of becoming a page-level 500. Redirecting out of an action
 * would discard whatever the reader had typed.
 */
export async function requireStudioUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/studio/login");
  return user;
}

/** The page-level twin of `requireRole`. See `requireStudioCapability` for why it exists. */
export async function requireStudioRole(role: Role): Promise<SessionUser> {
  return requireStudioCapability(
    (subject) => hasRank(subject as SessionUser | null, role),
    `This needs ${role.toLowerCase().replace(/_/g, " ")} access or higher. An administrator can raise yours.`
  );
}
