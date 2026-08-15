import { NextResponse, type NextRequest } from "next/server";
import { notFound, route } from "@/lib/api";
import { authorizeUrl, createHandshake, providerConfig, providerFromSlug } from "@/lib/auth/oauth";
import {
  loginRedirect,
  requestOrigin,
  safeStudioPath,
  writeHandshakeCookie
} from "@/lib/auth/oauth-cookies";
import { RATE_LIMITS, checkRateLimit } from "@/lib/ratelimit";

/**
 * "Continue with Google / Microsoft / Yahoo" — the first half of the handshake.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ALL THIS ROUTE DOES is mint the three anti-replay values, remember them in one short-lived cookie,
 * and send the browser to the provider. It decides NOTHING about who may sign in: a provider answers
 * "who is this?" and never "should they be here?", and the allow-list is consulted in the callback
 * before any account exists. There is deliberately no database read here at all.
 *
 * EVERY FAILURE IS A REDIRECT TO THE SIGN-IN PAGE, not a JSON body. A person reached this URL by
 * pressing a button, so the browser is navigating; an error object would render as text in a blank
 * window with no way back. The one exception is an unknown provider in the path, which is a 404 —
 * see below.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const GET = route(
  async (request: NextRequest, context: { params: Promise<{ provider: string }> }) => {
    const { provider: slug } = await context.params;
    const provider = providerFromSlug(slug);

    /**
     * An unknown slug is a 404 rather than a redirect, and rather than a 500.
     *
     * Nothing links here except the sign-in page's own buttons, which are built from
     * `configuredProviders()`, so a request for `/api/auth/oauth/facebook/start` is a typed address or a
     * probe. "This does not exist" is the honest status for both, and it is the one that keeps the
     * address out of a crawler's index. `route()` turns this into the standard error body.
     */
    if (!provider) throw notFound("That way of signing in");

    // Validated before anything else uses it, and validated again when it comes back out of the cookie.
    const next = safeStudioPath(request.nextUrl.searchParams.get("next"));

    /**
     * Rate limited on the SIGN-IN policy, in its own bucket.
     *
     * Starting a handshake is a sign-in attempt, so it belongs under the same allowance as the password
     * form (`RATE_LIMITS.login`: twenty in a quarter of an hour, generous for a person and useless for a
     * script). The BUCKET is separate — `auth/oauth/start` rather than `auth/login` — so a script
     * hammering one door cannot lock a colleague out of the other.
     *
     * ⚠ `checkRateLimit` rather than `enforceRateLimit`, because `enforceRateLimit` answers with a JSON
     * 429 and this is a browser navigation. The reader gets the sentence on the sign-in page instead;
     * they lose the `Retry-After` header, which no browser would have acted on during a navigation
     * anyway.
     */
    const verdict = checkRateLimit(request, "auth/oauth/start", RATE_LIMITS.login);
    if (!verdict.ok) return loginRedirect(request, "too_many", next);

    /**
     * Not configured on this deployment is a NORMAL state, not a fault — most installations enable one
     * provider or two. The sign-in page only renders buttons for the configured ones, so reaching this
     * line means either a stale tab or a hand-typed URL. Either way the answer is a plain sentence on the
     * sign-in page, never a stack trace.
     */
    const config = providerConfig(provider);
    if (!config) return loginRedirect(request, "provider_unavailable", next);

    const handshake = createHandshake();

    /**
     * The origin the BROWSER used, which is what `redirect_uri` must be built from — and the callback
     * recomputes it the same way, from the same helper, because the provider compares the two.
     */
    const origin = requestOrigin(request);

    // 307 preserves the method, which for this GET is academic; it is the temporary redirect that says
    // "this address is not the destination, and it will not be next time either".
    const response = NextResponse.redirect(authorizeUrl({ config, origin, handshake }), 307);

    writeHandshakeCookie(response, {
      provider,
      state: handshake.state,
      nonce: handshake.nonce,
      // ⚠ THE VERIFIER, NOT THE CHALLENGE. The challenge went to the provider in the URL above; the
      // verifier is the secret that proves the code exchange belongs to this browser, and it must never
      // leave this server except inside an httpOnly cookie.
      codeVerifier: handshake.codeVerifier,
      next
    });

    // A cached redirect would hand a second visitor the first visitor's `state` and `nonce`.
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
);
