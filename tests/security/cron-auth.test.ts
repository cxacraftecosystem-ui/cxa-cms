import "../newsletter/setup";

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { ApiError } from "@/lib/api";
import { assertCronAuthorised, assertNewsletterDrainAuthorised } from "@/lib/cron";

/**
 * The cron secret is a bearer header and nothing else. A `?secret=` in the URL — even the right one —
 * is a 401, and the value never reaches a log line.
 */

const SECRET = "cron-secret-value-0123456789abcdef";
const saved = { cron: process.env.CRON_SECRET, drain: process.env.NEWSLETTER_DRAIN_SECRET };

function call(path: string, bearer?: string) {
  return new Request(`https://cxa.example.org${path}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {}
  });
}

function status(fn: () => void): number | "ok" {
  try {
    fn();
    return "ok";
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
}

describe("the cron secret", () => {
  let logged: string[] = [];

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    process.env.NEWSLETTER_DRAIN_SECRET = "drain-secret-value-0123456789abcdef";
    logged = [];
    mock.method(console, "error", (...args: unknown[]) => logged.push(args.map(String).join(" ")));
    mock.method(console, "warn", (...args: unknown[]) => logged.push(args.map(String).join(" ")));
  });

  afterEach(() => {
    mock.restoreAll();
    if (saved.cron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved.cron;
    if (saved.drain === undefined) delete process.env.NEWSLETTER_DRAIN_SECRET;
    else process.env.NEWSLETTER_DRAIN_SECRET = saved.drain;
  });

  it("accepts the Authorization: Bearer header (what Vercel Cron sends)", () => {
    assert.equal(status(() => assertCronAuthorised(call("/api/cron/purge", SECRET))), "ok");
  });

  it("refuses the right secret in the query string with a 401", () => {
    assert.equal(status(() => assertCronAuthorised(call(`/api/cron/purge?secret=${SECRET}`))), 401);
  });

  it("refuses a query secret even alongside a valid bearer, so a leaking scheduler fails loudly", () => {
    assert.equal(status(() => assertCronAuthorised(call(`/api/cron/purge?secret=${SECRET}`, SECRET))), 401);
    assert.equal(
      status(() => assertNewsletterDrainAuthorised(call(`/api/cron/newsletter-drain?secret=${SECRET}`, SECRET))),
      401
    );
  });

  it("answers a missing or wrong bearer with 401, and an unconfigured deployment with 403", () => {
    assert.equal(status(() => assertCronAuthorised(call("/api/cron/purge"))), 401);
    assert.equal(status(() => assertCronAuthorised(call("/api/cron/purge", `${SECRET}x`))), 401);
    assert.equal(status(() => assertCronAuthorised(call("/api/cron/purge", "Bearer"))), 401);
    delete process.env.CRON_SECRET;
    assert.equal(status(() => assertCronAuthorised(call("/api/cron/purge", SECRET))), 403);
  });

  it("never writes a query-string secret to the log", () => {
    status(() => assertCronAuthorised(call(`/api/cron/purge?secret=${SECRET}`)));
    status(() => assertCronAuthorised(call("/api/cron/purge?secret=some-other-guess-123")));
    assert.ok(logged.length > 0, "the refusal is reported to the operator");
    for (const line of logged) {
      assert.ok(!line.includes(SECRET), "the configured secret is not logged");
      assert.ok(!line.includes("some-other-guess-123"), "a guessed secret is not logged");
    }
  });
});
