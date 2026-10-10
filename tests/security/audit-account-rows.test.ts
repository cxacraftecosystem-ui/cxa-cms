import "../newsletter/setup";

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { auditRowData, writeAudit, type AuditContext, type TxClient } from "@/lib/audit";
import { DELETED_ACTOR_LABEL } from "@/lib/audit-actor";
import { hashAuditEmail } from "@/lib/audit-ip";
import {
  accountLabel,
  attemptedAddress,
  recogniseAttemptedAddresses,
  scrubAccountIdentity
} from "@/lib/audit-subject";

/**
 * Rows ABOUT an account — every sign-in, sign-out and refusal, and every `User` change — carry no email
 * address in any column. Dropping `actorEmail` was not enough: each sign-in wrote the actor's own address
 * again as `entityLabel`, and each refusal wrote the typed one into `entityLabel` and `after.email`.
 */

const EMAIL = "asha.rao@cxa.example.org";
const context: AuditContext = { actor: { id: "user_1", email: EMAIL }, ipAddress: "198.51.100.7" };

/** A real address anywhere in the row. `••••@domain` is not one: it has no local part. */
function hasAddress(row: unknown): boolean {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]/i.test(JSON.stringify(row));
}

describe("an account row as inserted", () => {
  it("a sign-in no longer repeats the actor's address as its label", () => {
    // Exactly what app/api/auth/login/route.ts used to pass.
    const row = auditRowData(context, {
      action: "LOGIN",
      entityType: "User",
      entityId: "user_1",
      entityLabel: EMAIL,
      after: { method: "password", provider: "PASSWORD" }
    });
    assert.equal(row.entityLabel, null);
    assert.equal(row.entityId, "user_1", "the account is named by id and joined at read time");
    assert.ok(!hasAddress(row), JSON.stringify(row));
  });

  it("a sign-out no longer repeats it either", () => {
    const row = auditRowData(context, { action: "LOGOUT", entityType: "User", entityId: "user_1", entityLabel: EMAIL });
    assert.equal(row.entityLabel, null);
    assert.ok(!hasAddress(row));
  });

  it("a refused sign-in keeps a fingerprint and the domain of the typed address, never the address", () => {
    const typed = "Someone.Else@Partner.example.com";
    const row = auditRowData(
      { actor: null, ipAddress: "203.0.113.9" },
      { action: "LOGIN_FAILED", entityType: "User", entityLabel: typed, after: { email: typed, reason: "invalid" } }
    );
    assert.equal(row.entityLabel, null);
    const after = row.after as Record<string, unknown>;
    assert.equal(after.email, undefined);
    assert.equal(after.emailHash, hashAuditEmail(typed));
    assert.equal(after.emailDomain, "partner.example.com");
    assert.equal(after.reason, "invalid");
    assert.ok(!hasAddress(row));
  });

  it("a User change keeps the name, and an address change still shows as a change", async () => {
    const inserts: Record<string, unknown>[] = [];
    const tx = {
      auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => void inserts.push(data) }
    } as unknown as TxClient;
    await writeAudit(tx, context, {
      action: "UPDATE",
      entityType: "User",
      entityId: "user_1",
      entityLabel: `Asha Rao <${EMAIL}>`,
      before: { email: EMAIL },
      after: { id: "user_1", email: "asha@new.example.org", linkedAddress: "a.rao@gmail.example.com" }
    });
    const row = inserts[0] ?? {};
    assert.equal(row.entityLabel, "Asha Rao");
    assert.ok(!hasAddress(row), JSON.stringify(row));
    const before = row.before as Record<string, string>;
    const after = row.after as Record<string, string>;
    assert.match(before.email ?? "", /^••••@cxa\.example\.org #[0-9a-f]{12}$/);
    assert.notEqual(before.email, after.email, "the diff still sees that the address changed");
  });

  it("leaves rows that are not about an account alone — a grant's label IS the address on the list", () => {
    const input = {
      action: "PERMISSION_CHANGE" as const,
      entityType: "StudioAccess",
      entityLabel: "new.colleague@cxa.example.org",
      after: { email: "new.colleague@cxa.example.org" }
    };
    assert.deepEqual(scrubAccountIdentity(input), input);
  });
});

describe("naming the account a row is about", () => {
  const signIn = { action: "LOGIN" as const, entityType: "User", entityId: "user_1", entityLabel: null };

  it("joins the account, and says 'Deleted user' once it is gone", () => {
    assert.equal(accountLabel(signIn, { name: "Asha Rao", email: EMAIL }), `Asha Rao <${EMAIL}>`);
    assert.equal(accountLabel(signIn, null), DELETED_ACTOR_LABEL);
  });

  it("shows an unrecognised typed address masked to its domain", () => {
    const refused = {
      action: "LOGIN_FAILED" as const,
      entityType: "User",
      entityId: null,
      entityLabel: null,
      after: { ...attemptedAddress("x@partner.example.com"), reason: "invalid" }
    };
    assert.equal(accountLabel(refused, null), "••••@partner.example.com");
  });

  it("still reads a pre-migration row by its legacy label", () => {
    assert.equal(accountLabel({ ...signIn, entityLabel: "old@cxa.example.org" }, null), "old@cxa.example.org");
  });

  it("recognises a typed address that belongs to an account or a grant, across a key rotation", () => {
    const KEY_A = "audit-ip-key-A-0123456789abcdefghijklmnop";
    const KEY_B = "audit-ip-key-B-0123456789abcdefghijklmnop";
    const stored = attemptedAddress(EMAIL, { AUDIT_IP_HASH_SECRET: KEY_A }).emailHash ?? "";
    const map = recogniseAttemptedAddresses([EMAIL.toUpperCase(), "other@cxa.example.org"], {
      AUDIT_IP_HASH_SECRET: KEY_B,
      AUDIT_IP_HASH_PREVIOUS_SECRETS: KEY_A
    });
    assert.equal(map.get(stored), EMAIL);
    assert.equal(map.get(attemptedAddress("stranger@cxa.example.org", { AUDIT_IP_HASH_SECRET: KEY_A }).emailHash ?? ""), undefined);
  });
});

describe("the sign-in routes", () => {
  /**
   * The scrub is the backstop; the routes themselves must not pass an address either, or the rule
   * depends on a helper nobody remembers. Every `recordEvent` / `mutateWithHistory` call under
   * app/api/auth is checked for an `entityLabel` built from an address and for a raw `email` in a payload.
   */
  const root = path.join(process.cwd(), "app", "api", "auth");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) files.push(full);
    }
  })(root);

  it("pass no address into an audit row", () => {
    const offences: string[] = [];
    for (const file of files) {
      // Comments stripped, so a sentence that mentions the old shape is not an offence.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const name = path.relative(root, file);
      if (/entityLabel:\s*[^,\n]*\bemail\b/i.test(source)) offences.push(`${name}: entityLabel from an address`);
      if (/after:\s*\{[^}]*\bemail(?:\s*[,}]|:\s)/.test(source)) offences.push(`${name}: a raw email in after`);
    }
    assert.ok(files.length >= 5, "the walk found the auth routes");
    assert.deepEqual(offences, []);
  });
});
