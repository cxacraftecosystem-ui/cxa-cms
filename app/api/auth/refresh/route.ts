import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@prisma/client";
import {
  assertSameOrigin,
  clientIp,
  ok,
  route,
  toErrorResponse,
  unauthorized,
  userAgent
} from "@/lib/api";
import { REFRESH_COOKIE } from "@/lib/auth/cookies";
import { rotateSession, type RotateResult } from "@/lib/auth/session";
import { accessTokenExpiresAt, applySession, clearSession } from "@/lib/auth/respond";

/**
 * Rotate the session. One route, two callers, two answer shapes.
 *
 *  • **GET, from middleware.** A reader's access token expired while they were reading; middleware
 *    sends the browser here with `?next=` and this route redirects them onward with fresh cookies.
 *    The reader sees one extra hop and nothing else.
 *  • **POST, from the browser client.** `lib/client/fetcher.ts` calls it after a 401 and retries the
 *    original request. It reads JSON, so it must never be handed a redirect to an HTML page.
 *
 * ON ANY FAILURE THE COOKIES ARE CLEARED. That is not tidiness: middleware sends a request here
 * *because* a refresh cookie exists, so a failed refresh that left the cookie in place would send
 * the next request straight back here, forever. Clearing is the loop breaker.
 *
 * The route runs on Node (Prisma), which is why middleware redirects to it rather than doing the
 * rotation itself.
 */

export const dynamic = "force-dynamic";

const DEFAULT_NEXT = "/studio";
const LOGIN_PATH = "/studio/login";

/**
 * Space and the C0/C7F control characters.
 *
 * Written as a code-point scan rather than a regular expression because the characters being looked
 * for are invisible in source: a literal control character inside a character class is impossible to
 * review and easy to mangle in an editor.
 */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate `?next=`. An open redirect on a login flow is a phishing primitive: a link that reads as
 * the Centre's own domain and lands on somebody else's copy of the sign-in page.
 *
 * Only a same-origin PATH survives, and the checks are more literal than they look:
 *
 *  • `//evil.example` is a protocol-relative URL, not a path — `new URL("//evil.example", origin)`
 *    resolves to another host entirely.
 *  • `/\evil.example` is the same attack in disguise. The WHATWG parser treats a backslash as a
 *    slash for http(s) URLs, so this also resolves to another host — and it survives a naive
 *    "starts with one slash" test, which is exactly why that test is not enough.
 *  • Control characters and spaces are refused because the parser STRIPS them, so a value that
 *    passed the checks above can still turn into something else by the time it is resolved.
 *  • `/api/...` is refused because no useful journey ends at an API route, and a redirect that
 *    downloads JSON reads as a broken sign-in.
 */
function safeNextPath(raw: string | null): string {
  if (!raw) return DEFAULT_NEXT;
  if (raw.length > 512) return DEFAULT_NEXT;
  if (!raw.startsWith("/")) return DEFAULT_NEXT;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_NEXT;
  if (hasUnsafeCharacter(raw)) return DEFAULT_NEXT;
  if (raw === "/api" || raw.startsWith("/api/")) return DEFAULT_NEXT;
  return raw;
}

/**
 * One sentence per reason. A session revoked for reuse is a different event from one that expired.
 *
 * ⚠ NEITHER SENTENCE MAY CLAIM A SIGN-OUT ON EVERY DEVICE, and an earlier version of both did. What
 * `rotateSession` performs is `revokeFamily`, and a family is one login's chain — lib/auth/session.ts
 * says so in as many words, "without touching the user's other devices". So a reader on a laptop and a
 * phone loses the laptop and keeps the phone. Told they had been signed out everywhere, they would
 * conclude the matter was closed at the very moment it is least likely to be: the reuse path exists
 * because theft cannot be ruled out, and the thief's own chain is a different family this did not
 * touch. The sentence therefore describes this device and points at the control that does cover the
 * rest — "Sign out of every device" on the account screen.
 */
function messageFor(reason: Exclude<RotateResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "reused":
      return (
        "This sign-in could not be verified, so this device has been signed out. If you did not expect " +
        "this, sign in again and use “Sign out of every device” on your account screen."
      );
    case "revoked":
      return "This sign-in has been ended, so this device has been signed out. Sign in again to continue.";
    case "user-inactive":
      return "This account is no longer active. An administrator can restore your access.";
    default:
      return "Your session has ended. Sign in again to continue.";
  }
}

/** Matches `SessionUser` in lib/auth/current-user.ts, so a client can swap one for the other. */
function toSessionUser(user: User) {
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

type Mode = "redirect" | "json";

function refuse(request: NextRequest, mode: Mode, target: string, message: string): NextResponse {
  let response: NextResponse;
  if (mode === "redirect") {
    const url = request.nextUrl.clone();
    url.search = "";
    url.pathname = LOGIN_PATH;
    url.searchParams.set("next", target);
    // 303: whatever the browser was doing, it should now GET the login page.
    response = NextResponse.redirect(url, 303);
  } else {
    // Built through `toErrorResponse` so the body is the same shape every other failure has —
    // `lib/client/fetcher.ts` renders `message` verbatim.
    response = toErrorResponse(unauthorized(message));
  }
  clearSession(response);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function handle(request: NextRequest, mode: Mode): Promise<NextResponse> {
  const target = safeNextPath(request.nextUrl.searchParams.get("next"));
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  if (!refreshToken) {
    return refuse(request, mode, target, "Your session has ended. Sign in again to continue.");
  }

  const rotated = await rotateSession({
    refreshToken,
    userAgent: userAgent(request),
    ipAddress: clientIp(request)
  });

  if (!rotated.ok) return refuse(request, mode, target, messageFor(rotated.reason));

  let response: NextResponse;
  if (mode === "redirect") {
    // `target` has been proved to be a single-slash same-origin path, so this cannot leave the site.
    response = NextResponse.redirect(new URL(target, request.nextUrl.origin), 303);
  } else {
    response = ok({
      user: toSessionUser(rotated.user),
      // The same instant the hint cookie carries, echoed for a client that would rather not read it.
      expiresAt: accessTokenExpiresAt().toISOString()
    });
  }

  await applySession(response, rotated.user, rotated.session);
  // A cached redirect would send a later request to the old destination with no rotation at all.
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const GET = route(async (request: NextRequest) => handle(request, "redirect"));

export const POST = route(async (request: NextRequest) => {
  // GET is exempt inside `assertSameOrigin`; a POST that rotates a session is exactly what it is for.
  assertSameOrigin(request);
  return handle(request, "json");
});
