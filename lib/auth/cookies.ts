import { authEnv } from "./config";

/**
 * Cookie names and options — one place, so the login route, the refresh route, the logout route and
 * middleware cannot disagree about scope. A `Path` or `Domain` mismatch between the setter and the
 * clearer leaves a stale cookie the browser keeps sending and nothing can delete.
 */

export const ACCESS_COOKIE = "cxa_access";
export const REFRESH_COOKIE = "cxa_refresh";
/**
 * A NON-httpOnly hint, holding only an expiry timestamp — never a token, never a role.
 *
 * It exists so the client can schedule a silent refresh slightly before the access token dies,
 * instead of discovering the expiry as a failed save. Anything in it is readable by any script on
 * the origin, so it carries nothing that is not already implied by "you are logged in".
 */
export const SESSION_HINT_COOKIE = "cxa_session_hint";

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
}

/**
 * `SameSite=Lax` is the CSRF control for the whole CMS: the browser withholds these cookies from
 * cross-site POST/PUT/DELETE, so a form on another origin cannot act as the signed-in editor. It is
 * NOT `Strict`, because Strict also withholds them from an ordinary top-level link — an
 * administrator following "review this draft" from an email would land on the login screen despite
 * holding a valid session.
 *
 * `secure` follows the deployment rather than being hardcoded: a `Secure` cookie is silently dropped
 * over plain http, which would make local development look like a broken login with no error.
 */
function baseOptions(): Omit<CookieOptions, "maxAge" | "expires"> {
  const { cookieDomain } = authEnv();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...(cookieDomain ? { domain: cookieDomain } : {})
  };
}

export function accessCookieOptions(): CookieOptions {
  const { accessTtlMinutes } = authEnv();
  return { ...baseOptions(), maxAge: accessTtlMinutes * 60 };
}

export function refreshCookieOptions(): CookieOptions {
  const { refreshTtlDays } = authEnv();
  return { ...baseOptions(), maxAge: refreshTtlDays * 24 * 60 * 60 };
}

export function sessionHintCookieOptions(): CookieOptions {
  const { refreshTtlDays } = authEnv();
  return { ...baseOptions(), httpOnly: false, maxAge: refreshTtlDays * 24 * 60 * 60 };
}

/**
 * Options for REMOVING a cookie.
 *
 * `maxAge: 0` plus the identical path/domain/secure/sameSite as the setter. A clear that differs in
 * any of those attributes creates a second cookie instead of deleting the first, and the browser
 * keeps sending the original — a "log out" that does not log anybody out.
 */
export function clearCookieOptions(): CookieOptions {
  return { ...baseOptions(), maxAge: 0, expires: new Date(0) };
}

export function clearHintCookieOptions(): CookieOptions {
  return { ...baseOptions(), httpOnly: false, maxAge: 0, expires: new Date(0) };
}
