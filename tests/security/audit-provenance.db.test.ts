import { hasDatabase } from "../newsletter/setup";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { recordEvent } from "@/lib/audit";
import { displayIpFingerprint, hashAuditIp } from "@/lib/audit-ip";
import { prisma } from "@/lib/db";
import { actorProvenance, installationProvenance, resolveRange } from "@/lib/provenance";

/**
 * The provenance screens against a real PostgreSQL, across the change that stopped the audit log storing
 * raw addresses: rows written before it (raw `ipAddress`, no `ipHash`) must still be counted in the
 * "where from" aggregates, and rows written since must carry no address at all.
 *
 * ⚠ THESE TESTS WRITE audit_logs AND users ROWS (and remove only their own), so they refuse to run against
 * anything but a database on this machine — the same rule as tests/newsletter/outbox.db.test.ts.
 */

const LOCAL = /@(127\.0\.0\.1|localhost|\[::1\]|postgres)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
const skip = !hasDatabase ? "no DATABASE_URL" : !LOCAL ? "DATABASE_URL is not a local database" : false;

const RUN = `prov-${Date.now()}`;
const LEGACY_IP = "192.0.2.44";
const NEW_IP = "198.51.100.23";
const EMAIL = `${RUN}@cxa.example.org`;
let userId = "";

describe("provenance across the audit-privacy change", { skip }, () => {
  before(async () => {
    const user = await prisma.user.create({ data: { email: EMAIL, name: "Provenance Test", role: "EDITOR" } });
    userId = user.id;

    // Pre-migration rows: what the old code wrote — the raw address and the actor's address, no hash.
    for (let index = 0; index < 3; index += 1) {
      await prisma.auditLog.create({
        data: {
          action: "LOGIN_FAILED",
          entityType: "User",
          entityId: userId,
          entityLabel: EMAIL,
          ipAddress: LEGACY_IP,
          after: { email: EMAIL, reason: "invalid" }
        }
      });
    }
    await prisma.auditLog.create({
      data: { action: "LOGIN", entityType: "User", entityId: userId, actorId: userId, actorEmail: EMAIL, ipAddress: LEGACY_IP }
    });

    // Rows written now, through the real writer.
    await recordEvent(
      { actor: null, ipAddress: NEW_IP },
      { action: "LOGIN_FAILED", entityType: "User", entityId: userId, entityLabel: EMAIL, after: { email: EMAIL, reason: "invalid" } }
    );
    await recordEvent(
      { actor: { id: userId, email: EMAIL }, ipAddress: NEW_IP },
      { action: "LOGIN", entityType: "User", entityId: userId, entityLabel: EMAIL }
    );
  });

  after(async () => {
    await prisma.auditLog.deleteMany({ where: { entityType: "User", entityId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("writes new rows with no address in any column", async () => {
    const rows = await prisma.auditLog.findMany({ where: { entityId: userId, ipHash: { not: null } } });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.actorEmail, null);
      assert.equal(row.ipAddress, null);
      assert.equal(row.ipHash, hashAuditIp(NEW_IP));
      assert.ok(!JSON.stringify(row).includes(EMAIL), JSON.stringify(row));
    }
  });

  it("still counts pre-migration rows in 'the addresses they worked from'", async () => {
    const result = await actorProvenance(userId, resolveRange(null, null));
    const byAddress = new Map(result.addresses.items.map((row) => [row.address, row.count]));
    assert.equal(byAddress.get(LEGACY_IP), 4, "the legacy rows are grouped on their raw column");
    assert.equal(byAddress.get(displayIpFingerprint(hashAuditIp(NEW_IP)) ?? ""), 2);
  });

  it("still counts pre-migration refusals in 'where the refusals came from', and recognises both", async () => {
    const result = await installationProvenance(resolveRange(null, null));
    const sources = new Map(result.refusalSources.items.map((row) => [row.address, row.count]));
    assert.equal(sources.get(LEGACY_IP), 3);
    assert.equal(sources.get(displayIpFingerprint(hashAuditIp(NEW_IP)) ?? ""), 1);

    const mine = result.refusals.items.filter((row) => row.address === EMAIL);
    assert.equal(mine.length, 4, "every refusal for the account is recognised and named, old and new");
    assert.ok(mine.every((row) => row.addressKnown));
  });
});
