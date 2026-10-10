import type { NextRequest } from "next/server";
import { z } from "@/lib/zod";
import { assertSameOrigin, clientIp, ok, parseJson, route, userAgent } from "@/lib/api";
import type { AuditContext } from "@/lib/audit";
import {
  FORGOT_PASSWORD_MESSAGE,
  deferUntilAfterResponse,
  requestPasswordReset
} from "@/lib/auth/password-reset";
import { RATE_LIMITS, enforceRateLimitAsync } from "@/lib/ratelimit";

/**
 * "Forgot your password?" — ask for a password link by email.
 *
 * Serves `POST /api/auth/forgot-password`, called by `app/studio/login/forgot/ForgotPasswordForm.tsx`.
 * Outside the proxy's matcher like every `/api/auth/*` route, because the person asking has no session.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * FOUR RULES, ALL ABOUT WHAT AN ANSWER REVEALS.
 *
 * 1. ONE ANSWER. A well-formed request ALWAYS gets 200 and `FORGOT_PASSWORD_MESSAGE`, whatever happened —
 *    a real account, an unknown address, a switched-off account, a throttled address, a failed send, a
 *    site with no email set up. The staff directory is public, so any difference would be an
 *    account-existence oracle pointed at a list of real addresses. The only answers that differ are about
 *    the REQUEST, never the account: a malformed address (422) and too many requests from this connection
 *    (429).
 *
 * 2. THE SAME SPEED. Everything that depends on the address — the lookup, the token, the SES round trip,
 *    the audit row — runs in `after()`, once the response has gone (`deferUntilAfterResponse`). Matching
 *    words are no use if a real account takes 400 ms longer to answer.
 *
 * 3. TWO LIMITS. Per client IP here (`RATE_LIMITS.passwordResetRequest`, keyed by `rateLimitSubject` inside
 *    lib/ratelimit.ts, so an IPv6 /64 is one client) — a 429, because it is about the connection. Per
 *    TARGET ADDRESS inside `requestPasswordReset` (`RATE_LIMITS.passwordResetAddress`) — silent, because
 *    a 429 there would say the address had been asked about.
 *
 * 4. THE LINK'S ORIGIN IS THE CONFIGURED ONE. `issueCredentialLink` builds it from `siteUrl()`
 *    (`NEXT_PUBLIC_SITE_URL`). Nothing in this request — `Host`, `X-Forwarded-Host`, `Origin` — reaches
 *    the link, so a forged header cannot send somebody's credential to the forger's domain.
 *
 * What a request deliberately does NOT do (revoke sessions, clear the throttle, mention two-step
 * verification) is set out at `requestPasswordReset` in lib/auth/password-reset.ts.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const Body = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address.")
    .max(320, "That is longer than any email address can be.")
    .email("That does not look like an email address.")
});

export const POST = route(async (request: NextRequest) => {
  assertSameOrigin(request);

  // Before the body and before any database work, so a flood costs one map lookup.
  const limited = await enforceRateLimitAsync(
    request,
    "auth:forgot-password",
    RATE_LIMITS.passwordResetRequest,
    (phrase) =>
      `Too many password-link requests from this connection. Try again in ${phrase}. If you are locked out ` +
      "now, an administrator can make you a link."
  );
  if (limited) return limited;

  const body = await parseJson(request, Body);

  // The person asking is not signed in, so there is no actor — the same shape a refused sign-in records.
  const context: AuditContext = {
    actor: null,
    ipAddress: clientIp(request),
    userAgent: userAgent(request)
  };

  // Rule 2: everything that depends on WHICH address this is happens after the answer has gone.
  deferUntilAfterResponse(() => requestPasswordReset({ email: body.email, context }));

  // Rule 1. `no-store`, so no shared cache can hold one person's answer for another.
  return ok({ message: FORGOT_PASSWORD_MESSAGE }, { headers: { "Cache-Control": "no-store" } });
});
