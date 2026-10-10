import { hasDatabase } from "../newsletter/setup";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { recordEvent } from "@/lib/audit";
import { auditTextSearch } from "@/lib/audit-accounts";
import { displayIpFingerprint, hashAuditIp } from "@/lib/audit-ip";
import { prisma } from "@/lib/db";
import { actorProvenance, installationProvenance, resolveRange } from "@/lib/provenance";

/**
 * The provenance screens and the audit search against a real PostgreSQL, with the real email and IP
 * address stored again (owner decision, 2026-10-10 — docs/AUDIT-PRIVACY.md). Three kinds of row:
 *
 *   • legacy rows (before 2026-10-10): raw `ipAddress` and `actorEmail`, no `ipHash`;
 *   • fingerprint-only rows (2026-10-10, between the deploy and the reversal): `ipHash`, no address;
 *   • rows written now, through the real writer: the address AND the fingerprint.
 *
 * ⚠ THESE TESTS WRITE audit_logs AND users ROWS (and remove only their own), so they refuse to run against
 * anything but a database on this machine — the same rule as tests/newsletter/outbox.db.test.ts.
 */

const LOCAL = /@(127\.0\.0\.1|localhost|\[::1\]|postgres)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
const skip = !hasDatabase ? "no DATABASE_URL" : !LOCAL ? "DATABASE_URL is not a local database" : false;

const RUN = `prov-${Date.now()}`;
const LEGACY_IP = "192.0.2.44";
const NEW_IP = "198.51.100.23";
const HASH_ONLY_IP = "203.0.113.77";
const EMAIL = `${RUN}@cxa.example.org`;
let userId = "";

describe("provenance and search with real addresses stored", { skip }, () => {
  before(async () => {
    const user = await prisma.user.create({ data: { email: EMAIL, name: "Provenance Test", role: "EDITOR" } });
    userId = user.id;

    // Legacy rows: the raw address and the actor's address, no hash.
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

    // A fingerprint-only row, as written on 2026-10-10 before the reversal.
    await prisma.auditLog.create({
      data: { action: "LOGIN", entityType: "User", entityId: userId, actorId: userId, ipHash: hashAuditIp(HASH_ONLY_IP) }
    });

    // Rows written now, through the real writer, in the shape the auth routes pass.
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

  it("writes new rows with the real IP, its fingerprint, and the actor's real email", async () => {
    const rows = await prisma.auditLog.findMany({ where: { entityId: userId, ipAddress: NEW_IP } });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.ipHash, hashAuditIp(NEW_IP));
      assert.equal(row.entityLabel, EMAIL);
    }
    const signIn = rows.find((row) => row.action === "LOGIN");
    assert.equal(signIn?.actorEmail, EMAIL);
    assert.equal(signIn?.actorId, userId);
  });

  it("lists 'the addresses they worked from' by real IP, keeping fingerprint-only rows", async () => {
    const result = await actorProvenance(userId, resolveRange(null, null));
    const byAddress = new Map(result.addresses.items.map((row) => [row.address, row.count]));
    assert.equal(byAddress.get(LEGACY_IP), 4);
    assert.equal(byAddress.get(NEW_IP), 2);
    assert.equal(byAddress.get(displayIpFingerprint(hashAuditIp(HASH_ONLY_IP)) ?? ""), 1, "not dropped");
    assert.equal(byAddress.has(displayIpFingerprint(hashAuditIp(NEW_IP)) ?? ""), false, "a row with an address is grouped by it");

    const shown = new Set(result.signIns.items.map((event) => event.ipAddress));
    assert.ok(shown.has(NEW_IP) && shown.has(LEGACY_IP), JSON.stringify([...shown]));
    assert.ok(shown.has(null), "the fingerprint-only sign-in shows no address");
  });

  it("shows the real IP of each refusal and of each source, and recognises the typed address", async () => {
    const result = await installationProvenance(resolveRange(null, null));
    const sources = new Map(result.refusalSources.items.map((row) => [row.address, row.count]));
    assert.equal(sources.get(LEGACY_IP), 3);
    assert.equal(sources.get(NEW_IP), 1);

    const mine = result.refusals.items.filter((row) => row.address === EMAIL);
    assert.equal(mine.length, 4, "every refusal for the account is recognised and named, old and new");
    assert.ok(mine.every((row) => row.addressKnown));
    assert.deepEqual(new Set(mine.map((row) => row.ipAddress)), new Set([LEGACY_IP, NEW_IP]));
  });

  it("filters refusals by an exact IP address", async () => {
    const result = await installationProvenance(resolveRange(null, null), { addressFilter: NEW_IP });
    const mine = result.refusals.items.filter((row) => row.address === EMAIL);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.ipAddress, NEW_IP);
  });

  it("the audit search finds rows by exact IP — including fingerprint-only rows — and by actor email", async () => {
    const mineOnly = { entityId: userId };
    const byNewIp = await prisma.auditLog.findMany({ where: { AND: [mineOnly, { OR: await auditTextSearch(NEW_IP) }] } });
    assert.equal(byNewIp.length, 2);
    const byHashOnlyIp = await prisma.auditLog.findMany({ where: { AND: [mineOnly, { OR: await auditTextSearch(HASH_ONLY_IP) }] } });
    assert.equal(byHashOnlyIp.length, 1);
    assert.equal(byHashOnlyIp[0]?.ipAddress, null);

    const byActor = await prisma.auditLog.findMany({
      where: { AND: [mineOnly, { action: "LOGIN" }, { OR: await auditTextSearch(EMAIL.toUpperCase()) }] }
    });
    assert.equal(byActor.length, 3, "legacy, fingerprint-only (through the join) and new sign-ins");
  });
});
