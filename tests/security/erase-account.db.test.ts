import { hasDatabase } from "../newsletter/setup";

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import type { Role } from "@prisma/client";

import { ApiError } from "@/lib/api";
import type { AuditContext } from "@/lib/audit";
import {
  LAST_MASTER_ADMIN_ERASE,
  LAST_MASTER_GRANT_ERASE,
  eraseAccount,
  erasedEmailFor
} from "@/lib/auth/erase-account";
import { createSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

/**
 * Deleting an account permanently, against a real PostgreSQL (lib/auth/erase-account.ts).
 *
 * ⚠ WRITES users, sessions, oauth_accounts, content_locks, revisions, studio_access and audit_logs rows,
 * and removes only its own — except for the two lockout cases, which switch the OTHER master
 * administrators (and their access entries) off for the length of one call and put them back in a
 * `finally`. So, like the other *.db tests, it refuses anything but a database on this machine.
 */

const LOCAL = /@(127\.0\.0\.1|localhost|\[::1\]|postgres)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
const skip = !hasDatabase ? "no DATABASE_URL" : !LOCAL ? "DATABASE_URL is not a local database" : false;

const RUN = `erase-${Date.now()}`;
const ids: string[] = [];
const emails: string[] = [];

async function makeUser(label: string, role: Role) {
  const email = `${RUN}-${label}@cxa.example.org`;
  const user = await prisma.user.create({
    data: { email, name: `Erase ${label}`, role, passwordHash: "not-a-real-hash" },
    select: { id: true, email: true, name: true, role: true }
  });
  ids.push(user.id);
  emails.push(email);
  return user;
}

function contextFor(actor: { id: string; email: string }): AuditContext {
  return { actor, ipAddress: "198.51.100.40", userAgent: "erase-account.db.test" };
}

function refusedWith(status: number, message?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (message) assert.equal(error.message, message);
    return true;
  };
}

/**
 * Run `work` while every OTHER active master administrator (and every other unrevoked master-admin
 * entry, when `grants` is set) is switched off, then put each one back exactly as it was.
 */
async function aloneAsMaster(keep: string[], work: () => Promise<void>, grants = false) {
  const others = await prisma.user.findMany({
    where: { role: "MASTER_ADMIN", isActive: true, deletedAt: null, id: { notIn: keep } },
    select: { id: true }
  });
  const otherGrants = grants
    ? await prisma.studioAccess.findMany({
        where: { grantedRole: "MASTER_ADMIN", revokedAt: null, email: { notIn: emails } },
        select: { id: true }
      })
    : [];
  try {
    await prisma.user.updateMany({ where: { id: { in: others.map((row) => row.id) } }, data: { isActive: false } });
    await prisma.studioAccess.updateMany({
      where: { id: { in: otherGrants.map((row) => row.id) } },
      data: { revokedAt: new Date() }
    });
    await work();
  } finally {
    await prisma.user.updateMany({ where: { id: { in: others.map((row) => row.id) } }, data: { isActive: true } });
    await prisma.studioAccess.updateMany({
      where: { id: { in: otherGrants.map((row) => row.id) } },
      data: { revokedAt: null }
    });
  }
}

describe("deleting an account permanently", { skip }, () => {
  after(async () => {
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { actorId: { in: ids } }] } });
    await prisma.revision.deleteMany({ where: { entityId: { startsWith: RUN } } });
    await prisma.contentLock.deleteMany({ where: { entityId: { startsWith: RUN } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.oAuthAccount.deleteMany({ where: { userId: { in: ids } } });
    await prisma.studioAccess.deleteMany({ where: { email: { in: emails } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it("turns an administrator into a tombstone, keeps their content credited, and audits it once", async () => {
    const master = await makeUser("master", "MASTER_ADMIN");
    const target = await makeUser("admin", "ADMINISTRATOR");
    // A second administrator, so the target is never the last one whatever else the database holds.
    await makeUser("admin-two", "ADMINISTRATOR");

    await createSession({ userId: target.id, userAgent: "phone", ipAddress: "203.0.113.5" });
    await createSession({ userId: target.id, userAgent: "laptop", ipAddress: "203.0.113.6" });
    await prisma.oAuthAccount.create({
      data: { provider: "GOOGLE", providerAccountId: `${RUN}-sub`, userId: target.id, email: target.email }
    });
    await prisma.contentLock.create({
      data: { entityType: "Page", entityId: `${RUN}-locked`, userId: target.id, expiresAt: new Date(Date.now() + 60_000) }
    });
    await prisma.studioAccess.create({ data: { email: target.email, kind: "EMAIL", grantedRole: "ADMINISTRATOR" } });
    const revision = await prisma.revision.create({
      data: { entityType: "Page", entityId: `${RUN}-page`, version: 1, data: {}, authorId: target.id },
      select: { id: true }
    });

    const result = await eraseAccount({
      context: contextFor(master),
      actor: master,
      targetId: target.id,
      // Capitals and spaces: the confirmation is compared normalised, as addresses are everywhere else.
      confirmEmail: `  ${target.email.toUpperCase()} `
    });

    assert.equal(result.sessionsEnded, 2);
    assert.equal(result.accessEntriesRemoved, 1);
    assert.equal(result.placeholderName, "Deleted admin");
    assert.ok(result.contentKept >= 1);

    const tomb = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(tomb.email, erasedEmailFor(target.id));
    assert.equal(tomb.name, "Deleted admin");
    assert.equal(tomb.passwordHash, null);
    assert.equal(tomb.twoFactorSecret, null);
    assert.equal(tomb.isActive, false);
    assert.equal(tomb.role, "VIEWER");
    assert.ok(tomb.erasedAt);
    assert.ok(tomb.deletedAt);

    assert.equal(await prisma.session.count({ where: { userId: target.id } }), 0);
    assert.equal(await prisma.oAuthAccount.count({ where: { userId: target.id } }), 0);
    assert.equal(await prisma.contentLock.count({ where: { userId: target.id } }), 0);
    assert.equal(await prisma.studioAccess.count({ where: { email: target.email } }), 0);
    assert.equal(await prisma.user.count({ where: { email: target.email } }), 0, "the address is gone from users");

    // The content is still credited to the same row, now the placeholder.
    const kept = await prisma.revision.findUniqueOrThrow({ where: { id: revision.id }, select: { authorId: true } });
    assert.equal(kept.authorId, target.id);

    const audit = await prisma.auditLog.findMany({ where: { entityType: "User", entityId: target.id, action: "DELETE" } });
    assert.equal(audit.length, 1);
    const row = audit[0]!;
    assert.equal(row.actorId, master.id);
    assert.equal(row.actorEmail, master.email);
    assert.ok(row.entityLabel?.includes(target.email));
    const before = row.before as Record<string, unknown>;
    assert.equal(before.email, target.email);
    assert.equal(before.role, "ADMINISTRATOR");
    assert.equal(JSON.stringify(row.after).includes(target.email), false, "`after` carries nothing personal");
    assert.equal(JSON.stringify(row).includes("not-a-real-hash"), false, "no secret reaches the audit row");

    await assert.rejects(
      eraseAccount({ context: contextFor(master), actor: master, targetId: target.id, confirmEmail: target.email }),
      refusedWith(409)
    );
  });

  it("refuses your own account, anybody but a master administrator, and a mistyped confirmation", async () => {
    const master = await makeUser("self", "MASTER_ADMIN");
    const admin = await makeUser("not-master", "ADMINISTRATOR");
    const editor = await makeUser("editor", "EDITOR");

    await assert.rejects(
      eraseAccount({ context: contextFor(master), actor: master, targetId: master.id, confirmEmail: master.email }),
      refusedWith(403)
    );
    await assert.rejects(
      eraseAccount({ context: contextFor(admin), actor: admin, targetId: editor.id, confirmEmail: editor.email }),
      refusedWith(403)
    );
    await assert.rejects(
      eraseAccount({ context: contextFor(master), actor: master, targetId: editor.id, confirmEmail: admin.email }),
      refusedWith(409)
    );

    const untouched = await prisma.user.findUniqueOrThrow({ where: { id: editor.id }, select: { email: true, erasedAt: true } });
    assert.equal(untouched.email, editor.email);
    assert.equal(untouched.erasedAt, null);
    assert.equal(await prisma.auditLog.count({ where: { entityId: editor.id, action: "DELETE" } }), 0);

    // An editor is "Deleted account", not "Deleted admin".
    const done = await eraseAccount({
      context: contextFor(master),
      actor: master,
      targetId: editor.id,
      confirmEmail: editor.email
    });
    assert.equal(done.placeholderName, "Deleted account");
  });

  it("never deletes the last active master administrator", async () => {
    const last = await makeUser("last-master", "MASTER_ADMIN");
    // An actor who passes the predicate but is not counted — the only way the last one can be targeted.
    const operator = { id: `${RUN}-operator`, role: "MASTER_ADMIN" as const };

    await aloneAsMaster([last.id], async () => {
      await assert.rejects(
        eraseAccount({ context: { actor: null }, actor: operator, targetId: last.id, confirmEmail: last.email }),
        refusedWith(409, LAST_MASTER_ADMIN_ERASE)
      );
    });

    const still = await prisma.user.findUniqueOrThrow({ where: { id: last.id }, select: { erasedAt: true, isActive: true } });
    assert.equal(still.erasedAt, null);
    assert.equal(still.isActive, true);
  });

  it("never removes the last master-administrator entry from the access list", async () => {
    const actor = await makeUser("grant-actor", "MASTER_ADMIN");
    const holder = await makeUser("grant-holder", "MASTER_ADMIN");
    await prisma.studioAccess.create({ data: { email: holder.email, kind: "EMAIL", grantedRole: "MASTER_ADMIN" } });

    await aloneAsMaster(
      [actor.id, holder.id],
      async () => {
        await assert.rejects(
          eraseAccount({ context: contextFor(actor), actor, targetId: holder.id, confirmEmail: holder.email }),
          refusedWith(409, LAST_MASTER_GRANT_ERASE)
        );
      },
      true
    );

    // Refused inside the transaction, so nothing at all was written.
    const still = await prisma.user.findUniqueOrThrow({ where: { id: holder.id }, select: { email: true } });
    assert.equal(still.email, holder.email);
    assert.equal(await prisma.studioAccess.count({ where: { email: holder.email } }), 1);
    assert.equal(await prisma.auditLog.count({ where: { entityId: holder.id, action: "DELETE" } }), 0);
  });
});
