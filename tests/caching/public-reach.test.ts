import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  declarePublicReach,
  notePublicReach,
  rowIsLive,
  runWithPublicReach,
  saveReach,
  scopeReachesPublic
} from "@/lib/public-reach";

/**
 * Whether a save touched anything a visitor can see (lib/public-reach.ts).
 *
 * The verdict decides whether a studio save marks the public site stale. Its two errors are not equal:
 * a wrong "private" is an edit that silently does not appear, a wrong "public" is a wasted re-render.
 * So these cases pin that ONLY a proven draft-to-draft save is private, and that anything the verdict
 * cannot see clearly comes out unknown, which refreshes.
 */

const NOW = new Date("2026-11-23T10:00:00Z");
const PAST = new Date("2026-11-01T00:00:00Z");
const FUTURE = new Date("2026-12-25T00:00:00Z");

describe("a single row's liveness", () => {
  it("published is live; draft, in review and archived are not", () => {
    assert.equal(rowIsLive({ status: "PUBLISHED" }, NOW), true);
    assert.equal(rowIsLive({ status: "DRAFT" }, NOW), false);
    assert.equal(rowIsLive({ status: "IN_REVIEW" }, NOW), false);
    assert.equal(rowIsLive({ status: "ARCHIVED" }, NOW), false);
  });

  it("scheduled is live once its time has passed, and unknown without the date", () => {
    assert.equal(rowIsLive({ status: "SCHEDULED", publishAt: PAST }, NOW), true);
    assert.equal(rowIsLive({ status: "SCHEDULED", publishAt: FUTURE }, NOW), false);
    assert.equal(rowIsLive({ status: "SCHEDULED" }, NOW), null);
  });

  it("a soft-deleted or retired row is not live", () => {
    assert.equal(rowIsLive({ status: "PUBLISHED", deletedAt: PAST }, NOW), false);
    assert.equal(rowIsLive({ status: "PUBLISHED", unpublishAt: PAST }, NOW), false);
  });

  it("reads dates stored as strings, as a revision's JSON carries them", () => {
    assert.equal(rowIsLive({ status: "SCHEDULED", publishAt: PAST.toISOString() }, NOW), true);
    assert.equal(rowIsLive({ status: "PUBLISHED", deletedAt: PAST.toISOString() }, NOW), false);
  });

  it("a row with no publication status cannot say", () => {
    assert.equal(rowIsLive({ id: "x", label: "Menu item" }, NOW), null);
    assert.equal(rowIsLive({ status: "NEW" }, NOW), null); // an inquiry's status, not a publication's
    assert.equal(rowIsLive(null, NOW), null);
    assert.equal(rowIsLive(undefined, NOW), null);
  });
});

describe("one save's verdict", () => {
  it("a draft that stays a draft is private — the autosave case", () => {
    assert.equal(saveReach("UPDATE", { status: "DRAFT" }, { status: "DRAFT" }, NOW), "private");
    assert.equal(saveReach("CREATE", undefined, { status: "DRAFT" }, NOW), "private");
  });

  it("publishing, withdrawing and editing a live record are public", () => {
    assert.equal(saveReach("PUBLISH", { status: "DRAFT" }, { status: "PUBLISHED" }, NOW), "public");
    assert.equal(saveReach("UPDATE", { status: "PUBLISHED" }, { status: "DRAFT" }, NOW), "public");
    assert.equal(saveReach("UPDATE", { status: "PUBLISHED" }, { status: "PUBLISHED" }, NOW), "public");
    assert.equal(
      saveReach("DELETE", { status: "PUBLISHED" }, { status: "PUBLISHED", deletedAt: NOW }, NOW),
      "public"
    );
  });

  it("anything it cannot see clearly is unknown, never private", () => {
    // The after-row was selected without its status.
    assert.equal(saveReach("UPDATE", { status: "DRAFT" }, { id: "x" }, NOW), "unknown");
    // No before-row was passed for an update.
    assert.equal(saveReach("UPDATE", undefined, { status: "DRAFT" }, NOW), "unknown");
    // A status-less record: settings, a menu, a media asset.
    assert.equal(saveReach("UPDATE", { value: 1 }, { value: 2 }, NOW), "unknown");
  });
});

describe("a request's decision", () => {
  const decide = (record: () => void) => {
    const { scope } = runWithPublicReach(record);
    return scopeReachesPublic(scope);
  };

  it("refreshes when nothing was recorded — the write went some other way", () => {
    assert.equal(decide(() => {}), true);
  });

  it("stands down only when every save was proven private", () => {
    assert.equal(decide(() => notePublicReach("private")), false);
    assert.equal(decide(() => { notePublicReach("private"); notePublicReach("private"); }), false);
    assert.equal(decide(() => { notePublicReach("private"); notePublicReach("unknown"); }), true);
    assert.equal(decide(() => { notePublicReach("private"); notePublicReach("public"); }), true);
  });

  it("a route's declaration wins, and any `true` among several wins", () => {
    assert.equal(decide(() => { notePublicReach("unknown"); declarePublicReach(false); }), false);
    assert.equal(decide(() => { declarePublicReach(false); declarePublicReach(true); }), true);
  });

  it("keeps its record across awaits inside the request", async () => {
    const { result, scope } = runWithPublicReach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      notePublicReach("private");
    });
    await result;
    assert.equal(scopeReachesPublic(scope), false);
  });

  it("outside any request the recorders are no-ops", () => {
    assert.doesNotThrow(() => notePublicReach("public"));
    assert.doesNotThrow(() => declarePublicReach(true));
  });
});
