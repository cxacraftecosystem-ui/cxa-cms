import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { studioWriteReachesPublicSite as reaches } from "@/lib/public-refresh";

/**
 * Which studio requests mark the public site stale (lib/public-refresh.ts).
 *
 * The rule is a DENY-list: a write refreshes unless its resource is known never to reach a public page,
 * so a resource added later is covered without anyone remembering to list it. These cases pin both
 * halves, because each fails differently — a public write that does not refresh is an edit that silently
 * does not appear; a private one that does is only a wasted re-render.
 */
describe("a studio write that a visitor can see refreshes the public site", () => {
  for (const [method, path] of [
    ["PATCH", "/api/studio/news/abc123"],
    ["POST", "/api/studio/news"],
    ["DELETE", "/api/studio/people/abc123"],
    ["PUT", "/api/studio/settings/branding"],
    ["POST", "/api/studio/navigation/order"],
    ["PATCH", "/api/studio/pages/abc/sections/def"],
    ["POST", "/api/studio/pages/abc/revisions/3/restore"],
    ["POST", "/api/studio/media/complete"],
    ["PATCH", "/api/studio/events/abc/registrations/def"],
    ["POST", "/api/studio/recycle-bin/restore"],
    ["PATCH", "/api/studio/users/abc"],
    // An editor's own name and picture are their byline on every article.
    ["PATCH", "/api/studio/account"],
    ["post", "/api/studio/projects"],
    // A resource nobody has written yet: covered by default.
    ["POST", "/api/studio/a-resource-added-next-year"]
  ] as const) {
    it(`${method} ${path}`, () => assert.equal(reaches(method, path), true));
  }
});

describe("a write that never reaches a public page does not refresh it", () => {
  for (const [method, path] of [
    ["PATCH", "/api/studio/inquiries/abc"],
    ["POST", "/api/studio/inquiries/bulk"],
    ["POST", "/api/studio/locks"],
    ["POST", "/api/studio/access"],
    ["POST", "/api/studio/events/abc/registrations/def/certificate"],
    ["POST", "/api/studio/publications/import/preview"],
    ["POST", "/api/studio/newsletter/issues/abc/send"],
    ["POST", "/api/studio/reindex"],
    ["POST", "/api/studio/templates"],
    ["POST", "/api/studio/media/presign"],
    ["POST", "/api/studio/files/presign"],
    ["POST", "/api/studio/pages/abc/preview-draft"],
    ["DELETE", "/api/studio/users/abc/sessions"],
    ["POST", "/api/studio/users/abc/two-factor"],
    ["POST", "/api/studio/users/abc/password-reset/email"]
  ] as const) {
    it(`${method} ${path}`, () => assert.equal(reaches(method, path), false));
  }
});

describe("only writes, and only studio writes, are considered", () => {
  it("a read never refreshes", () => {
    assert.equal(reaches("GET", "/api/studio/news/abc"), false);
    assert.equal(reaches("HEAD", "/api/studio/news/abc"), false);
  });

  it("a public endpoint is not a studio write", () => {
    assert.equal(reaches("POST", "/api/public/contact"), false);
    assert.equal(reaches("POST", "/api/auth/login"), false);
    assert.equal(reaches("POST", "/api/studio"), false);
  });

  it("a trailing slash does not change the verdict", () => {
    assert.equal(reaches("POST", "/api/studio/media/presign/"), false);
    assert.equal(reaches("PATCH", "/api/studio/news/abc/"), true);
  });
});
