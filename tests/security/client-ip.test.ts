import "../newsletter/setup";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { clientIp } from "@/lib/api";
import { checkRateLimit } from "@/lib/ratelimit";
import { auditIpHashCandidates, hashAuditIp } from "@/lib/audit-ip";
import { clientIpConfigurationWarning, clientIpFromHeaders, normaliseIp, rateLimitSubject } from "@/lib/request-ip";

/**
 * The client address may come only from a hop the deployment trusts. Each case below sends a forged
 * `X-Forwarded-For` — the header any client can write — and checks it is never believed.
 */

const saved = { vercel: process.env.VERCEL, hops: process.env.TRUSTED_PROXY_HOPS };

function restore() {
  for (const [name, value] of [
    ["VERCEL", saved.vercel],
    ["TRUSTED_PROXY_HOPS", saved.hops]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function request(headers: Record<string, string>) {
  return new Request("https://cxa.example.org/api/auth/login", { method: "POST", headers });
}

describe("the client address", () => {
  afterEach(restore);

  it("ignores X-Forwarded-For entirely when no proxy is trusted", () => {
    delete process.env.VERCEL;
    delete process.env.TRUSTED_PROXY_HOPS;
    assert.equal(clientIp(request({ "x-forwarded-for": "203.0.113.66" })), null);
    assert.equal(clientIp(request({ "x-real-ip": "203.0.113.66" })), null);
  });

  it("never reads the leftmost entry: one trusted hop means the rightmost", () => {
    delete process.env.VERCEL;
    process.env.TRUSTED_PROXY_HOPS = "1";
    assert.equal(clientIp(request({ "x-forwarded-for": "203.0.113.66, 198.51.100.7" })), "198.51.100.7");
    assert.equal(clientIp(request({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 198.51.100.7" })), "198.51.100.7");
  });

  it("counts hops from the right, and refuses a chain shorter than the hops", () => {
    const env = { TRUSTED_PROXY_HOPS: "2" };
    const headers = (xff: string) => new Headers({ "x-forwarded-for": xff });
    assert.equal(clientIpFromHeaders(headers("203.0.113.66, 198.51.100.7, 10.0.0.2"), env), "198.51.100.7");
    assert.equal(clientIpFromHeaders(headers("10.0.0.2"), env), null);
  });

  it("on Vercel reads only the edge's headers, never X-Forwarded-For", () => {
    process.env.VERCEL = "1";
    delete process.env.TRUSTED_PROXY_HOPS;
    assert.equal(
      clientIp(request({ "x-forwarded-for": "203.0.113.66", "x-vercel-forwarded-for": "198.51.100.7" })),
      "198.51.100.7"
    );
    assert.equal(clientIp(request({ "x-forwarded-for": "203.0.113.66", "x-real-ip": "198.51.100.8" })), "198.51.100.8");
    assert.equal(clientIp(request({ "x-forwarded-for": "203.0.113.66" })), null);
  });

  it("refuses anything that is not an IP address, so a header cannot mint arbitrary bucket keys", () => {
    const env = { TRUSTED_PROXY_HOPS: "1" };
    assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "not-an-ip" }), env), null);
    assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "1.2.3.4, <script>" }), env), null);
    assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "1.2.3.4" }), { TRUSTED_PROXY_HOPS: "lots" }), null);
    assert.equal(normaliseIp("::FFFF:198.51.100.7"), "198.51.100.7");
    assert.equal(normaliseIp("198.51.100.7:4431"), "198.51.100.7");
    assert.equal(normaliseIp("[2001:db8::1]:443"), "2001:db8::1");
  });

  it("does not let a rotating spoofed header escape the rate limit", () => {
    delete process.env.VERCEL;
    process.env.TRUSTED_PROXY_HOPS = "1";
    const policy = { limit: 3, windowSeconds: 600 };
    const route = `test/spoof-${Date.now()}`;
    const verdicts = Array.from({ length: 6 }, (_, index) =>
      checkRateLimit(request({ "x-forwarded-for": `203.0.113.${index}, 198.51.100.7` }), route, policy)
    );
    assert.deepEqual(
      verdicts.map((verdict) => verdict.ok),
      [true, true, true, false, false, false]
    );
  });
});

describe("IPv6 clients", () => {
  afterEach(restore);

  it("writes one address in one canonical form, so equal addresses fingerprint equally", () => {
    assert.equal(normaliseIp("2001:DB8::1"), "2001:db8::1");
    assert.equal(normaliseIp("2001:db8:0::1"), "2001:db8::1");
    assert.equal(normaliseIp("2001:0db8:0000:0000:0000:0000:0000:0001"), "2001:db8::1");
    assert.equal(normaliseIp("[2001:DB8:0:0::1]:443"), "2001:db8::1");
    assert.equal(normaliseIp("0:0:0:0:0:ffff:1.2.3.4"), "1.2.3.4");
    assert.equal(normaliseIp("::ffff:102:304"), "1.2.3.4");
    assert.equal(normaliseIp("::FFFF:1.2.3.4"), "1.2.3.4");

    const env = { AUDIT_IP_HASH_SECRET: "audit-ip-key-0123456789abcdefghijklmnop" };
    assert.equal(hashAuditIp("2001:DB8::1", env), hashAuditIp("2001:db8:0::1", env));
    assert.equal(hashAuditIp("0:0:0:0:0:ffff:1.2.3.4", env), hashAuditIp("1.2.3.4", env));
    // An exact-address provenance search typed in another spelling still finds the stored row.
    assert.ok(auditIpHashCandidates("2001:0DB8::0:1", env).includes(hashAuditIp("2001:db8::1", env) ?? ""));
  });

  it("refuses a zone id, which names the proxy's interface rather than a client", () => {
    assert.equal(normaliseIp("fe80::1%eth0"), null);
    assert.equal(clientIpFromHeaders(new Headers({ "x-forwarded-for": "fe80::1%eth0" }), { TRUSTED_PROXY_HOPS: "1" }), null);
  });

  it("keys the rate limit on the /64, and keeps IPv4 whole", () => {
    assert.equal(rateLimitSubject("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(rateLimitSubject("2001:db8::2"), rateLimitSubject("2001:db8::1"));
    assert.equal(rateLimitSubject("2001:db8:0:0:ffff:abcd:1234:5678"), rateLimitSubject("2001:db8::1"));
    assert.notEqual(rateLimitSubject("2001:db8:0:1::1"), rateLimitSubject("2001:db8::1"));
    assert.equal(rateLimitSubject("198.51.100.7"), "198.51.100.7");
    assert.equal(rateLimitSubject("::ffff:198.51.100.7"), "198.51.100.7");
    assert.equal(rateLimitSubject("not-an-ip"), null);
  });

  it("does not let a client rotating through its /64 escape the rate limit", () => {
    process.env.VERCEL = "1";
    delete process.env.TRUSTED_PROXY_HOPS;
    const policy = { limit: 3, windowSeconds: 600 };
    const route = `test/v6-rotate-${Date.now()}`;
    const verdicts = Array.from({ length: 6 }, (_, index) =>
      checkRateLimit(request({ "x-vercel-forwarded-for": `2001:db8:1:2::${(index + 1).toString(16)}` }), route, policy)
    );
    assert.deepEqual(
      verdicts.map((verdict) => verdict.ok),
      [true, true, true, false, false, false]
    );
    // A different /64 is a different client.
    assert.ok(checkRateLimit(request({ "x-vercel-forwarded-for": "2001:db8:1:3::1" }), route, policy).ok);
  });
});

describe("the shared-bucket warning", () => {
  it("is raised off Vercel in production when no proxy hop is trusted, because everybody then shares one bucket", () => {
    const warning = clientIpConfigurationWarning({ NODE_ENV: "production" });
    assert.ok(warning, "a Docker deployment with TRUSTED_PROXY_HOPS unset must say so");
    assert.match(warning ?? "", /TRUSTED_PROXY_HOPS/);
    assert.ok(clientIpConfigurationWarning({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "0" }));
    assert.ok(clientIpConfigurationWarning({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "lots" }));
  });

  it("is quiet on Vercel, behind a configured proxy, and in development", () => {
    assert.equal(clientIpConfigurationWarning({ NODE_ENV: "production", VERCEL: "1" }), null);
    assert.equal(clientIpConfigurationWarning({ NODE_ENV: "production", TRUSTED_PROXY_HOPS: "1" }), null);
    assert.equal(clientIpConfigurationWarning({ NODE_ENV: "development" }), null);
  });
});
