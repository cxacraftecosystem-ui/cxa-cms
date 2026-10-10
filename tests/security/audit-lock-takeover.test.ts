import "../newsletter/setup";

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import type { SessionUser } from "@/lib/auth/current-user";
import { DELETED_ACTOR_LABEL } from "@/lib/audit-actor";
import { displayFieldNames, lockHolderIds, withLockHolderNames } from "@/lib/audit-subject";

/**
 * Taking over another editor's lock writes an audit row filed against the CONTENT (a page, a post), which
 * `scrubAccountIdentity` does not rewrite. It used to record both holders' addresses as `editingHeldBy`;
 * it must name them by account id, and the screens join the name at read time.
 *
 * No database: `prisma` is replaced on `globalThis` (lib/db.ts reuses it outside production) BEFORE
 * lib/studio/crud.ts is imported, and the transaction is a stand-in that records the audit insert.
 */

const HOLDER_EMAIL = "previous.holder@cxa.example.org";
const TAKER_EMAIL = "new.holder@cxa.example.org";

const inserts: Record<string, unknown>[] = [];
const now = Date.now();
const previousLock = {
  userId: "user_prev",
  acquiredAt: new Date(now - 60_000),
  expiresAt: new Date(now + 60_000),
  user: { id: "user_prev", name: "Previous Holder", email: HOLDER_EMAIL }
};

const tx = {
  contentLock: {
    findUnique: async () => previousLock,
    upsert: async () => ({
      userId: "user_new",
      acquiredAt: new Date(now),
      expiresAt: new Date(now + 120_000),
      user: { id: "user_new", name: "New Holder", email: TAKER_EMAIL }
    })
  },
  auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void inserts.push(data) }
};

(globalThis as unknown as { prisma: unknown }).prisma = {
  $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx)
};

const taker = {
  id: "user_new",
  email: TAKER_EMAIL,
  name: "New Holder",
  role: "EDITOR",
  avatarId: null,
  canPublish: true,
  canManageMedia: false,
  twoFactorEnabled: false
} as unknown as SessionUser;

describe("taking over an editing lock", () => {
  let row: Record<string, unknown> = {};

  before(async () => {
    const { takeOverLock } = await import("@/lib/studio/crud");
    await takeOverLock({ actor: taker, ipAddress: "198.51.100.7" }, taker, "Page", "page_1", "About us");
    assert.equal(inserts.length, 1, "a take-over writes one audit row");
    row = inserts[0] ?? {};
  });

  it("stores neither holder's address anywhere in the row", () => {
    const text = JSON.stringify(row);
    assert.ok(!text.includes(HOLDER_EMAIL), text);
    assert.ok(!text.includes(TAKER_EMAIL), text);
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]/i.test(text), text);
  });

  it("names both holders by account id instead", () => {
    assert.equal((row.before as Record<string, unknown>).editingHeldById, "user_prev");
    assert.equal((row.after as Record<string, unknown>).editingHeldById, "user_new");
    assert.deepEqual(lockHolderIds([row]).sort(), ["user_new", "user_prev"]);
  });

  it("is shown by the joined name at read time, and as 'Deleted user' once the account is gone", () => {
    const holders = new Map([["user_prev", { name: "Previous Holder", email: HOLDER_EMAIL }]]);
    const shownBefore = withLockHolderNames(row.before as Record<string, unknown>, holders);
    const shownAfter = withLockHolderNames(row.after as Record<string, unknown>, holders);
    assert.equal(shownBefore.editingHeldBy, "Previous Holder");
    assert.equal(shownAfter.editingHeldBy, DELETED_ACTOR_LABEL);
    assert.ok(!("editingHeldById" in shownBefore));
    assert.equal(shownAfter.takenOver, true);
  });

  it("names the changed field 'editingHeldBy' in a list of headlines, as the single-entry view does", () => {
    // The list answer of app/api/studio/audit/route.ts and the provenance timeline report changed FIELD
    // NAMES from the stored payload; they must not leak the storage name `editingHeldById`.
    assert.deepEqual(displayFieldNames(["editingHeldById", "editingHeldSince", "takenOver"]), [
      "editingHeldBy",
      "editingHeldSince",
      "takenOver"
    ]);
    assert.deepEqual(displayFieldNames(["editingHeldBy", "editingHeldById"]), ["editingHeldBy"]);
    assert.deepEqual(displayFieldNames(["title"]), ["title"]);
  });

  it("leaves a payload without a lock holder untouched", () => {
    const payload = { title: "About us" };
    assert.equal(withLockHolderNames(payload, new Map()), payload);
    assert.equal(withLockHolderNames(null, new Map()), null);
  });
});
