import "../newsletter/setup";

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { auditRowData, writeAudit, type AuditContext, type TxClient } from "@/lib/audit";
import { DELETED_ACTOR_LABEL } from "@/lib/audit-actor";
import { hashAuditEmail } from "@/lib/audit-ip";
import { accountLabel, attemptedAddress, attemptedFromPayload, recogniseAttemptedAddresses } from "@/lib/audit-subject";

/**
 * Rows ABOUT an account — every sign-in, sign-out and refusal, and every `User` change — carry the email
 * address again (owner decision, 2026-10-10 — docs/AUDIT-PRIVACY.md), exactly as they did before commit
 * 4675432: the account's address as the label of a sign-in or sign-out, `Name <address>` on a `User`
 * row, and the TYPED address in the label and in `after.email` of a refused sign-in (beside its keyed
 * fingerprint and domain, which group refusals across the fingerprint-only rows of 2026-10-10).
 */

const EMAIL = "asha.rao@cxa.example.org";
const context: AuditContext = { actor: { id: "user_1", email: EMAIL }, ipAddress: "198.51.100.7" };

describe("an account row as inserted", () => {
  it("a sign-in keeps the actor's address as its label, and records email and IP", () => {
    // Exactly what app/api/auth/login/route.ts passes.
    const row = auditRowData(context, {
      action: "LOGIN",
      entityType: "User",
      entityId: "user_1",
      entityLabel: EMAIL,
      after: { method: "password", provider: "PASSWORD" }
    });
    assert.equal(row.entityLabel, EMAIL);
    assert.equal(row.entityId, "user_1");
    assert.equal(row.actorEmail, EMAIL);
    assert.equal(row.ipAddress, "198.51.100.7");
  });

  it("a sign-out keeps it too", () => {
    const row = auditRowData(context, { action: "LOGOUT", entityType: "User", entityId: "user_1", entityLabel: EMAIL });
    assert.equal(row.entityLabel, EMAIL);
    assert.equal(row.actorEmail, EMAIL);
  });

  it("a refused sign-in keeps the typed address, with its fingerprint and domain beside it", () => {
    const typed = "Someone.Else@Partner.example.com";
    // The shape the auth routes pass: `{ email, ...attemptedAddress(email), reason }`.
    const row = auditRowData(
      { actor: null, ipAddress: "203.0.113.9" },
      {
        action: "LOGIN_FAILED",
        entityType: "User",
        entityLabel: typed,
        after: { email: typed, ...attemptedAddress(typed), reason: "invalid" }
      }
    );
    assert.equal(row.entityLabel, typed);
    assert.equal(row.ipAddress, "203.0.113.9");
    assert.equal(row.actorEmail, null, "a refused sign-in has no actor");
    const after = row.after as Record<string, unknown>;
    assert.equal(after.email, typed);
    assert.equal(after.emailHash, hashAuditEmail(typed));
    assert.equal(after.emailDomain, "partner.example.com");
    assert.equal(after.reason, "invalid");
  });

  it("a User change keeps `Name <address>` and the addresses in its payloads, unchanged", async () => {
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
    assert.equal(row.entityLabel, `Asha Rao <${EMAIL}>`);
    assert.deepEqual(row.before, { email: EMAIL });
    assert.deepEqual(row.after, { id: "user_1", email: "asha@new.example.org", linkedAddress: "a.rao@gmail.example.com" });
  });

  it("leaves rows that are not about an account as they were — a grant's label IS the address", () => {
    const row = auditRowData(context, {
      action: "PERMISSION_CHANGE",
      entityType: "StudioAccess",
      entityLabel: "new.colleague@cxa.example.org",
      after: { email: "new.colleague@cxa.example.org" }
    });
    assert.equal(row.entityLabel, "new.colleague@cxa.example.org");
    assert.deepEqual(row.after, { email: "new.colleague@cxa.example.org" });
  });
});

describe("naming the account a row is about", () => {
  const signIn = { action: "LOGIN" as const, entityType: "User", entityId: "user_1", entityLabel: EMAIL };

  it("shows the address the row recorded — the account as it was at the time", () => {
    assert.equal(accountLabel(signIn, { name: "Asha Rao", email: "asha@new.example.org" }), EMAIL);
    assert.equal(accountLabel(signIn, null), EMAIL, "still named after a hard delete");
  });

  it("shows a refused sign-in's typed address", () => {
    const refused = {
      action: "LOGIN_FAILED" as const,
      entityType: "User",
      entityId: null,
      entityLabel: null,
      after: { email: "x@partner.example.com", ...attemptedAddress("x@partner.example.com"), reason: "invalid" }
    };
    assert.equal(accountLabel(refused, null), "x@partner.example.com");
    assert.equal(attemptedFromPayload(refused.after).email, "x@partner.example.com");
  });

  it("names a fingerprint-only row (2026-10-10) through the join, or gracefully without one", () => {
    const hashOnly = { ...signIn, entityLabel: null };
    assert.equal(accountLabel(hashOnly, { name: "Asha Rao", email: EMAIL }), `Asha Rao <${EMAIL}>`);
    assert.equal(accountLabel(hashOnly, null), DELETED_ACTOR_LABEL);
    const refused = {
      action: "LOGIN_FAILED" as const,
      entityType: "User",
      entityId: null,
      entityLabel: null,
      after: { ...attemptedAddress("x@partner.example.com"), reason: "invalid" }
    };
    assert.equal(accountLabel(refused, null), "••••@partner.example.com");
  });

  it("recognises a fingerprint-only typed address that belongs to an account, across a key rotation", () => {
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
   * Every account row written under app/api/auth names the address again, as before 2026-10-10: the
   * routes are read as source (comments stripped) and each is checked for the label and payload shapes
   * that put the address on the row.
   */
  const root = path.join(process.cwd(), "app", "api", "auth");
  function source(relative: string): string {
    return readFileSync(path.join(root, relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }
  function count(text: string, pattern: RegExp): number {
    return (text.match(pattern) ?? []).length;
  }

  it("the walk finds the auth routes", () => {
    const files: string[] = [];
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) files.push(full);
      }
    })(root);
    assert.ok(files.length >= 5);
  });

  it("password sign-in: every refusal records the typed address, and a sign-in labels the account", () => {
    const login = source("login/route.ts");
    assert.equal(count(login, /entityLabel:\s*email\b/g), 2, "both refusals for a typed address");
    assert.equal(count(login, /entityLabel:\s*user\.email\b/g), 2, "the access refusal and the sign-in");
    assert.equal(count(login, /after:\s*\{\s*email,\s*\.\.\.attemptedAddress\(email\)/g), 2);
    assert.match(login, /email:\s*user\.email,\s*\.\.\.attemptedAddress\(user\.email\)/);
  });

  it("sign-out labels the account with its address", () => {
    assert.match(source("logout/route.ts"), /entityLabel:\s*claims\?\.email\s*\?\?\s*null/);
  });

  it("OAuth: refusals record the typed address, account changes `Name <address>`, the sign-in the address", () => {
    const oauth = source(path.join("oauth", "[provider]", "callback", "route.ts"));
    assert.equal(count(oauth, /entityLabel:\s*email\b/g), 3);
    assert.equal(count(oauth, /\bemail,\s*\.\.\.attemptedAddress\(email\)/g), 3);
    assert.match(oauth, /entityLabel:\s*`\$\{existingUser\.name\} <\$\{existingUser\.email\}>`/);
    assert.match(oauth, /entityLabel:\s*`\$\{name\} <\$\{email\}>`/);
    assert.match(oauth, /entityLabel:\s*signedIn\.email/);
  });

  it("set-password and two-factor label the account with its address", () => {
    assert.equal(count(source("set-password/route.ts"), /entityLabel:\s*user\.email\b/g), 3);
    assert.equal(count(source("two-factor/route.ts"), /entityLabel:\s*user\.email\b/g), 2);
  });
});
