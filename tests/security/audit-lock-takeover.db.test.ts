import { hasDatabase } from "../newsletter/setup";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { SessionUser } from "@/lib/auth/current-user";
import { lockHoldersForAuditRows } from "@/lib/audit-accounts";
import { withLockHolderNames } from "@/lib/audit-subject";
import { prisma } from "@/lib/db";
import { recordProvenance } from "@/lib/provenance";
import { acquireLock, takeOverLock } from "@/lib/studio/crud";

/**
 * A content-lock take-over against a real PostgreSQL: the row records both holders' addresses
 * (`editingHeldBy`) and ids (`editingHeldById`), plus the taker's email and IP (owner decision,
 * 2026-10-10 — docs/AUDIT-PRIVACY.md); the screens' join names them, and the recorded address names a
 * holder whose account has since been hard-deleted.
 *
 * ⚠ WRITES users, content_locks AND audit_logs ROWS (and removes only its own), so it refuses to run
 * against anything but a database on this machine — the same rule as audit-provenance.db.test.ts.
 */

const LOCAL = /@(127\.0\.0\.1|localhost|\[::1\]|postgres)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
const skip = !hasDatabase ? "no DATABASE_URL" : !LOCAL ? "DATABASE_URL is not a local database" : false;

const RUN = `lock-${Date.now()}`;
const HOLDER_EMAIL = `${RUN}-holder@cxa.example.org`;
const TAKER_EMAIL = `${RUN}-taker@cxa.example.org`;
const ENTITY_ID = `${RUN}-page`;
const GONE_ENTITY_ID = `${RUN}-gone-page`;
const ids: string[] = [];

function sessionUser(user: { id: string; email: string; name: string }): SessionUser {
  return {
    ...user,
    role: "EDITOR",
    avatarId: null,
    canPublish: true,
    canManageMedia: false,
    twoFactorEnabled: false
  } as unknown as SessionUser;
}

describe("a lock take-over in the audit log", { skip }, () => {
  let holder: { id: string; email: string; name: string };
  let taker: { id: string; email: string; name: string };

  before(async () => {
    holder = await prisma.user.create({
      data: { email: HOLDER_EMAIL, name: "Lock Holder", role: "EDITOR" },
      select: { id: true, email: true, name: true }
    }) as { id: string; email: string; name: string };
    taker = await prisma.user.create({
      data: { email: TAKER_EMAIL, name: "Lock Taker", role: "EDITOR" },
      select: { id: true, email: true, name: true }
    }) as { id: string; email: string; name: string };
    ids.push(holder.id, taker.id);

    await acquireLock(sessionUser(holder), "Page", ENTITY_ID);
    await takeOverLock({ actor: taker, ipAddress: "198.51.100.9" }, sessionUser(taker), "Page", ENTITY_ID, "About us");
  });

  after(async () => {
    await prisma.auditLog.deleteMany({
      where: { entityId: { in: [ENTITY_ID, GONE_ENTITY_ID] } }
    });
    await prisma.contentLock.deleteMany({ where: { entityId: { in: [ENTITY_ID, GONE_ENTITY_ID] } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("stores the holders by address and by id, and the taker's email and IP", async () => {
    const rows = await prisma.auditLog.findMany({ where: { entityType: "Page", entityId: ENTITY_ID } });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual(
      { by: (row.before as Record<string, unknown>).editingHeldBy, id: (row.before as Record<string, unknown>).editingHeldById },
      { by: HOLDER_EMAIL, id: holder.id }
    );
    assert.deepEqual(
      { by: (row.after as Record<string, unknown>).editingHeldBy, id: (row.after as Record<string, unknown>).editingHeldById },
      { by: TAKER_EMAIL, id: taker.id }
    );
    assert.equal(row.actorId, taker.id);
    assert.equal(row.actorEmail, TAKER_EMAIL);
    assert.equal(row.ipAddress, "198.51.100.9");
    assert.ok(row.ipHash, "the fingerprint is still written beside the address");

    const holders = await lockHoldersForAuditRows(rows);
    assert.equal(withLockHolderNames(row.before as Record<string, unknown>, holders).editingHeldBy, "Lock Holder");
    assert.equal(withLockHolderNames(row.after as Record<string, unknown>, holders).editingHeldBy, "Lock Taker");
  });

  it("names a hard-deleted holder by the address recorded at the time", async () => {
    const goneEmail = `${RUN}-gone@cxa.example.org`;
    const gone = (await prisma.user.create({
      data: { email: goneEmail, name: "Gone Holder", role: "EDITOR" },
      select: { id: true, email: true, name: true }
    })) as { id: string; email: string; name: string };
    ids.push(gone.id);
    await acquireLock(sessionUser(gone), "Page", GONE_ENTITY_ID);
    await takeOverLock({ actor: taker, ipAddress: "198.51.100.9" }, sessionUser(taker), "Page", GONE_ENTITY_ID, "Gone");
    await prisma.user.delete({ where: { id: gone.id } });

    const rows = await prisma.auditLog.findMany({ where: { entityType: "Page", entityId: GONE_ENTITY_ID } });
    assert.equal(rows.length, 1);
    const holders = await lockHoldersForAuditRows(rows);
    assert.equal(holders.has(gone.id), false, "the account is gone");
    assert.equal(withLockHolderNames(rows[0]!.before as Record<string, unknown>, holders).editingHeldBy, goneEmail);
  });

  it("is headlined as 'editingHeldBy' in the record's timeline, never by the stored id field", async () => {
    // The timeline (like the audit list answer) names changed fields without values; it must name the
    // field the single-entry view shows, not the storage name.
    const result = await recordProvenance("Page", ENTITY_ID);
    const event = result.timeline.items.find((item) => item.action === "UPDATE");
    assert.ok(event, JSON.stringify(result.timeline.items));
    assert.ok(event.changedFields.includes("editingHeldBy"), JSON.stringify(event.changedFields));
    assert.ok(!event.changedFields.includes("editingHeldById"), JSON.stringify(event.changedFields));
  });
});
