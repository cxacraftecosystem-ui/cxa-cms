import "server-only";
import { headers } from "next/headers";
import { siteUrl } from "@/lib/env";

/**
 * The origin a request actually arrived at, as opposed to the one the site is configured to publish.
 *
 * The site answers at more than one address — `aicraft.iitkgp.ac.in` and the `*.vercel.app` one it was
 * built on — and `NEXT_PUBLIC_SITE_URL` can name only one of them. That one is right for anything that
 * outlives the request: canonical URLs, the sitemap, Open Graph, and every link written into an email.
 * It is wrong for an address shown to the person looking at the screen, who should see the host they
 * are actually on.
 *
 * ⚠ NEVER USE THIS FOR A LINK THAT LEAVES THE REQUEST. An invitation or password link built from a
 * request header is the classic host-header poisoning bug: whoever forges the header chooses where
 * somebody else's credential is sent. Those use `siteUrl()`.
 *
 * The forwarded headers are only as trustworthy as the proxy that sets them — the same assumption
 * `assertSameOrigin()` in lib/api.ts makes. A forged header changes only the forger's own screen.
 */

/** A header a chain of proxies may have appended to. The ORIGINAL value is the leftmost one. */
function firstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/** Hostname, optionally with a port or in IPv6 brackets. Anything else is not a host. */
const HOST_SHAPE = /^[A-Za-z0-9._~\-[\]:%]{1,255}$/;

/**
 * The public origin from the forwarded headers, falling back to `fallback` for whatever is missing.
 *
 * A malformed host or scheme falls back rather than being patched up: a half-parsed host concatenated
 * into a URL is how a header becomes a redirect target.
 */
export function originFromHeaders(requestHeaders: Headers, fallback: URL): string {
  const forwardedProto = firstHeaderValue(requestHeaders.get("x-forwarded-proto"))?.toLowerCase();
  const protocol =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : fallback.protocol.replace(/:$/, "");

  const forwardedHost = firstHeaderValue(requestHeaders.get("x-forwarded-host"));
  const host = forwardedHost && HOST_SHAPE.test(forwardedHost) ? forwardedHost : fallback.host;

  if (!HOST_SHAPE.test(host)) return fallback.origin;
  return `${protocol}://${host}`;
}

/**
 * The origin of the request being rendered, for a server component or route handler with no
 * `NextRequest` in hand. Reading headers makes the caller dynamic, so this belongs on studio screens —
 * a cached public page would serve one visitor's host to everybody.
 */
export async function requestSiteUrl(): Promise<string> {
  const configured = new URL(siteUrl());
  const requestHeaders = await headers();
  const host = firstHeaderValue(requestHeaders.get("host"));
  const fallback = host && HOST_SHAPE.test(host) ? safeUrl(`${configured.protocol}//${host}`) : null;
  return originFromHeaders(requestHeaders, fallback ?? configured);
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
