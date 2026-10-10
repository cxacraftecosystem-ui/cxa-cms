import { NextResponse, type NextRequest } from "next/server";

import { route } from "@/lib/api";
import { checkRateLimit } from "@/lib/ratelimit";
import { NEWSLETTER_RATE_LIMITS } from "@/lib/newsletter/http";
import { NEWSLETTER_UNSUBSCRIBE_PATH } from "@/lib/newsletter/paths";
import { NEWSLETTER_TOKEN_QUERY_KEY, verifyNewsletterToken } from "@/lib/newsletter/tokens";
import { unsubscribeAddress } from "@/lib/newsletter/unsubscribe";

/**
 * RFC 8058 one-click unsubscribe — the URL in every mailing's `List-Unsubscribe` header.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * POST UNSUBSCRIBES AT ONCE, WITH NO PAGE. GET NEVER CHANGES ANYTHING.
 *
 * When a reader presses "Unsubscribe" beside the sender's name in Gmail, Yahoo or Apple Mail, the mail
 * provider's SERVER POSTs `List-Unsubscribe=One-Click` to this URL. Nobody is looking at a browser, so
 * the answer is a bare 200 and the unsubscribe has already happened. The token in the query string is
 * the same signed, non-expiring unsubscribe token the visible link carries.
 *
 * A GET is something else entirely: link scanners and "safe links" rewriters fetch every URL in a
 * message, header URLs included, before a person has seen it. A GET that unsubscribed would remove
 * readers who never asked to leave. So a GET is redirected to the unsubscribe page, where a person can
 * confirm with a button — which is also the right answer for an older client that opens the header URL
 * in a browser.
 *
 * ⚠ NO SAME-ORIGIN CHECK, deliberately, unlike every other public POST. The caller is a mail provider's
 * server, not this site's page, and a cross-site request can do nothing here that the token's holder
 * could not do anyway. The token is what authorises the change.
 *
 * ⚠ EVERY VALID REQUEST IS ANSWERED 200, including an address that is not on the list or is already
 * unsubscribed: the reader's intent is satisfied in each case, and a 4xx would make some clients show
 * "unsubscribe failed". An unreadable token is a 400 — the one answer that tells the client to fall back
 * to the visible link.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

function tokenFrom(request: Request): string {
  return new URL(request.url).searchParams.get(NEWSLETTER_TOKEN_QUERY_KEY)?.trim() ?? "";
}

export const POST = route(async (request: NextRequest) => {
  // The loosest newsletter limit, and the bucket is its own: a mail provider posts from a small pool of
  // addresses, so a busy morning of unsubscribes must not trip the page's limit or the other way round.
  const verdict = checkRateLimit(request, "newsletter-one-click", {
    limit: NEWSLETTER_RATE_LIMITS.unsubscribe.limit * 10,
    windowSeconds: NEWSLETTER_RATE_LIMITS.unsubscribe.windowSeconds
  });
  if (!verdict.ok) {
    return new NextResponse("Too many requests; try again shortly.", {
      status: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil(verdict.retryAfterSeconds))), "cache-control": "no-store" }
    });
  }

  const verified = verifyNewsletterToken("unsubscribe", tokenFrom(request));
  if (!verified.ok) {
    return new NextResponse("That unsubscribe link could not be read.", {
      status: 400,
      headers: { "cache-control": "no-store" }
    });
  }

  await unsubscribeAddress(verified.emailKey, { receipt: false });

  return new NextResponse("Unsubscribed.", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
  });
});

export const GET = route(async (request: NextRequest) => {
  const token = tokenFrom(request);
  const location = token
    ? `${NEWSLETTER_UNSUBSCRIBE_PATH}?${NEWSLETTER_TOKEN_QUERY_KEY}=${encodeURIComponent(token)}`
    : NEWSLETTER_UNSUBSCRIBE_PATH;
  // Relative, for the reason lib/newsletter/http.ts gives: behind a proxy, request.url's host is internal.
  return new NextResponse(null, { status: 303, headers: { location, "cache-control": "no-store" } });
});
