import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptions } from "./cookies";
import { ACCESS_REFUSED_MESSAGE } from "./access";
import { isOAuthProvider, type OAuthProviderName } from "./oauth";

/**
 * Everything the TWO HALVES of a provider sign-in must agree about, in one module.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `/start` and `/callback` are separate route files, and a `route.ts` may not export a helper —
 * Next type-checks it against a fixed set of allowed exports (see the same note in
 * app/api/studio/users/route.ts). So anything the two halves must compute IDENTICALLY has to live
 * outside both of them, or it gets written twice and drifts. Four things qualify:
 *
 *  1. **THE HANDSHAKE COOKIE** — its name, its attributes and its payload. A `Path`, `SameSite` or
 *     `Secure` mismatch between the route that sets it and the route that clears it does not error:
 *     it creates a SECOND cookie and leaves the first in place, so a spent handshake stays replayable.
 *  2. **THE ORIGIN** — `redirect_uri` is sent twice (in the authorize URL and again in the token
 *     exchange) and the provider compares them byte for byte, against each other and against what was
 *     registered. Two functions computing it two ways is a sign-in that fails only in production.
 *  3. **THE `next` PATH** — validated when it is written into the cookie and again when it is read
 *     back out. An open redirect on a sign-in flow is a phishing primitive.
 *  4. **THE REFUSAL REDIRECT** — both halves send a refused reader to the same page with the same
 *     query flag, and the sign-in page renders the sentence for it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const STUDIO_LOGIN_PATH = "/studio/login";
export const DEFAULT_NEXT = "/studio";

// ─────────────────────────────────────────────────────────────────────────────
// Where a sign-in is allowed to land
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Space and the C0/C7F control characters.
 *
 * A code-point scan rather than a regular expression because the characters being looked for are
 * invisible in source: a literal control character inside a character class cannot be reviewed.
 */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate `?next=`. Only a same-origin PATH survives.
 *
 * These checks are character-for-character the ones in `app/api/auth/refresh/route.ts` and
 * `app/studio/login/page.tsx`. The three must agree, because any of them may be the one that consumes
 * the parameter, and each rejection is an attack or a dead end rather than a preference:
 *
 *  • `//evil.example` is a protocol-relative URL, not a path — it resolves to another host entirely.
 *  • `/\evil.example` is the same attack in disguise: the WHATWG parser treats a backslash as a slash
 *    for http(s) URLs, and it survives a naive "starts with one slash" test, which is exactly why that
 *    test is not enough on its own.
 *  • Control characters and spaces are refused because the parser STRIPS them, so a value that passed
 *    every check above can still turn into something else by the time it is resolved.
 *  • `/api/...` is refused because no useful journey ends at an API route, and a sign-in that finishes
 *    by downloading JSON reads as a broken sign-in.
 */
export function safeStudioPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT;
  if (raw.length > 512) return DEFAULT_NEXT;
  if (!raw.startsWith("/")) return DEFAULT_NEXT;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_NEXT;
  if (hasUnsafeCharacter(raw)) return DEFAULT_NEXT;
  if (raw === "/api" || raw.startsWith("/api/")) return DEFAULT_NEXT;
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// The origin this deployment is actually reached at
// ─────────────────────────────────────────────────────────────────────────────

/** A header a chain of proxies may have appended to. The ORIGINAL value is the leftmost one. */
function firstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/** Hostname, optionally with a port or in IPv6 brackets. Anything else is not a host. */
const HOST_SHAPE = /^[A-Za-z0-9._~\-[\]:%]{1,255}$/;

/**
 * The origin to build `redirect_uri` and same-site redirects from.
 *
 * ⚠ IT MUST BE DERIVED FROM THE REQUEST, not from `NEXT_PUBLIC_SITE_URL`. Behind a reverse proxy — which
 * is how this ships in Docker — the container sees `http://localhost:3000` while the browser and the
 * provider both see the public HTTPS origin. A `redirect_uri` built from the internal address matches
 * neither the registration nor the address the code was actually returned to, and the token exchange is
 * refused with an error that names neither cause.
 *
 * The forwarded headers are only as trustworthy as the proxy that sets them — the same assumption
 * `assertSameOrigin()` in lib/api.ts already makes. A caller who forges them can only change the
 * `redirect_uri` of THEIR OWN sign-in, which the provider then refuses because it is not registered; a
 * browser never sends these headers on somebody else's behalf. Both routes still answer `no-store`, so a
 * forged header cannot be cached and served to anybody else.
 *
 * A malformed host or scheme falls back to the request's own URL rather than being patched up: a
 * half-parsed host concatenated into a URL is how a header becomes a redirect target.
 */
export function requestOrigin(request: NextRequest): string {
  const url = new URL(request.url);

  const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"))?.toLowerCase();
  const protocol =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : url.protocol.replace(/:$/, "");

  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"));
  const host = forwardedHost && HOST_SHAPE.test(forwardedHost) ? forwardedHost : url.host;

  if (!HOST_SHAPE.test(host)) return url.origin;
  return `${protocol}://${host}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The handshake cookie
// ─────────────────────────────────────────────────────────────────────────────

/** Distinct from the session cookies, so nothing can confuse a ten-minute value for a session. */
export const OAUTH_HANDSHAKE_COOKIE = "cxa_oauth";

/**
 * Ten minutes.
 *
 * Long enough to read a consent screen, find a password manager and answer a second factor at the
 * provider; short enough that a handshake abandoned on a shared machine is not still open when the next
 * person sits down. A cookie that outlived its handshake would be a `state` value with no expiry.
 */
const HANDSHAKE_TTL_SECONDS = 600;

/**
 * Scoped to the two routes that use it, so it is not attached to every request to the site.
 *
 * `/api/auth/oauth/google/start` and `/api/auth/oauth/google/callback` both sit beneath this prefix, and
 * cookie path matching accepts a prefix followed by `/`. Nothing else needs the value, and a cookie sent
 * where it is not needed is a secret in one more log.
 */
// route-check: not-a-route — this is a COOKIE PATH, not a request target.
const HANDSHAKE_COOKIE_PATH = "/api/auth/oauth";

/** A JSON payload of four short base64url strings and a path. Anything larger has been tampered with. */
const MAX_COOKIE_LENGTH = 4096;
const MIN_SECRET_LENGTH = 16;
const MAX_SECRET_LENGTH = 512;

export interface OAuthHandshakeState {
  /** Which provider this handshake belongs to. A callback for a different one is refused. */
  provider: OAuthProviderName;
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Already validated by `safeStudioPath` — on the way in AND on the way back out. */
  next: string;
}

/**
 * ⚠ `SameSite` MUST BE `lax`, AND NOT `strict`.
 *
 * The callback is a TOP-LEVEL NAVIGATION FROM THE PROVIDER — a cross-site GET. `Strict` withholds a
 * cookie from exactly that, so the callback would find no handshake, and EVERY sign-in would fail with a
 * message about a request that could not be matched. It is the single most common way an OAuth
 * implementation is broken, and it fails identically for everybody, which makes it read as a
 * configuration fault rather than a cookie attribute.
 *
 * `Lax` is not a weakening here: the value this cookie protects is `state`, and `state` is what makes the
 * cross-site arrival safe in the first place.
 *
 * No `Domain`, deliberately, even where the session cookies set one: a handshake is finished on the host
 * that started it, and a host-only cookie is not shared with a sibling subdomain.
 *
 * `Secure` follows the deployment for the same reason as the session cookies — a `Secure` cookie is
 * silently dropped over plain http, which would make local development look like a broken sign-in with
 * nothing in any log.
 */
function handshakeCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: HANDSHAKE_COOKIE_PATH,
    maxAge: HANDSHAKE_TTL_SECONDS
  };
}

/**
 * Open a handshake on `response`.
 *
 * ⚠ ONE COOKIE, so starting a second sign-in in another tab REPLACES the first. That is a real
 * limitation and it is the right trade: a cookie per handshake would need a name derived from the state,
 * which puts an attacker-influenced value in a cookie name and leaves the orphans to expire on their own.
 * The reader's experience of the abandoned tab is one "start again" sentence.
 */
export function writeHandshakeCookie<T>(
  response: NextResponse<T>,
  value: OAuthHandshakeState
): void {
  response.cookies.set(
    OAUTH_HANDSHAKE_COOKIE,
    JSON.stringify({ ...value, next: safeStudioPath(value.next) }),
    handshakeCookieOptions()
  );
}

/** A field that must look like one of `createHandshake`'s base64url secrets. */
function readSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < MIN_SECRET_LENGTH || value.length > MAX_SECRET_LENGTH) return null;
  return value;
}

/**
 * The open handshake, or null.
 *
 * EVERY FIELD IS RE-VALIDATED. The cookie is `httpOnly`, so no script on the origin can write it — but
 * `httpOnly` is not integrity: it is unsigned, and anything that can set a cookie for this host (an
 * intermediary on a plain-http deployment, a compromised sibling host) can put whatever it likes in it.
 * A `next` read back without validation would be an open redirect that no reviewer of the start route
 * would ever see, and an unrecognisable provider string would reach Prisma as an enum value.
 *
 * Null for anything malformed rather than a throw: a browser that dropped or truncated the cookie is the
 * ordinary case, and the answer to it is the same "start again" sentence as an expired handshake.
 */
export function readHandshakeCookie(request: NextRequest): OAuthHandshakeState | null {
  const raw = request.cookies.get(OAUTH_HANDSHAKE_COOKIE)?.value;
  if (!raw || raw.length > MAX_COOKIE_LENGTH) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.toUpperCase() : "";
  if (!isOAuthProvider(provider)) return null;

  const state = readSecret(record.state);
  const nonce = readSecret(record.nonce);
  const codeVerifier = readSecret(record.codeVerifier);
  if (!state || !nonce || !codeVerifier) return null;

  return {
    provider,
    state,
    nonce,
    codeVerifier,
    next: safeStudioPath(typeof record.next === "string" ? record.next : null)
  };
}

/**
 * Close the handshake.
 *
 * The attributes are the SETTER'S, with `maxAge: 0` — a clear that differs in path, sameSite or secure
 * creates a second cookie and the browser goes on sending the first, which for this cookie means a
 * handshake that survives its own use and is therefore replayable.
 */
export function clearHandshakeCookie<T>(response: NextResponse<T>): void {
  response.cookies.set(OAUTH_HANDSHAKE_COOKIE, "", {
    ...handshakeCookieOptions(),
    maxAge: 0,
    expires: new Date(0)
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Telling the reader what happened
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The query parameter the sign-in page reads, and the values it may carry.
 *
 * ⚠ A CODE, NEVER A SENTENCE. If the routes put the message itself in the URL, anybody could craft
 * `/studio/login?error=Your%20account%20is%20suspended,%20ring%20this%20number` and the sign-in page
 * would render it as if the Centre had written it. A closed set of codes means the page can only ever
 * display prose from this file, and an unrecognised code displays nothing at all.
 */
export const SIGN_IN_NOTICE_PARAM = "error";

export type SignInNotice =
  /** The button was pressed for a provider this deployment has no credentials for. */
  | "provider_unavailable"
  | "too_many"
  /** No handshake cookie: it expired, or the browser dropped it. */
  | "handshake_expired"
  /** `state` did not match, or the callback did not belong to the open handshake. */
  | "request_mismatch"
  /** The provider said the person declined, or was not asked. */
  | "provider_cancelled"
  /** The provider would not vouch that the address belongs to the account. */
  | "email_unverified"
  /** Anything else that went wrong between here and the provider. */
  | "sign_in_failed"
  /** The allow-list refused. ALWAYS the same sentence, whatever the underlying reason. */
  | "access_denied";

const NOTICES: Record<SignInNotice, string> = {
  provider_unavailable:
    "That way of signing in is not set up on this site. Use another method, or ask an administrator to set it up.",
  too_many:
    "There have been too many sign-in attempts from this connection. Wait a few minutes and try again.",
  handshake_expired:
    "That sign-in took too long to come back, so it was not completed. Nothing has changed — try again.",
  request_mismatch:
    "This sign-in could not be matched to the request that started it, so it was stopped. Start again from this page rather than from a link.",
  provider_cancelled: "That sign-in was cancelled, so nothing has changed. Try again when you are ready.",
  email_unverified:
    "Your provider would not confirm that the email address on that account belongs to you, so it cannot be used here. Confirm the address with the provider, or sign in another way.",
  sign_in_failed:
    "That sign-in could not be completed. Try again, or sign in with your email address and password.",
  // One message for every refusal. Distinguishing "not on the list" from "revoked" from "wrong button"
  // would turn this page into a directory of who works at the Centre; the real reason is in the audit log.
  access_denied: ACCESS_REFUSED_MESSAGE
};

/**
 * The sentence for a code from the URL, or null.
 *
 * For the sign-in page: `signInNoticeMessage(params.error)`. Null for anything unrecognised, which is
 * both the safe answer and the honest one — a code this build does not know about is not something the
 * reader can act on.
 */
export function signInNoticeMessage(code: string | string[] | null | undefined): string | null {
  // An array means the parameter was repeated. The first is what the URL parser would take, and taking
  // the last would let a crafted link append a second value after a legitimate one.
  const value = Array.isArray(code) ? code[0] : code;
  if (typeof value !== "string") return null;
  return Object.prototype.hasOwnProperty.call(NOTICES, value)
    ? NOTICES[value as SignInNotice]
    : null;
}

/**
 * Send the reader back to the sign-in page with something they can act on.
 *
 * A REDIRECT AND NEVER A JSON BODY: both of these routes are reached by a browser navigating, so an
 * error object would be rendered as text in an otherwise blank window with no way back.
 *
 * 303, matching `app/api/auth/refresh/route.ts`: whatever the browser was doing, it should now GET the
 * sign-in page. `no-store` because a cached refusal would be served to the next person to try.
 */
export function loginRedirect(
  request: NextRequest,
  notice: SignInNotice,
  next: string = DEFAULT_NEXT
): NextResponse {
  const url = new URL(STUDIO_LOGIN_PATH, requestOrigin(request));
  url.searchParams.set(SIGN_IN_NOTICE_PARAM, notice);

  // Carried so the reader still lands where they were going once they do get in. Re-validated rather
  // than trusted: this is the last point before it becomes part of a URL.
  const target = safeStudioPath(next);
  if (target !== DEFAULT_NEXT) url.searchParams.set("next", target);

  const response = NextResponse.redirect(url, 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
