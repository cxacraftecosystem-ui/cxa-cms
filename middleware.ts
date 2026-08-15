import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth/cookies";
import { verifyAccessToken } from "@/lib/auth/tokens";

/**
 * The studio door.
 *
 * EDGE RUNTIME, WHICH DECIDES WHAT MAY BE IMPORTED. `jose` verifies the access token with WebCrypto
 * and runs here happily; Prisma does not run here at all. So this file must never import `lib/db.ts`
 * — nor anything that transitively pulls it in, which rules out `lib/api.ts`, `lib/audit.ts` and
 * `lib/auth/current-user.ts`. That is why the 401 body below is written out by hand instead of being
 * built with `unauthorized()`: it must stay byte-compatible with `lib/api.ts`'s `ApiErrorBody`, and
 * the comment beside it is the only thing keeping the two in step.
 *
 * THE ROLE CLAIM IS FOR ROUTING ONLY. The token carries `role` so a decision about where to send a
 * request can be made without a database round trip, but a token minted before a demotion stays
 * valid until it expires. Nothing here is an authorisation decision beyond "is there a live
 * session"; every read and every write inside the studio re-reads the authoritative role through
 * `requireUser()` / `requireRole()`, which go to the database. If you ever find yourself gating a
 * capability on `claims.role` in this file, you are building a permission that is up to thirty
 * minutes out of date.
 */

/** The one studio route that must stay reachable while signed out. */
const LOGIN_PATH = "/studio/login";

/**
 * The other one — and it is not optional.
 *
 * ⚠ `/studio/set-password` IS THE DESTINATION OF EVERY INVITATION AND EVERY PASSWORD LINK, and the
 * whole point of it is that the account has NO PASSWORD YET. Without this exemption the door below
 * redirects the visitor to the sign-in screen, where the one thing they cannot do is sign in: the
 * link is dead and the account can never be claimed. That is exactly the state this application
 * shipped in.
 *
 * The screen and `app/api/auth/set-password/route.ts` verify the signed token themselves — the token
 * IS the credential here, so letting the request through costs nothing. `/api/auth/*` is already
 * outside the matcher for the same reason the sign-in route is.
 */
const SET_PASSWORD_PATH = "/studio/set-password";

/** Where a request lands when there is nothing left to try. */
const REFRESH_PATH = "/api/auth/refresh";

const API_PREFIX = "/api/studio";

function withStudioHeaders<T>(response: NextResponse<T>): NextResponse<T> {
  // Every studio response, including the redirects — a redirect is a page a crawler can index too,
  // and `next.config.ts`'s header rule only covers `/studio/:path*`, not `/api/studio/*`.
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  return response;
}

/**
 * The two studio paths a signed-out visitor is allowed to reach.
 *
 * For the LOGIN screen this is belt and braces: `config.matcher` already excludes it, but a matcher
 * is a regular expression written once and read rarely, and if it ever stopped excluding the login
 * screen the redirect below would send that screen to itself — no way into the studio at all.
 *
 * For SET-PASSWORD this function is the ONLY guard, and deliberately so: excluding the path in
 * `config.matcher` instead would skip `withStudioHeaders` and publish a credential screen with no
 * `X-Robots-Tag`. Letting it through here keeps the noindex header on it.
 */
function isPublicStudioPath(pathname: string): boolean {
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return true;
  return pathname === SET_PASSWORD_PATH || pathname.startsWith(`${SET_PASSWORD_PATH}/`);
}

/**
 * Is this a speculative fetch rather than something a person is waiting for?
 *
 * Next prefetches studio links on hover, and several prefetches can be in flight at once. A refresh
 * token is SINGLE USE: `lib/auth/session.ts` rotates it and treats a second presentation of the same
 * token as theft, revoking the whole family. Two prefetches racing through the refresh route would
 * therefore sign the editor out of every device — while they were merely moving the mouse. A
 * speculative request never spends the token; it is refused, Next discards the prefetch, and the
 * click that follows is a real navigation that refreshes exactly once.
 */
function isSpeculative(request: NextRequest): boolean {
  const headers = request.headers;
  if (headers.get("next-router-prefetch") === "1") return true;
  if (headers.get("purpose") === "prefetch") return true;
  const secPurpose = headers.get("sec-purpose");
  return secPurpose !== null && secPurpose.includes("prefetch");
}

/**
 * A 401 in the exact shape of `lib/api.ts`'s error body.
 *
 * An `/api/studio/*` request that receives an HTML login page reports "Unexpected token '<' in JSON"
 * — which is the least useful thing a failed save can tell an editor, and sends whoever debugs it
 * looking at the parser rather than at the session. `lib/client/fetcher.ts` reads `message`
 * verbatim, and answers a 401 by refreshing once and replaying the request, which is precisely the
 * recovery this response should trigger.
 */
function unauthorizedJson(): NextResponse {
  return NextResponse.json(
    {
      error: true,
      message: "Your session has ended. Sign in again to continue.",
      code: "unauthenticated"
    },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  if (isPublicStudioPath(pathname)) return withStudioHeaders(NextResponse.next());

  const isApi = pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;

  if (accessToken) {
    const claims = await verifyAccessToken(accessToken);
    // `verifyAccessToken` returns null for every failure — expired, forged, wrong audience — so
    // there is exactly one branch here and no way for one kind of bad token to fall through.
    if (claims) return withStudioHeaders(NextResponse.next());
  }

  const hasRefreshToken = Boolean(request.cookies.get(REFRESH_COOKIE)?.value);

  // An API caller is NEVER redirected, even when a refresh could succeed. `fetch` follows a redirect
  // transparently and would arrive at the refresh route having lost the method and the body of a
  // POST; the caller would then receive the redirected GET's answer and report a save as successful.
  // The browser client already handles a 401 by refreshing once (through a single shared promise)
  // and replaying the original request, which is both correct and safe against the reuse detector.
  if (isApi) return withStudioHeaders(unauthorizedJson());

  const target = request.nextUrl.clone();
  target.search = "";

  if (hasRefreshToken && !isSpeculative(request)) {
    // The refresh route runs on Node, rotates the session, sets fresh cookies and redirects onward.
    // If it fails it CLEARS the cookies before redirecting to the login screen — so the next request
    // through here finds no refresh cookie and takes the branch below instead of coming back.
    target.pathname = REFRESH_PATH;
    target.searchParams.set("next", `${pathname}${search}`);
    return withStudioHeaders(NextResponse.redirect(target, 307));
  }

  if (hasRefreshToken) {
    // Speculative, and the session could probably be renewed — but not at the price above.
    return withStudioHeaders(new NextResponse(null, { status: 401 }));
  }

  target.pathname = LOGIN_PATH;
  target.searchParams.set("next", `${pathname}${search}`);
  return withStudioHeaders(NextResponse.redirect(target, 307));
}

/**
 * What the door covers.
 *
 * `/studio/((?!login$|login/).*)` is a negative lookahead, so the login screen is never matched and
 * can never be redirected to itself. `/api/auth/:path*` is absent by construction — the login,
 * logout and refresh routes have to answer while signed out, and matching them would make signing in
 * impossible. Next's own internals (`/_next/*`, the favicon, static files) are likewise absent by
 * construction: every pattern here is anchored to `/studio` or `/api/studio`, so nothing else in the
 * application is ever handed to this function.
 */
export const config = {
  matcher: ["/studio", "/studio/((?!login$|login/).*)", "/api/studio/:path*"]
};
