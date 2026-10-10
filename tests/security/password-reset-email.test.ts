import "../newsletter/setup";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { Role } from "@prisma/client";

import { renderPasswordResetEmail } from "@/lib/auth/auth-mail";
import { issueCredentialLink } from "@/lib/auth/credential-token";
import {
  FORGOT_PASSWORD_MESSAGE,
  PASSWORD_RESET_REQUEST_ENTITY,
  addressBucket,
  passwordResetRequestLabel,
  resetRefusal
} from "@/lib/auth/password-reset";
import { authEmailConfigured, authEmailEnv, type SesEnv } from "@/lib/env";
import { MailSendError } from "@/lib/newsletter/mail-errors";
import {
  buildTransactionalSendEmailInput,
  createSesTransactionalMailer,
  type TransactionalMessage
} from "@/lib/newsletter/mailer-ses";

/**
 * Password-reset email, without a database: who may send one, what is sent, and where its From line and
 * link come from. The flows against a real PostgreSQL are in password-reset.db.test.ts.
 */

const ROOT = process.cwd();
const source = (relative: string) =>
  readFileSync(path.join(ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

function subject(id: string, role: Role) {
  return { id, role, canPublish: false, canManageMedia: false };
}
function target(id: string, role: Role, extra: Partial<{ isActive: boolean; deletedAt: Date | null }> = {}) {
  return { id, name: "Somebody", role, isActive: true, deletedAt: null, ...extra };
}

describe("who may issue a password link — one rule for both buttons", () => {
  const admin = subject("admin", "ADMINISTRATOR");

  it("allows an administrator to reset somebody below them, and themselves", () => {
    for (const delivery of ["link", "email"] as const) {
      assert.equal(resetRefusal(admin, target("ed", "EDITOR"), delivery), null);
      assert.equal(resetRefusal(admin, target("admin", "ADMINISTRATOR"), delivery), null);
    }
  });

  it("refuses a peer or a superior with 403 — identically for a link and an email", () => {
    for (const role of ["ADMINISTRATOR", "MASTER_ADMIN"] as const) {
      const link = resetRefusal(admin, target("other", role), "link");
      const email = resetRefusal(admin, target("other", role), "email");
      assert.equal(link?.status, 403);
      assert.equal(email?.status, 403);
    }
  });

  it("refuses a deleted or switched-off account with 409, identically", () => {
    for (const extra of [{ deletedAt: new Date() }, { isActive: false }]) {
      assert.equal(resetRefusal(admin, target("ed", "EDITOR", extra), "link")?.status, 409);
      assert.equal(resetRefusal(admin, target("ed", "EDITOR", extra), "email")?.status, 409);
    }
  });

  it("both routes gate on the same capability and the same refusal", () => {
    const makeLink = source("app/api/studio/users/[id]/password-reset/route.ts");
    const email = source("app/api/studio/users/[id]/password-reset/email/route.ts");
    for (const text of [makeLink, email]) {
      assert.match(text, /assertSameOrigin\(request\)/);
      assert.match(text, /requireCapability\(\s*canManageUsers,/);
      assert.match(text, /resetRefusal\(actor, target, "(link|email)"\)/);
      assert.match(text, /if \(refusal\) throw refusal;/);
    }
    // The make-a-link answer still carries the link; the email answer never does.
    assert.match(makeLink, /emailed: false,\s*link,/);
    assert.doesNotMatch(email, /\blink\b\s*[,:}]/);
  });
});

describe("the account-mail From line", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "NEWSLETTER_FROM_ADDRESS", "NEWSLETTER_FROM_NAME", "AUTH_EMAIL_FROM_ADDRESS", "AUTH_EMAIL_FROM_NAME"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("falls back to the newsletter's From line, and an override wins", () => {
    process.env.SES_ACCESS_KEY_ID = "AKIATESTONLY";
    process.env.SES_SECRET_ACCESS_KEY = "test-only";
    process.env.NEWSLETTER_FROM_ADDRESS = "news@aicraft.iitkgp.ac.in";
    process.env.NEWSLETTER_FROM_NAME = "CxA News";
    delete process.env.AUTH_EMAIL_FROM_ADDRESS;
    delete process.env.AUTH_EMAIL_FROM_NAME;
    assert.equal(authEmailConfigured(), true);
    assert.deepEqual([authEmailEnv().fromAddress, authEmailEnv().fromName], ["news@aicraft.iitkgp.ac.in", "CxA News"]);

    process.env.AUTH_EMAIL_FROM_ADDRESS = "studio@aicraft.iitkgp.ac.in";
    process.env.AUTH_EMAIL_FROM_NAME = "CxA Studio";
    assert.deepEqual([authEmailEnv().fromAddress, authEmailEnv().fromName], ["studio@aicraft.iitkgp.ac.in", "CxA Studio"]);

    // Account mail works without any newsletter sender at all…
    delete process.env.NEWSLETTER_FROM_ADDRESS;
    assert.equal(authEmailConfigured(), true);
    // …but not without the keys.
    delete process.env.SES_ACCESS_KEY_ID;
    assert.equal(authEmailConfigured(), false);
  });
});

describe("the message itself", () => {
  const ENV: SesEnv = {
    region: "ap-south-1",
    accessKeyId: "AKIATESTONLY",
    secretAccessKey: "test-only",
    fromAddress: "studio@aicraft.iitkgp.ac.in",
    fromName: "CxA Studio",
    configurationSet: undefined
  };
  const { link } = issueCredentialLink({ userId: "user_1", passwordHash: "$2a$12$abc", purpose: "reset" });
  const rendered = renderPasswordResetEmail({ name: "Asha", link, ttlHours: 2, requestedBy: "self" });
  const message: TransactionalMessage = {
    to: "asha@aicraft.iitkgp.ac.in",
    subject: rendered.subject,
    bodyText: rendered.text,
    bodyHtml: rendered.html,
    tag: "password-reset"
  };

  it("the link is built from the configured origin and appears verbatim, with no tracking", () => {
    assert.ok(link.startsWith(`${process.env.NEXT_PUBLIC_SITE_URL}/studio/set-password?token=`));
    assert.ok(rendered.text.includes(link));
    assert.ok(rendered.html.includes(link));
    assert.doesNotMatch(rendered.html, /<img/i);
    assert.doesNotMatch(rendered.html + rendered.text, /unsubscribe/i);
  });

  it("goes out as plain text + HTML, from the account-mail sender, with no List-Unsubscribe", () => {
    const input = buildTransactionalSendEmailInput(ENV, message);
    assert.equal(input.FromEmailAddress, '"CxA Studio" <studio@aicraft.iitkgp.ac.in>');
    assert.deepEqual(input.Destination?.ToAddresses, ["asha@aicraft.iitkgp.ac.in"]);
    assert.ok(input.Content?.Simple?.Body?.Text?.Data?.includes(link));
    assert.ok(input.Content?.Simple?.Body?.Html?.Data?.includes(link));
    assert.equal(input.Content?.Simple?.Headers, undefined);
    assert.deepEqual(input.EmailTags, [{ Name: "kind", Value: "auth-password-reset" }]);
  });

  it("a refused send surfaces as a classified MailSendError, never a silent success", async () => {
    const refusing = createSesTransactionalMailer(ENV, {
      send: async () => {
        throw Object.assign(new Error("Email address is not verified. The following identities failed the check: asha@aicraft.iitkgp.ac.in"), {
          name: "MessageRejected",
          $metadata: { httpStatusCode: 400 }
        });
      }
    });
    await assert.rejects(refusing.send(message), (error: unknown) => {
      assert.ok(error instanceof MailSendError);
      assert.equal(error.disposition, "halt");
      assert.doesNotMatch(error.message, /asha@/);
      return true;
    });
  });

  it("the public answer never mentions two-step verification", () => {
    assert.doesNotMatch(FORGOT_PASSWORD_MESSAGE, /two-step|authenticator|2fa/i);
  });
});

describe("what an anonymous request leaves behind", () => {
  /** `requestPasswordReset`'s own body, comments stripped. */
  function requestSource(): string {
    const all = source("lib/auth/password-reset.ts");
    const start = all.indexOf("export async function requestPasswordReset");
    const end = all.indexOf("const outsideRequest");
    assert.ok(start > 0 && end > start, "requestPasswordReset is where the test expects it");
    return all.slice(start, end);
  }

  it("is audited as an anonymous CREATE of a request — never as a permission change", () => {
    const body = requestSource();
    // A stranger can trigger this row for any address; it changes nobody's access, so it must not be
    // filed, coloured or described as a permission change on the audit screen or the dashboard.
    assert.doesNotMatch(body, /PERMISSION_CHANGE/);
    assert.match(body, /action: "CREATE"/);
    assert.match(body, /entityType: PASSWORD_RESET_REQUEST_ENTITY/);
    // The entity is the request: a User id in `entityId` would claim the row is about an account.
    assert.match(body, /entityId: null/);
    assert.equal(PASSWORD_RESET_REQUEST_ENTITY, "PasswordResetRequest");
  });

  it("reads honestly through the screens' generic sentence", () => {
    const label = passwordResetRequestLabel("asha@cxa.example.org");
    // The dashboard's default is `${who} ${phrase} ${label}`, with phrase "created" for CREATE.
    assert.equal(`Somebody created ${label}`, "Somebody created a password-link request for asha@cxa.example.org");
    assert.doesNotMatch(label, /allowed|permission|changed/i);
  });

  it("counts the per-address limit only for an account that would be mailed", () => {
    const body = requestSource();
    const lookup = body.indexOf("prisma.user.findUnique");
    const consume = body.indexOf("consumeRateLimitAsync(addressBucket(email)");
    assert.ok(lookup > 0 && consume > lookup, "the bucket is consumed after the account is looked up");
    assert.ok(body.indexOf('outcome = "no-password"') < consume, "…and after the not-mailable outcomes");
  });

  it("keys the per-address limiter with a keyed HMAC, not a reversible plain hash", () => {
    const email = "director@cxa.example.org";
    const key = addressBucket(email);
    assert.equal(key, addressBucket(email), "stable for one address");
    assert.notEqual(key, addressBucket("someone-else@cxa.example.org"));
    assert.match(key, /^auth:password-reset:address:[0-9a-f]{32}$/);
    // Hashing a public staff list must not reproduce the key.
    const plain = createHash("sha256").update(email).digest("hex").slice(0, 32);
    assert.ok(!key.endsWith(plain), "an unkeyed SHA-256 of the address would be reversible");
    assert.ok(!key.includes(email));
  });
});
