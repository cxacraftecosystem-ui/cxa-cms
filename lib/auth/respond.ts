import "server-only";
import type { NextResponse } from "next/server";
import type { Role } from "@prisma/client";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  SESSION_HINT_COOKIE,
  accessCookieOptions,
  clearCookieOptions,
  clearHintCookieOptions,
  refreshCookieOptions,
  sessionHintCookieOptions
} from "./cookies";
import { authEnv } from "./config";
import { signAccessToken } from "./tokens";
import type { IssuedSession } from "./session";

/**
 * The ONE place a session is written to, or removed from, a response.
 *
 * Three routes hand out cookies — login, refresh and logout — and they must agree exactly. A
 * `Path`, `Domain`, `Secure` or `SameSite` mismatch between the setter and the clearer does not
 * produce an error: it produces a SECOND cookie, and the browser goes on sending the first one
 * forever. "Sign out" then signs nobody out and there is nothing in any log to say why. Routing
 * every write through this module means the mismatch cannot be introduced in one place only.
 *
 * `lib/auth/cookies.ts` owns the attributes; this module owns the ORDER and the CONTENT — which
 * token goes in which cookie, and what the non-httpOnly hint is allowed to say.
 */

/** The claims the access token needs. Both `SessionUser` and a Prisma `User` row satisfy it. */
export interface TokenSubject {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * When the access token being minted right now will expire.
 *
 * Exported so a route can echo the moment in its JSON body without re-deriving the TTL. Two places
 * computing "now + ACCESS_TOKEN_TTL_MINUTES" is two places to forget when the setting changes, and
 * a hint that disagrees with the token schedules the silent refresh at the wrong minute.
 */
export function accessTokenExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + authEnv().accessTtlMinutes * 60_000);
}

/**
 * Sign an access token for `user` and attach the whole session to `response`.
 *
 * The hint cookie carries the access-token EXPIRY AND NOTHING ELSE. It is readable by any script on
 * the origin, so a token in it would be a token handed to every third-party snippet on the page, and
 * a role in it would be an authorisation input the client could edit. An expiry timestamp is already
 * implied by "you are signed in", which is why it is the only thing safe to put there.
 *
 * Generic in the body type so a typed `ok({ user })` response keeps its type through the call.
 */
export async function applySession<T>(
  response: NextResponse<T>,
  user: TokenSubject,
  session: IssuedSession
): Promise<NextResponse<T>> {
  const token = await signAccessToken({
    userId: user.id,
    role: user.role,
    email: user.email,
    name: user.name,
    sessionId: session.sessionId
  });

  response.cookies.set(ACCESS_COOKIE, token, accessCookieOptions());
  response.cookies.set(REFRESH_COOKIE, session.refreshToken, refreshCookieOptions());
  response.cookies.set(
    SESSION_HINT_COOKIE,
    accessTokenExpiresAt().toISOString(),
    sessionHintCookieOptions()
  );

  return response;
}

/**
 * Remove all three cookies.
 *
 * Called on logout AND on every failed refresh. The failure case is what stops middleware looping:
 * middleware redirects to the refresh route because a refresh cookie exists, so if the refresh
 * cannot clear that cookie the next request redirects again, and again. Clearing is therefore not
 * tidying up — it is the loop breaker.
 */
export function clearSession<T>(response: NextResponse<T>): NextResponse<T> {
  const gone = clearCookieOptions();
  response.cookies.set(ACCESS_COOKIE, "", gone);
  response.cookies.set(REFRESH_COOKIE, "", gone);
  response.cookies.set(SESSION_HINT_COOKIE, "", clearHintCookieOptions());
  return response;
}
