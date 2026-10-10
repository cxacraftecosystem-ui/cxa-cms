import { hasDatabase } from "../newsletter/setup";

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";

import { NextRequest } from "next/server";

import { ApiError } from "@/lib/api";
import { setAuthMailer } from "@/lib/auth/auth-mail";
import { RESET_TTL_HOURS, verifyCredentialToken } from "@/lib/auth/credential-token";
import { hashPassword } from "@/lib/auth/password";
import {
  FORGOT_PASSWORD_MESSAGE,
  PASSWORD_RESET_REQUEST_ENTITY,
  emailResetLinkToAccount,
  loadResetTarget,
  passwordResetRequestLabel,
  recordAdminReset,
  requestPasswordReset,
  settleDeferredPasswordResets
} from "@/lib/auth/password-reset";
import { createSession } from "@/lib/auth/session";
import { encryptSecret, generateTotpSecret } from "@/lib/auth/totp";
import { prisma } from "@/lib/db";
import { MailSendError } from "@/lib/newsletter/mail-errors";
import type { TransactionalMailer, TransactionalMessage } from "@/lib/newsletter/mailer-ses";

/**
 * Password reset by email against a real PostgreSQL: the "Forgot your password?" endpoint, the
 * administrator's "Email them a password link", and the existing set-password flow the links land on.
 *
 * ⚠ WRITES users, sessions and audit_logs rows (and removes only its own), so it refuses to run against
 * anything but a database on this machine — the same rule as audit-provenance.db.test.ts.
 */

const LOCAL = /@(127\.0\.0\.1|localhost|\[::1\]|postgres)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
const skip = !hasDatabase ? "no DATABASE_URL" : !LOCAL ? "DATABASE_URL is not a local database" : false;

const SITE = process.env.NEXT_PUBLIC_SITE_URL!;
/**
 * The origin a browser on SITE would send, as NextRequest sees the request URL.
 *
 * ⚠ NextRequest rewrites a loopback host to `localhost` (`http://127.0.0.1:3000` → `http://localhost:3000`)
 * in `request.url`, and `assertSameOrigin` compares the Origin header against that URL's host. CI sets
 * NEXT_PUBLIC_SITE_URL to http://127.0.0.1:3000, so sending SITE verbatim as the Origin made every POST
 * here a 403 — the route was right and the test was not. Emails still carry SITE itself (the canonical
 * origin), which is what `linkFrom` matches.
 */
const REQUEST_ORIGIN = new URL(new NextRequest(SITE).url).origin;
const RUN = `pwr-${Date.now()}`;
const PASSWORD = "Old-Passphrase-4821!";
const NEW_PASSWORD = "Brand-New-Phrase-7351#";
const ids: string[] = [];
const emails: string[] = [];

/** A mailer that records what it was asked to send, optionally slowly or by failing. */
function fakeMailer(behaviour: { delayMs?: number; fail?: MailSendError } = {}) {
  const sent: TransactionalMessage[] = [];
  const mailer: TransactionalMailer = {
    name: "fake",
    async send(message) {
      if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      if (behaviour.fail) throw behaviour.fail;
      sent.push(message);
      return { providerMessageId: `fake-${sent.length}` };
    }
  };
  return { mailer, sent };
}

function linkFrom(message: TransactionalMessage): string {
  const match = /https?:\/\/\S+\/studio\/set-password\?token=[A-Za-z0-9._%-]+/.exec(message.bodyText);
  assert.ok(match, "the email carries a set-password link");
  return match[0];
}
function tokenFrom(link: string): string {
  return decodeURIComponent(new URL(link).searchParams.get("token")!);
}

async function makeUser(
  label: string,
  options: { password?: boolean; active?: boolean; twoFactor?: boolean; role?: "EDITOR" | "ADMINISTRATOR" } = {}
) {
  const email = `${RUN}-${label}@cxa.example.org`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Reset ${label}`,
      role: options.role ?? "EDITOR",
      isActive: options.active ?? true,
      passwordHash: options.password === false ? null : await hashPassword(PASSWORD),
      ...(options.twoFactor
        ? { twoFactorEnabled: true, twoFactorSecret: encryptSecret(generateTotpSecret()) }
        : {})
    },
    select: { id: true, email: true, name: true }
  });
  /*
   * ⚠ A GRANT, BECAUSE A SEEDED DATABASE MAKES THE ALLOW-LIST AUTHORITATIVE. `resolveAccess` admits an
   * existing account without one only while `studio_access` is empty (the grace path in
   * lib/auth/access.ts). CI seeds before it tests, so a grant exists and an unlisted test account is
   * refused — set-password then answers access-refused before it ever reaches the second-factor rule
   * this file is checking. Real accounts are on the list; these must be too.
   */
  await prisma.studioAccess.create({ data: { email, kind: "EMAIL", grantedRole: options.role ?? "EDITOR" } });
  ids.push(user.id);
  emails.push(email);
  return user;
}

let ipCounter = 10;
/** A fresh client address per call unless one is given. `TRUSTED_PROXY_HOPS=1` makes it count. */
function forgot(email: string, init: { ip?: string; host?: string } = {}) {
  const ip = init.ip ?? `198.51.100.${ipCounter++}`;
  const origin = init.host ? `https://${init.host}` : REQUEST_ORIGIN;
  return new NextRequest(`${origin}/api/auth/forgot-password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-forwarded-for": ip,
      ...(init.host ? { host: init.host, "x-forwarded-host": init.host } : {})
    },
    body: JSON.stringify({ email })
  });
}

function setPassword(token: string, password = NEW_PASSWORD) {
  return new NextRequest(`${SITE}/api/auth/set-password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: REQUEST_ORIGIN, "x-forwarded-for": `203.0.113.${ipCounter++}` },
    body: JSON.stringify({ token, password })
  });
}

/** The audit rows "Forgot your password?" wrote for one typed address. */
async function auditFor(email: string) {
  return prisma.auditLog.findMany({
    where: { entityType: PASSWORD_RESET_REQUEST_ENTITY, entityLabel: passwordResetRequestLabel(email) },
    orderBy: { createdAt: "asc" }
  });
}

describe("password reset by email", { skip }, () => {
  let forgotPost: (request: NextRequest) => Promise<Response>;
  let setPasswordPost: (request: NextRequest) => Promise<Response>;
  let loginPost: (request: NextRequest) => Promise<Response>;
  const savedHops = process.env.TRUSTED_PROXY_HOPS;

  before(async () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    forgotPost = (await import("@/app/api/auth/forgot-password/route")).POST;
    setPasswordPost = (await import("@/app/api/auth/set-password/route")).POST;
    loginPost = (await import("@/app/api/auth/login/route")).POST;
  });

  afterEach(() => setAuthMailer(undefined));

  after(async () => {
    if (savedHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = savedHops;
    await settleDeferredPasswordResets();
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityId: { in: ids } },
          { entityLabel: { in: emails } },
          { entityLabel: { in: emails.map(passwordResetRequestLabel) } },
          { actorId: { in: ids } }
        ]
      }
    });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.studioAccess.deleteMany({ where: { email: { in: emails } } });
  });

  it("answers a known and an unknown address with the same status and the same body", async () => {
    const { mailer, sent } = fakeMailer();
    setAuthMailer(mailer);
    const known = await makeUser("known");
    const inactive = await makeUser("inactive", { active: false });
    const noPassword = await makeUser("nopassword", { password: false });
    const unknown = `${RUN}-nobody@cxa.example.org`;
    emails.push(unknown);

    const answers = [];
    for (const email of [known.email, unknown, inactive.email, noPassword.email]) {
      const response = await forgotPost(forgot(email));
      answers.push({ status: response.status, body: await response.text(), cache: response.headers.get("cache-control") });
    }
    await settleDeferredPasswordResets();

    for (const answer of answers) {
      assert.deepEqual(answer, { status: 200, body: JSON.stringify({ message: FORGOT_PASSWORD_MESSAGE }), cache: "no-store" });
    }
    // Only the active account with a password was mailed, and only at its own address.
    assert.deepEqual(sent.map((message) => message.to), [known.email]);

    // Every request is audited — unknown addresses included — with the typed address and the real IP.
    const outcomes = new Map<string, unknown>();
    const accounts = new Map<string, unknown>();
    for (const email of [known.email, unknown, inactive.email, noPassword.email]) {
      const rows = await auditFor(email);
      assert.equal(rows.length, 1, email);
      const row = rows[0]!;
      const payload = row.after as Record<string, unknown>;
      assert.equal(row.actorId, null);
      // An anonymous REQUEST, never a permission change, and never a User id in `entityId`.
      assert.equal(row.action, "CREATE");
      assert.equal(row.entityType, "PasswordResetRequest");
      assert.equal(row.entityId, null);
      assert.match(row.ipAddress ?? "", /^198\.51\.100\.\d+$/);
      assert.equal(payload.email, email);
      assert.ok("emailHash" in payload && "emailDomain" in payload);
      outcomes.set(email, payload.outcome);
      accounts.set(email, payload.accountId ?? null);
    }
    assert.deepEqual([...outcomes.values()], ["emailed", "unknown-address", "inactive", "no-password"]);
    // The matched account, for an investigator, lives in the payload.
    assert.deepEqual([...accounts.values()], [known.id, null, inactive.id, noPassword.id]);
  });

  it("answers a real account as fast as an unknown one: the send happens after the response", async () => {
    const slow = fakeMailer({ delayMs: 600 });
    setAuthMailer(slow.mailer);
    const user = await makeUser("timing");

    const started = Date.now();
    const response = await forgotPost(forgot(user.email));
    const elapsed = Date.now() - started;
    assert.equal(response.status, 200);
    assert.ok(elapsed < 400, `answered in ${elapsed} ms, before the 600 ms send`);
    assert.equal(slow.sent.length, 0, "nothing was sent before the answer");
    await settleDeferredPasswordResets();
    assert.equal(slow.sent.length, 1);
  });

  it("limits per client IP with a 429, and per address silently", async () => {
    const { mailer, sent } = fakeMailer();
    setAuthMailer(mailer);

    // Per IP: five, then 429 with Retry-After — about the connection, not any account.
    const ip = "192.0.2.77";
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await forgotPost(forgot(`${RUN}-ip-${i}@cxa.example.org`, { ip }))).status);
      emails.push(`${RUN}-ip-${i}@cxa.example.org`);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    const limited = await forgotPost(forgot(`${RUN}-ip-x@cxa.example.org`, { ip }));
    emails.push(`${RUN}-ip-x@cxa.example.org`);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await forgotPost(forgot(`${RUN}-ip-y@cxa.example.org`))).status, 200, "another connection is unaffected");
    emails.push(`${RUN}-ip-y@cxa.example.org`);

    // Per address: three emails an hour, from any number of connections; the fourth is the same 200.
    const user = await makeUser("flooded");
    const bodies = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await forgotPost(forgot(user.email));
      bodies.push(`${response.status} ${await response.text()}`);
    }
    await settleDeferredPasswordResets();
    assert.equal(new Set(bodies).size, 1, "the throttled request is indistinguishable");
    assert.equal(sent.filter((message) => message.to === user.email).length, 3);
    // Sorted: the four deferred requests run concurrently, so their rows land in any order.
    const outcomes = (await auditFor(user.email)).map((row) => String((row.after as Record<string, unknown>).outcome));
    assert.deepEqual(outcomes.sort(), ["address-rate-limited", "emailed", "emailed", "emailed"]);
  });

  it("never writes a PERMISSION_CHANGE row for an anonymous request, whatever the address", async () => {
    const { mailer } = fakeMailer();
    setAuthMailer(mailer);
    const user = await makeUser("no-permission-row");
    const unknown = `${RUN}-nobody-2@cxa.example.org`;
    emails.push(unknown);

    await forgotPost(forgot(user.email));
    await forgotPost(forgot(unknown));
    await settleDeferredPasswordResets();

    const forged = await prisma.auditLog.count({
      where: {
        action: "PERMISSION_CHANGE",
        OR: [{ entityId: user.id }, { entityLabel: { in: [user.email, unknown] } }]
      }
    });
    assert.equal(forged, 0, "asking for a link changes nobody's access, so no row may say it did");
    assert.equal((await auditFor(user.email)).length, 1);
    assert.equal((await auditFor(unknown)).length, 1);
  });

  it("spends the per-address limit only on an account that would be mailed", async () => {
    const { mailer, sent } = fakeMailer();
    setAuthMailer(mailer);
    // Switched off, so requests for it are not mailed — and must not use up its bucket.
    const user = await makeUser("switched-off-first", { active: false });
    const context = { actor: null, ipAddress: "198.51.100.252" };

    const early = [];
    for (let i = 0; i < 4; i += 1) early.push(await requestPasswordReset({ email: user.email, context }));
    assert.deepEqual(early, ["inactive", "inactive", "inactive", "inactive"]);

    // Switched back on: the full three are still available, then the silent limit.
    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
    const later = [];
    for (let i = 0; i < 4; i += 1) later.push(await requestPasswordReset({ email: user.email, context }));
    assert.deepEqual(later, ["emailed", "emailed", "emailed", "address-rate-limited"]);
    assert.equal(sent.filter((message) => message.to === user.email).length, 3);
  });

  it("builds the link from NEXT_PUBLIC_SITE_URL, whatever Host the request carries", async () => {
    const { mailer, sent } = fakeMailer();
    setAuthMailer(mailer);
    const user = await makeUser("host");

    const response = await forgotPost(forgot(user.email, { host: "evil.example" }));
    assert.equal(response.status, 200);
    await settleDeferredPasswordResets();
    const link = linkFrom(sent[0]!);
    assert.ok(link.startsWith(`${SITE}/studio/set-password?token=`), link);
    assert.doesNotMatch(sent[0]!.bodyHtml + sent[0]!.bodyText, /evil\.example/);
  });

  it("the emailed link is single-use, expires after RESET_TTL_HOURS, and revokes sessions when used", async () => {
    const { mailer, sent } = fakeMailer();
    setAuthMailer(mailer);
    const user = await makeUser("single-use");
    const earlier = await createSession({ userId: user.id });

    await forgotPost(forgot(user.email));
    await forgotPost(forgot(user.email));
    await settleDeferredPasswordResets();
    const [first, second] = sent.map((message) => tokenFrom(linkFrom(message)));

    const verdict = verifyCredentialToken(first);
    assert.ok(verdict.ok);
    if (verdict.ok) {
      assert.equal(verdict.payload.purpose, "reset");
      const hours = (verdict.payload.exp * 1000 - Date.now()) / 3_600_000;
      assert.ok(hours > RESET_TTL_HOURS - 0.01 && hours <= RESET_TTL_HOURS, `${hours} hours`);
    }
    assert.deepEqual(
      verifyCredentialToken(first, new Date(Date.now() + RESET_TTL_HOURS * 3_600_000 + 1000)),
      { ok: false, reason: "expired" }
    );

    // Asking revoked nothing: the session is still live.
    assert.equal(await prisma.session.count({ where: { userId: user.id, revokedAt: null } }), 1);

    const used = await setPasswordPost(setPassword(first!));
    assert.equal(used.status, 200, await used.clone().text());
    // Using it revoked the session that existed before (the set-password route's rule 4, unchanged).
    const before = await prisma.session.findUniqueOrThrow({ where: { id: earlier.sessionId } });
    assert.ok(before.revokedAt, "the earlier session is revoked once the link is used");

    // The same link again, and the other link minted before the password changed: both refused.
    for (const token of [first!, second!]) {
      const replay = await setPasswordPost(setPassword(token, "Yet-Another-Phrase-9137$"));
      assert.equal(replay.status, 400);
      assert.equal(((await replay.json()) as { code: string }).code, "invalid_credential_link");
    }
  });

  it("does not weaken two-step verification: a reset account still needs its code to sign in", async () => {
    const { mailer, sent } = fakeMailer();
    setAuthMailer(mailer);
    const user = await makeUser("two-factor", { twoFactor: true });

    await forgotPost(forgot(user.email));
    await settleDeferredPasswordResets();
    const response = await setPasswordPost(setPassword(tokenFrom(linkFrom(sent[0]!))));
    const body = (await response.json()) as { signedIn: boolean; twoFactorRequired: boolean };
    assert.equal(response.status, 200);
    assert.equal(body.signedIn, false);
    assert.equal(body.twoFactorRequired, true);
    assert.equal(await prisma.session.count({ where: { userId: user.id, revokedAt: null } }), 0);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { twoFactorEnabled: true, twoFactorSecret: true } });
    assert.equal(row.twoFactorEnabled, true);
    assert.ok(row.twoFactorSecret);

    // Signing in with the new password alone is a challenge, not a session.
    const login = await loginPost(
      new NextRequest(`${SITE}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: REQUEST_ORIGIN, "x-forwarded-for": "203.0.113.200" },
        body: JSON.stringify({ email: user.email, password: NEW_PASSWORD })
      })
    );
    assert.equal(login.status, 200);
    assert.equal(((await login.json()) as { twoFactorRequired?: boolean }).twoFactorRequired, true);
    assert.equal(await prisma.session.count({ where: { userId: user.id, revokedAt: null } }), 0);
  });

  it("administrator email: sends to the account's own address, then audits and revokes", async () => {
    const { mailer, sent } = fakeMailer();
    setAuthMailer(mailer);
    const admin = await makeUser("admin", { role: "ADMINISTRATOR" });
    const user = await makeUser("admin-target");
    await createSession({ userId: user.id });

    const context = { actor: { id: admin.id, email: admin.email }, ipAddress: "198.51.100.250" };
    const result = await emailResetLinkToAccount(context, await loadResetTarget(user.id));
    assert.equal(result.sessionsEnded, 1);
    assert.deepEqual(sent.map((message) => message.to), [user.email]);
    assert.ok(linkFrom(sent[0]!).startsWith(`${SITE}/studio/set-password?token=`));
    assert.equal(await prisma.session.count({ where: { userId: user.id, revokedAt: null } }), 0);

    const rows = await prisma.auditLog.findMany({ where: { entityLabel: `${user.name} <${user.email}>` } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actorId, admin.id);
    assert.equal((rows[0]!.before as Record<string, unknown>).emailed, true);
    assert.doesNotMatch(JSON.stringify(rows[0]), /token=/);
  });

  it("administrator email: a failed send or a missing sender says so and changes nothing", async () => {
    const admin = await makeUser("admin-2", { role: "ADMINISTRATOR" });
    const user = await makeUser("admin-target-2");
    await createSession({ userId: user.id });
    const context = { actor: { id: admin.id, email: admin.email }, ipAddress: "198.51.100.251" };

    setAuthMailer(fakeMailer({ fail: new MailSendError("halt", "MessageRejected", "Email address is not verified.") }).mailer);
    await assert.rejects(emailResetLinkToAccount(context, await loadResetTarget(user.id)), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 502);
      assert.match(error.message, /could not be emailed/);
      assert.match(error.message, /Make a password link/);
      assert.match(error.message, /Nothing about the account has changed/);
      return true;
    });

    setAuthMailer(null);
    await assert.rejects(emailResetLinkToAccount(context, await loadResetTarget(user.id)), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 503);
      assert.match(error.message, /Email is not set up/);
      return true;
    });

    // Neither attempt revoked the session; the failure is in the log.
    assert.equal(await prisma.session.count({ where: { userId: user.id, revokedAt: null } }), 1);
    const failures = await prisma.auditLog.findMany({ where: { entityId: user.id } });
    assert.equal(failures.length, 1);
    assert.equal((failures[0]!.after as Record<string, unknown>).event, "password-link-email-failed");
  });

  it("make-a-link's audit entry and revocation are unchanged", async () => {
    const admin = await makeUser("admin-3", { role: "ADMINISTRATOR" });
    const user = await makeUser("link-target");
    await createSession({ userId: user.id });
    const expiresAt = new Date(Date.now() + RESET_TTL_HOURS * 3_600_000);
    const target = await loadResetTarget(user.id);

    const ended = await recordAdminReset({ actor: { id: admin.id, email: admin.email } }, target, { expiresAt, emailed: false });
    assert.equal(ended, 1);
    assert.equal(await prisma.session.count({ where: { userId: user.id, revokedAt: null } }), 0);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entityLabel: `${user.name} <${user.email}>` } });
    assert.equal(row.action, "PERMISSION_CHANGE");
    assert.deepEqual(Object.keys(row.before as object).sort(), ["activeSessions", "hadPassword", "linkExpiresAt"]);
  });
});
