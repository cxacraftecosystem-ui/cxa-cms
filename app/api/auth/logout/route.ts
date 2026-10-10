import type { NextRequest } from "next/server";
import { assertSameOrigin, clientIp, ok, route, userAgent } from "@/lib/api";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "@/lib/auth/cookies";
import { verifyAccessToken } from "@/lib/auth/tokens";
import { revokeSessionByToken } from "@/lib/auth/session";
import { clearSession } from "@/lib/auth/respond";
import { recordEvent } from "@/lib/audit";

/**
 * Sign out — this device only.
 *
 * `revokeSessionByToken` deliberately does not touch the rest of the family: signing out of a shared
 * workstation must not sign the same person out of the phone in their pocket. "Sign out everywhere"
 * is a separate, explicit action (`revokeAllSessionsForUser`).
 *
 * THIS ROUTE ALWAYS SUCCEEDS. A request with no cookies, an expired token, a token whose session was
 * already revoked — all of them answer 200 and clear the cookies. Logging out twice is not an error,
 * and a 401 on the way out is the single most useless thing to tell someone who is leaving: they
 * cannot act on it, and the browser would keep the stale cookie it was refusing to clear.
 *
 * The revocation runs BEFORE the response is built so a database failure surfaces as a 500 with the
 * cookies still in place, rather than as a signed-out browser holding a session that is still live
 * on the server.
 */

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;

  // Read for the audit entry only. An expired token still names the person who is leaving, which is
  // the whole value of the record — but it grants nothing here, because nothing here is gated.
  const claims = accessToken ? await verifyAccessToken(accessToken) : null;

  if (refreshToken) await revokeSessionByToken(refreshToken);

  const response = ok({ signedOut: true });
  clearSession(response);

  // Nothing to record when there was no session in the first place: an entry with no actor and no
  // token behind it is noise in the one log people read during an incident.
  if (claims || refreshToken) {
    await recordEvent(
      {
        actor: claims ? { id: claims.sub, email: claims.email } : null,
        ipAddress: clientIp(request),
        userAgent: userAgent(request)
      },
      {
        action: "LOGOUT",
        entityType: "User",
        entityId: claims?.sub ?? null,
        entityLabel: claims?.email ?? null
      }
    );
  }

  return response;
});
