import { isIP } from "node:net";

/**
 * Where a request came from, read only from headers a TRUSTED hop wrote.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE LEFTMOST `X-Forwarded-For` ENTRY IS NEVER READ.
 *
 * Each proxy APPENDS the address it received the connection from, so the header is a list whose
 * left end is whatever the client chose to send. `curl -H "X-Forwarded-For: 203.0.113.$RANDOM"`
 * used to land every request in a fresh rate-limit bucket — the per-address limit on sign-in, the
 * second factor, the contact form and the newsletter form was one header away from not existing.
 * Only the entries our own infrastructure appended can be believed, and those are at the RIGHT.
 *
 * So the address comes from exactly one place, chosen by the deployment and never by the request:
 *
 *   1. **On Vercel** (`VERCEL=1`, which the platform sets on every function): `x-vercel-forwarded-for`,
 *      then `x-real-ip`. Vercel's edge writes both from the TCP connection and overwrites whatever
 *      the client sent, so they are not client-controlled. `x-forwarded-for` is not consulted there
 *      at all — `x-vercel-forwarded-for` exists precisely because a proxy in front of Vercel may
 *      rewrite the plain one.
 *   2. **Behind your own proxies** (Docker, a VM): `TRUSTED_PROXY_HOPS=<n>` says how many proxies
 *      you run in front of the app, and the client is the n-th entry FROM THE RIGHT of
 *      `x-forwarded-for` — the one the outermost trusted proxy appended. Fewer entries than hops
 *      means a request that did not come through them, and is answered with null.
 *   3. **Otherwise** — `TRUSTED_PROXY_HOPS` unset or 0 — there is no hop to trust, every forwarding
 *      header is the client's own say-so, and the answer is null. Callers already treat null as one
 *      shared `no-ip` bucket (lib/ratelimit.ts), which is the conservative direction.
 *
 * Anything that is not a syntactically valid IP address is null too: a header value is attacker
 * text, and an arbitrary string as a bucket key is an unbounded map.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Deliberately free of `server-only`, `next/*` and the database, so the unit tests can drive it with
 * a plain `Headers` and an environment object, and Server Actions (which have `headers()` rather than
 * a `Request`) can call it directly.
 */

/** The variables read: `VERCEL` and `TRUSTED_PROXY_HOPS`. `process.env` by default; tests pass their own. */
export type ClientIpEnv = Readonly<Record<string, string | undefined>>;

let warnedAboutHops = false;

/**
 * `TRUSTED_PROXY_HOPS` as a number. A malformed value is treated as 0 — trusting nothing — and said
 * once, loudly. Throwing would turn every rate-limited request into a 500; guessing a larger number
 * would re-open the spoof this module exists to close.
 */
export function trustedProxyHops(env: ClientIpEnv = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  if (!/^\d{1,2}$/.test(raw)) {
    if (!warnedAboutHops) {
      warnedAboutHops = true;
      console.error(
        `[client-ip] TRUSTED_PROXY_HOPS is "${raw}", which is not a small whole number, so no ` +
          "forwarding header is trusted and every visitor shares one rate-limit bucket. Set it to the " +
          "number of proxies in front of the app."
      );
    }
    return 0;
  }
  return Number.parseInt(raw, 10);
}

/**
 * One address as written by a proxy, or null. Accepts the forms proxies actually emit — a bare
 * address, `1.2.3.4:5678`, `[::1]:443`, and an IPv4-mapped IPv6 — and nothing else.
 *
 * The answer is in ONE canonical spelling, because it is used as an identity twice — a rate-limit
 * bucket key and the input to the audit fingerprint (lib/audit-ip.ts) — and both compare strings.
 * IPv6 has many spellings of one address (`2001:DB8::1`, `2001:db8:0::1`, `2001:0db8:0:0:0:0:0:1`),
 * so it is rebuilt in the RFC 5952 form (lower case, leading zeros dropped, the longest zero run
 * compressed) by the WHATWG URL parser rather than merely lower-cased. Every IPv4-mapped spelling
 * (`::ffff:1.2.3.4`, `0:0:0:0:0:ffff:1.2.3.4`, `::ffff:102:304`) becomes the plain IPv4 address. A
 * zone id (`fe80::1%eth0`) is refused: it names an interface on the proxy, not a client, and would
 * otherwise be one more free-text suffix on a bucket key.
 */
export function normaliseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 64) return null;

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed?.[1]) candidate = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) candidate = candidate.slice(0, candidate.lastIndexOf(":"));

  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family !== 6 || candidate.includes("%")) return null;
  return canonicalIpv6(candidate);
}

/** RFC 5952 text of a valid IPv6 address, or the IPv4 address it maps. Null if the parser disagrees. */
function canonicalIpv6(address: string): string | null {
  let host: string;
  try {
    host = new URL(`http://[${address}]/`).hostname;
  } catch {
    return null;
  }
  const canonical = host.slice(1, -1);
  // The URL serialiser writes a mapped address in hex (`::ffff:102:304`); `::ffff:1.2.3.4` and
  // `1.2.3.4` are the same visitor — one bucket, one fingerprint.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped?.[1] && mapped[2]) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return isIP(canonical) === 6 ? canonical : null;
}

/** Bits of an IPv6 address that name one subscriber: the /64 every ordinary allocation hands out. */
export const IPV6_SUBSCRIBER_PREFIX_BITS = 64;

/**
 * The part of an address that identifies ONE client for rate limiting, or null.
 *
 * An IPv4 address is used whole. An IPv6 address is cut to its /64: an ordinary connection — a home
 * line, a phone, a cloud VM — is given at least a /64 and may send each request from a different one
 * of its 2⁶⁴ addresses (privacy extensions do it on their own). Keyed on the full /128, every request
 * would open a fresh bucket — the same bypass a rotating `X-Forwarded-For` used to be — and would push
 * the in-memory map toward its ceiling, evicting legitimate buckets. The audit fingerprint keeps the
 * whole address (`normaliseIp`); only the limiter groups.
 */
export function rateLimitSubject(ip: string | null | undefined): string | null {
  const address = normaliseIp(ip);
  if (!address || isIP(address) !== 6) return address;
  return `${ipv6Prefix(address, IPV6_SUBSCRIBER_PREFIX_BITS / 16)}::/${IPV6_SUBSCRIBER_PREFIX_BITS}`;
}

/** The first `groups` 16-bit groups of a canonical IPv6 address, each without leading zeros. */
function ipv6Prefix(address: string, groups: number): string {
  const [head = "", tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const full = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return full
    .slice(0, groups)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":");
}

function entries(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The rightmost entry of a header that is meant to hold one address. */
function rightmost(header: string | null): string | null {
  const list = entries(header);
  return normaliseIp(list[list.length - 1]);
}

export function clientIpFromHeaders(headers: Headers, env: ClientIpEnv = process.env): string | null {
  if (env.VERCEL === "1") {
    return rightmost(headers.get("x-vercel-forwarded-for")) ?? rightmost(headers.get("x-real-ip"));
  }

  const hops = trustedProxyHops(env);
  if (hops === 0) return null;

  const forwarded = entries(headers.get("x-forwarded-for"));
  if (forwarded.length < hops) return null;
  return normaliseIp(forwarded[forwarded.length - hops]);
}

/**
 * The sentence an operator needs when this module can never find an address, or null when it can.
 *
 * ⚠ OFF VERCEL WITH NO TRUSTED HOP, `clientIpFromHeaders` ANSWERS NULL FOR EVERY REQUEST — and that is
 * not a bypass, it is the opposite failure: every visitor lands in the ONE shared `no-ip` bucket, so a
 * single stranger who spends the sign-in, second-factor or contact allowance locks everybody else out
 * of it, and the audit log records no network fingerprint at all. The Dockerfile and docker-compose
 * deployment reach exactly that state by leaving one variable unset, and nothing on screen said so.
 * This is surfaced twice: once at start-up (instrumentation.ts) and permanently in Settings →
 * Diagnostics (`configurationWarnings` in lib/env.ts).
 *
 * Not raised in development or test (`NODE_ENV` other than `production`): `next dev` on a laptop has
 * no proxy and sharing one bucket there is harmless.
 */
export function clientIpConfigurationWarning(env: ClientIpEnv = process.env): string | null {
  if (env.VERCEL === "1") return null;
  if (env.NODE_ENV !== "production") return null;
  if (trustedProxyHops(env) > 0) return null;
  return (
    "TRUSTED_PROXY_HOPS is not set and this is not a Vercel deployment, so no client address can be " +
    "trusted: every visitor shares ONE rate-limit bucket (one person can exhaust the sign-in, " +
    "two-factor and contact limits for everybody) and audit entries carry no network fingerprint. Set " +
    "TRUSTED_PROXY_HOPS to the number of proxies in front of the app (1 for the nginx in " +
    "docs/DEPLOYMENT.md)."
  );
}
