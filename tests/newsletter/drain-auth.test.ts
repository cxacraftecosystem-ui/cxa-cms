import "./setup";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ApiError } from "@/lib/api";
import { assertNewsletterDrainAuthorised } from "@/lib/cron";

const saved = { drain: process.env.NEWSLETTER_DRAIN_SECRET, cron: process.env.CRON_SECRET };

function request(bearer?: string) {
  return new Request("https://cxa.example.org/api/cron/newsletter-drain", {
    method: "POST",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {}
  });
}

function refused(fn: () => void) {
  assert.throws(fn, (error: unknown) => error instanceof ApiError && error.status === 403);
}

describe("the drain's bearer", () => {
  afterEach(() => {
    process.env.NEWSLETTER_DRAIN_SECRET = saved.drain;
    process.env.CRON_SECRET = saved.cron;
    if (saved.drain === undefined) delete process.env.NEWSLETTER_DRAIN_SECRET;
    if (saved.cron === undefined) delete process.env.CRON_SECRET;
  });

  it("accepts NEWSLETTER_DRAIN_SECRET (GitHub) and CRON_SECRET (Vercel cron)", () => {
    process.env.NEWSLETTER_DRAIN_SECRET = "drain-secret-value-0123456789";
    process.env.CRON_SECRET = "cron-secret-value-0123456789";
    assert.doesNotThrow(() => assertNewsletterDrainAuthorised(request("drain-secret-value-0123456789")));
    assert.doesNotThrow(() => assertNewsletterDrainAuthorised(request("cron-secret-value-0123456789")));
  });

  it("refuses a wrong, missing or query-string secret", () => {
    process.env.NEWSLETTER_DRAIN_SECRET = "drain-secret-value-0123456789";
    delete process.env.CRON_SECRET;
    refused(() => assertNewsletterDrainAuthorised(request("drain-secret-value-012345678X")));
    refused(() => assertNewsletterDrainAuthorised(request("drain")));
    refused(() => assertNewsletterDrainAuthorised(request()));
    refused(() =>
      assertNewsletterDrainAuthorised(
        new Request("https://cxa.example.org/api/cron/newsletter-drain?secret=drain-secret-value-0123456789")
      )
    );
  });

  it("refuses everything when neither secret is configured", () => {
    delete process.env.NEWSLETTER_DRAIN_SECRET;
    delete process.env.CRON_SECRET;
    refused(() => assertNewsletterDrainAuthorised(request("")));
    refused(() => assertNewsletterDrainAuthorised(request("anything")));
  });
});
