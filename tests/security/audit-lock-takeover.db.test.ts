import { hasDatabase } from "../newsletter/setup";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { SessionUser } from "@/lib/auth/current-user";
import { lockHoldersForAuditRows } from "@/lib/audit-accounts";
import { withLockHolderNames } from "@/lib/audit-subject";
import { prisma } from "@/lib/db";
import { recordProvenance } from "@/lib/provenance";
import { acquireLock, takeOverLock } from "@/lib/studio/crud";

/**
 * A content-lock take-over against a real PostgreSQL: the row names both holders by id and holds no
 * address, the screens' join names them again, and step 5 of the optional legacy scrub
 * (prisma/manual/audit_log_scrub_legacy_pii.sql) turns an older row's addresses into ids.
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
const LEGACY_ENTITY_ID = `${RUN}-legacy-page`;
const REUSED_ENTITY_ID = `${RUN}-reused-page`;
const EVIDENCE_ENTITY_ID = `${RUN}-evidence`;
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

/** Step 5 of the manual scrub, uncommented, as separate statements. */
function scrubStepFive(): string[] {
  const file = readFileSync(path.join(process.cwd(), "prisma", "manual", "audit_log_scrub_legacy_pii.sql"), "utf8");
  const start = file.indexOf("-- -- 5.");
  const end = file.indexOf("-- -- 6.", start);
  assert.ok(start > 0 && end > start, "step 5 is in the scrub file");
  const sql = file
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.startsWith("-- --"))
    .map((line) => line.replace(/^-- ?/, ""))
    .join("\n");
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
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
      where: { entityId: { in: [ENTITY_ID, LEGACY_ENTITY_ID, REUSED_ENTITY_ID, EVIDENCE_ENTITY_ID] } }
    });
    await prisma.contentLock.deleteMany({ where: { entityId: ENTITY_ID } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("stores the holders by id and no address", async () => {
    const rows = await prisma.auditLog.findMany({ where: { entityType: "Page", entityId: ENTITY_ID } });
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    const text = JSON.stringify(row);
    assert.ok(!text.includes(HOLDER_EMAIL) && !text.includes(TAKER_EMAIL), text);
    assert.equal((row.before as Record<string, unknown>).editingHeldById, holder.id);
    assert.equal((row.after as Record<string, unknown>).editingHeldById, taker.id);

    const holders = await lockHoldersForAuditRows(rows);
    assert.equal(withLockHolderNames(row.before as Record<string, unknown>, holders).editingHeldBy, "Lock Holder");
    assert.equal(withLockHolderNames(row.after as Record<string, unknown>, holders).editingHeldBy, "Lock Taker");
  });

  it("the legacy scrub turns an older row's addresses into account ids", async () => {
    // What the old code wrote.
    const legacy = await prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entityType: "Page",
        entityId: LEGACY_ENTITY_ID,
        before: { editingHeldBy: HOLDER_EMAIL.toUpperCase(), lockHadExpired: false },
        after: { editingHeldBy: `${RUN}-gone@cxa.example.org`, takenOver: true }
      }
    });

    for (const statement of scrubStepFive()) await prisma.$executeRawUnsafe(statement);

    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.ok(!JSON.stringify(row).includes("@"), JSON.stringify(row));
    assert.deepEqual(row.before, { editingHeldById: holder.id, lockHadExpired: false });
    assert.deepEqual(row.after, { takenOver: true }, "an address that matches no account is dropped");
  });

  it("the legacy scrub names who had an address THEN, never whoever has it now", async () => {
    // The holder's address at the time was OLD; it has since been given to another account (`heir`).
    // A second address was a hard-deleted colleague's (their rows' actorId is now NULL) and has been
    // invited again for somebody new (`newcomer`). Matching on today's users table would name the wrong
    // person both times.
    const OLD = `${RUN}-old@cxa.example.org`;
    const GONE = `${RUN}-departed@cxa.example.org`;
    const heir = await prisma.user.create({ data: { email: OLD, name: "Heir", role: "EDITOR" }, select: { id: true } });
    const newcomer = await prisma.user.create({ data: { email: GONE, name: "Newcomer", role: "EDITOR" }, select: { id: true } });
    ids.push(heir.id, newcomer.id);

    // What the old writer left behind: every row carried the actor's address of the day.
    await prisma.auditLog.createMany({
      data: [
        { action: "LOGIN", entityType: "User", entityId: EVIDENCE_ENTITY_ID, actorId: holder.id, actorEmail: OLD },
        { action: "LOGIN", entityType: "User", entityId: EVIDENCE_ENTITY_ID, actorId: null, actorEmail: GONE }
      ]
    });
    const legacy = await prisma.auditLog.create({
      data: {
        action: "UPDATE",
        entityType: "Page",
        entityId: REUSED_ENTITY_ID,
        before: { editingHeldBy: OLD, lockHadExpired: false },
        after: { editingHeldBy: GONE, takenOver: true }
      }
    });

    for (const statement of scrubStepFive()) await prisma.$executeRawUnsafe(statement);

    const row = await prisma.auditLog.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.deepEqual(row.before, { editingHeldById: holder.id, lockHadExpired: false }, "the account that had it then");
    assert.deepEqual(row.after, { takenOver: true }, "a hard-deleted holder is dropped, not given to the newcomer");
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
