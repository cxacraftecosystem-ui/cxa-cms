import "../newsletter/setup";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { writeAudit, type AuditContext, type TxClient } from "@/lib/audit";
import { DELETED_ACTOR_LABEL, auditActorEmail, auditActorEmailSearch, auditActorLabel, auditActorName } from "@/lib/audit-actor";
import {
  auditIpHashCandidates,
  auditIpSearchClauses,
  displayIpFingerprint,
  fingerprintSearchHex,
  hashAuditIp
} from "@/lib/audit-ip";

/**
 * Owner decision, 2026-10-10 (docs/AUDIT-PRIVACY.md): an audit row stores the actor's real email
 * address and the real client IP address — the IP as derived by lib/request-ip.ts, in canonical form —
 * BESIDE `actorId` and the keyed fingerprint `ipHash`, which are still written.
 */

const KEY_A = "audit-ip-key-A-0123456789abcdefghijklmnop";
const KEY_B = "audit-ip-key-B-0123456789abcdefghijklmnop";
const IP = "198.51.100.7";
const saved = process.env.AUDIT_IP_HASH_SECRET;

/** A transaction client that records what would have been inserted. */
function recordingTx() {
  const inserts: Record<string, unknown>[] = [];
  const tx = {
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        inserts.push(data);
        return data;
      }
    }
  } as unknown as TxClient;
  return { tx, inserts };
}

describe("the audit row", () => {
  afterEach(() => {
    if (saved === undefined) delete process.env.AUDIT_IP_HASH_SECRET;
    else process.env.AUDIT_IP_HASH_SECRET = saved;
  });

  it("stores the actor's id AND email, and the client IP AND its fingerprint", async () => {
    process.env.AUDIT_IP_HASH_SECRET = KEY_A;
    const { tx, inserts } = recordingTx();
    const context: AuditContext = {
      actor: { id: "user_123", email: "editor@cxa.example.org" },
      ipAddress: IP,
      userAgent: "test-agent"
    };

    await writeAudit(tx, context, { action: "UPDATE", entityType: "Page", entityId: "page_1" });

    assert.equal(inserts.length, 1);
    const row = inserts[0] ?? {};
    assert.equal(row.actorId, "user_123");
    assert.equal(row.actorEmail, "editor@cxa.example.org", "the actor's address at the time is recorded");
    assert.equal(row.ipAddress, IP, "the real client address is recorded");
    assert.equal(row.ipHash, hashAuditIp(IP, { AUDIT_IP_HASH_SECRET: KEY_A }), "the fingerprint is still written");
  });

  it("stores the address in its canonical spelling, the one the fingerprint is computed from", async () => {
    const { tx, inserts } = recordingTx();
    await writeAudit(tx, { actor: null, ipAddress: `::ffff:${IP}` }, { action: "LOGIN_FAILED", entityType: "User" });
    await writeAudit(tx, { actor: null, ipAddress: "2001:DB8:0:0::1" }, { action: "LOGIN_FAILED", entityType: "User" });
    assert.equal(inserts[0]?.ipAddress, IP);
    assert.equal(inserts[0]?.ipHash, hashAuditIp(IP));
    assert.equal(inserts[1]?.ipAddress, "2001:db8::1");
  });

  it("writes no address and no fingerprint when there is no trusted address", async () => {
    const { tx, inserts } = recordingTx();
    await writeAudit(tx, { actor: null, ipAddress: null }, { action: "LOGIN_FAILED", entityType: "User" });
    await writeAudit(tx, { actor: null, ipAddress: "not-an-ip" }, { action: "LOGIN_FAILED", entityType: "User" });
    for (const row of inserts) {
      assert.equal(row.ipAddress, null);
      assert.equal(row.ipHash, null);
      assert.equal(row.actorId, null);
      assert.equal(row.actorEmail, null);
    }
  });
});

describe("the IP fingerprint", () => {
  it("is a keyed, truncated HMAC with a key id, and equal for equal addresses", () => {
    const env = { AUDIT_IP_HASH_SECRET: KEY_A };
    const hash = hashAuditIp(IP, env);
    assert.match(hash ?? "", /^[0-9a-f]{8}:[0-9a-f]{32}$/);
    assert.equal(hashAuditIp(IP, env), hash);
    assert.equal(hashAuditIp(`::ffff:${IP}`, env), hash, "an IPv4-mapped address is the same visitor");
    assert.notEqual(hashAuditIp("198.51.100.8", env), hash);
  });

  it("depends on the secret, so it cannot be reversed by hashing the address space without it", () => {
    assert.notEqual(hashAuditIp(IP, { AUDIT_IP_HASH_SECRET: KEY_A }), hashAuditIp(IP, { AUDIT_IP_HASH_SECRET: KEY_B }));
  });

  it("derives a key from JWT_SECRET when none is set, and ignores one too short to be a key", () => {
    const jwt = { JWT_SECRET: "jwt-secret-for-the-test-0123456789abcdef" };
    const derived = hashAuditIp(IP, jwt);
    assert.ok(derived);
    assert.equal(hashAuditIp(IP, { ...jwt, AUDIT_IP_HASH_SECRET: "short" }), derived);
    assert.equal(hashAuditIp(IP, {}), null, "no key at all stores nothing rather than the address");
  });

  it("finds rows hashed under a previous key after a rotation", () => {
    const old = hashAuditIp(IP, { AUDIT_IP_HASH_SECRET: KEY_A });
    const candidates = auditIpHashCandidates(IP, {
      AUDIT_IP_HASH_SECRET: KEY_B,
      AUDIT_IP_HASH_PREVIOUS_SECRETS: KEY_A
    });
    assert.equal(candidates.length, 2);
    assert.ok(old && candidates.includes(old));
    assert.notEqual(old?.split(":")[0], candidates[0]?.split(":")[0], "the key id shows the rotation");
  });

  it("still finds rows hashed under the DERIVED key after a dedicated secret is set, with no other setting", () => {
    const jwt = "jwt-secret-for-the-test-0123456789abcdef";
    const underDerived = hashAuditIp(IP, { JWT_SECRET: jwt });
    const candidates = auditIpHashCandidates(IP, { JWT_SECRET: jwt, AUDIT_IP_HASH_SECRET: KEY_A });
    assert.equal(candidates[0], hashAuditIp(IP, { JWT_SECRET: jwt, AUDIT_IP_HASH_SECRET: KEY_A }), "current key first");
    assert.ok(underDerived && candidates.includes(underDerived), "the derived key is searched automatically");
  });

  it("finds rows hashed under a key derived from a RETIRED JWT_SECRET, named as jwt:<old secret>", () => {
    const oldJwt = "old-jwt-secret-for-the-test-0123456789abcdef";
    const newJwt = "new-jwt-secret-for-the-test-0123456789abcdef";
    const underOld = hashAuditIp(IP, { JWT_SECRET: oldJwt });
    assert.ok(underOld);
    assert.ok(!auditIpHashCandidates(IP, { JWT_SECRET: newJwt }).includes(underOld), "lost without the setting");
    const withPrevious = auditIpHashCandidates(IP, {
      JWT_SECRET: newJwt,
      AUDIT_IP_HASH_PREVIOUS_SECRETS: `jwt:${oldJwt}`
    });
    assert.ok(withPrevious.includes(underOld));
    // Also after moving to a dedicated secret in the same change.
    assert.ok(
      auditIpHashCandidates(IP, {
        JWT_SECRET: newJwt,
        AUDIT_IP_HASH_SECRET: KEY_B,
        AUDIT_IP_HASH_PREVIOUS_SECRETS: ` ${KEY_A} , jwt:${oldJwt}, too-short, jwt:`
      }).includes(underOld)
    );
  });

  it("never WRITES under a previous key", () => {
    const env = { JWT_SECRET: "jwt-secret-for-the-test-0123456789abcdef", AUDIT_IP_HASH_SECRET: KEY_B, AUDIT_IP_HASH_PREVIOUS_SECRETS: KEY_A };
    assert.equal(hashAuditIp(IP, env), hashAuditIp(IP, { AUDIT_IP_HASH_SECRET: KEY_B }));
  });

  it("is displayed and searched as net·<hex>", () => {
    const hex = (hashAuditIp(IP, { AUDIT_IP_HASH_SECRET: KEY_A }) ?? "").split(":")[1] ?? "";
    const shown = displayIpFingerprint(`k:${hex}`) ?? "";
    assert.equal(shown, `net·${hex.slice(0, 12)}`);
    assert.equal(fingerprintSearchHex(shown), hex.slice(0, 12));
    assert.equal(fingerprintSearchHex("198.51"), null);
  });
});

describe("searching by IP address", () => {
  it("matches the stored address exactly, and fingerprint-only rows through every search key", () => {
    const env = { AUDIT_IP_HASH_SECRET: KEY_B, AUDIT_IP_HASH_PREVIOUS_SECRETS: KEY_A };
    const clauses = auditIpSearchClauses(` ${IP} `, env);
    assert.deepEqual(clauses[0], { ipAddress: IP });
    const hashClause = clauses.find((clause) => "ipHash" in clause) as { ipHash: { in: string[] } } | undefined;
    assert.ok(hashClause);
    assert.ok(hashClause.ipHash.in.includes(hashAuditIp(IP, { AUDIT_IP_HASH_SECRET: KEY_A }) ?? ""));
    assert.ok(hashClause.ipHash.in.includes(hashAuditIp(IP, { AUDIT_IP_HASH_SECRET: KEY_B }) ?? ""));
  });

  it("finds a spelling variant under the canonical address, and searches nothing for a non-address", () => {
    assert.deepEqual(auditIpSearchClauses("2001:DB8::1", { AUDIT_IP_HASH_SECRET: KEY_A }).slice(0, 2), [
      { ipAddress: "2001:db8::1" },
      { ipAddress: "2001:DB8::1" }
    ]);
    assert.deepEqual(auditIpSearchClauses("198.51", { AUDIT_IP_HASH_SECRET: KEY_A }), []);
    assert.deepEqual(auditIpSearchClauses("asha@cxa.example.org", { AUDIT_IP_HASH_SECRET: KEY_A }), []);
  });
});

describe("naming the actor", () => {
  it("prefers the recorded email, and still names an account that has been hard-deleted", () => {
    assert.equal(auditActorName({ actor: { name: "Asha", email: "asha@new.example.org" }, actorEmail: "asha@cxa.example.org" }), "Asha");
    assert.equal(
      auditActorEmail({ actor: { name: "Asha", email: "asha@new.example.org" }, actorEmail: "asha@cxa.example.org" }),
      "asha@cxa.example.org",
      "the address at the time, not today's"
    );
    assert.equal(auditActorName({ actor: null, actorEmail: "gone@cxa.example.org" }), "gone@cxa.example.org");
    assert.equal(auditActorName({ actor: null, actorEmail: "gone@cxa.example.org" }, "Somebody"), "gone@cxa.example.org");
  });

  it("shows name and email together on the audit screen", () => {
    assert.equal(
      auditActorLabel({ actor: { name: "Asha Rao", email: "asha@cxa.example.org" }, actorEmail: "asha@cxa.example.org" }),
      "Asha Rao <asha@cxa.example.org>"
    );
    assert.equal(auditActorLabel({ actor: null, actorEmail: "gone@cxa.example.org" }), "gone@cxa.example.org");
  });

  it("falls back to the joined address on a fingerprint-only row, and says 'Deleted user' only with neither", () => {
    assert.equal(auditActorEmail({ actor: { name: "Asha", email: "asha@cxa.example.org" }, actorEmail: null }), "asha@cxa.example.org");
    assert.equal(auditActorName({ actor: null, actorEmail: null }), DELETED_ACTOR_LABEL);
    assert.equal(auditActorLabel({ actor: null, actorEmail: null }), DELETED_ACTOR_LABEL);
    assert.equal(DELETED_ACTOR_LABEL, "Deleted user");
  });

  it("searches the recorded email column first, and the join for rows without one", () => {
    assert.deepEqual(auditActorEmailSearch("asha"), [
      { actorEmail: { contains: "asha", mode: "insensitive" } },
      { actor: { is: { email: { contains: "asha", mode: "insensitive" } } } }
    ]);
  });
});
