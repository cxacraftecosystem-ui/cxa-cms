import "./setup";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SendEmailCommand } from "@aws-sdk/client-sesv2";

import type { SesEnv } from "@/lib/env";
import type { NewsletterMessage } from "@/lib/newsletter/delivery";
import { MailSendError, describeSendError, dispositionOf } from "@/lib/newsletter/mail-errors";
import {
  buildSendEmailInput,
  classifySesError,
  createSesMailer,
  formatFromAddress,
  scrubAddresses
} from "@/lib/newsletter/mailer-ses";

/** An error shaped the way the AWS SDK v3 throws one. */
function awsError(name: string, status: number | null, message = `${name} happened`, extra: Record<string, unknown> = {}) {
  const error = new Error(message) as Error & Record<string, unknown>;
  error.name = name;
  if (status !== null) error.$metadata = { httpStatusCode: status };
  Object.assign(error, extra);
  return error;
}

const ENV: SesEnv = {
  region: "ap-south-1",
  accessKeyId: "AKIATESTONLY",
  secretAccessKey: "test-only-secret",
  fromAddress: "news@example.org",
  fromName: "Centre of Excellence",
  configurationSet: undefined
};

const MESSAGE: NewsletterMessage = {
  to: "Reader@Example.org",
  emailKey: "reader@example.org",
  subscriberId: "sub_1",
  kind: "ISSUE",
  subject: "The autumn issue",
  bodyText: "Plain words.",
  bodyHtml: "<p>Rich words.</p>",
  headers: [
    { name: "List-Unsubscribe", value: "<https://example.org/api/public/newsletter/one-click?token=v1.a.b>" },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }
  ],
  actionUrl: null
};

describe("classifySesError — what a failed send means for the message", () => {
  it("retries throttling, by name and by status", () => {
    assert.equal(classifySesError(awsError("TooManyRequestsException", 429)).disposition, "retry");
    assert.equal(classifySesError(awsError("SomethingNew", 429)).disposition, "retry");
    assert.equal(
      classifySesError(awsError("SomethingNew", 400, "slow down", { $retryable: { throttling: true } })).disposition,
      "retry"
    );
  });

  it("retries 5xx and the daily quota", () => {
    assert.equal(classifySesError(awsError("InternalServiceErrorException", 500)).disposition, "retry");
    assert.equal(classifySesError(awsError("ServiceUnavailable", 503)).disposition, "retry");
    assert.equal(classifySesError(awsError("Unnamed", 502)).disposition, "retry");
    assert.equal(classifySesError(awsError("LimitExceededException", 400)).disposition, "retry");
  });

  it("retries a transport failure that never got an HTTP answer", () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    assert.equal(classifySesError(reset).disposition, "retry");
    assert.equal(classifySesError(awsError("TimeoutError", null)).disposition, "retry");
  });

  it("rejects a message the provider refused, without a retry", () => {
    assert.equal(classifySesError(awsError("MessageRejected", 400, "Illegal address")).disposition, "reject");
    assert.equal(classifySesError(awsError("BadRequestException", 400)).disposition, "reject");
    assert.equal(classifySesError(awsError("Unnamed", 400)).disposition, "reject");
  });

  it("halts on account and credential problems rather than burning the queue", () => {
    assert.equal(classifySesError(awsError("SendingPausedException", 400)).disposition, "halt");
    assert.equal(classifySesError(awsError("AccountSuspendedException", 400)).disposition, "halt");
    assert.equal(classifySesError(awsError("UnrecognizedClientException", 403)).disposition, "halt");
    assert.equal(classifySesError(awsError("Unnamed", 403)).disposition, "halt");
    // An unverified SENDER fails every message identically: a halt, not a per-message reject.
    assert.equal(
      classifySesError(
        awsError("MessageRejected", 400, "Email address is not verified. The following identities failed the check: news@example.org")
      ).disposition,
      "halt"
    );
  });

  it("never carries an address in the message it keeps", () => {
    const classified = classifySesError(
      awsError("MessageRejected", 400, "Email address is not verified: reader@example.org, news@example.org")
    );
    assert.ok(!classified.message.includes("@"), classified.message);
    assert.ok(!describeSendError(classified).includes("example.org"));
    assert.equal(scrubAddresses("to <a.b+c@d.example> now"), "to <<address>> now");
  });

  it("treats anything that is not a MailSendError as retryable", () => {
    assert.equal(dispositionOf(new Error("boom")), "retry");
    assert.equal(dispositionOf(new MailSendError("reject", "X", "no")), "reject");
  });
});

describe("buildSendEmailInput — the request exactly as SES receives it", () => {
  it("sends Simple content with both parts and the RFC 8058 headers", () => {
    const input = buildSendEmailInput(ENV, MESSAGE);
    assert.deepEqual(input.Destination, { ToAddresses: ["Reader@Example.org"] });
    assert.equal(input.FromEmailAddress, '"Centre of Excellence" <news@example.org>');
    const simple = input.Content?.Simple;
    assert.ok(simple);
    assert.equal(simple.Subject?.Data, "The autumn issue");
    assert.equal(simple.Body?.Text?.Data, "Plain words.");
    assert.equal(simple.Body?.Html?.Data, "<p>Rich words.</p>");
    assert.deepEqual(simple.Headers, [
      { Name: "List-Unsubscribe", Value: "<https://example.org/api/public/newsletter/one-click?token=v1.a.b>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }
    ]);
    assert.equal(input.ConfigurationSetName, undefined);
  });

  it("omits the HTML part and the headers for a plain transactional message", () => {
    const input = buildSendEmailInput({ ...ENV, configurationSet: "feedback" }, {
      ...MESSAGE,
      kind: "CONFIRMATION",
      bodyHtml: null,
      headers: []
    });
    assert.equal(input.Content?.Simple?.Body?.Html, undefined);
    assert.equal(input.Content?.Simple?.Headers, undefined);
    assert.equal(input.ConfigurationSetName, "feedback");
  });

  it("quotes and escapes the display name", () => {
    assert.equal(formatFromAddress('The "Centre"', "a@b.org"), '"The \\"Centre\\"" <a@b.org>');
    assert.equal(formatFromAddress("  ", "a@b.org"), "a@b.org");
  });
});

describe("createSesMailer", () => {
  it("returns the provider's message id on success", async () => {
    const sent: unknown[] = [];
    const mailer = createSesMailer(ENV, {
      async send(command) {
        sent.push(command);
        return { MessageId: "0100-abc" };
      }
    });
    const result = await mailer.send(MESSAGE);
    assert.equal(result.providerMessageId, "0100-abc");
    assert.ok(sent[0] instanceof SendEmailCommand);
  });

  it("throws a classified MailSendError on failure", async () => {
    const mailer = createSesMailer(ENV, {
      async send() {
        throw awsError("TooManyRequestsException", 429, "Maximum sending rate exceeded.");
      }
    });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof MailSendError);
      assert.equal(error.disposition, "retry");
      assert.equal(error.code, "TooManyRequestsException");
      return true;
    });
  });

  it("reads the sending quota, and survives not being allowed to", async () => {
    const mailer = createSesMailer(ENV, {
      async send() {
        return { SendQuota: { MaxSendRate: 14, Max24HourSend: 50000, SentLast24Hours: 1000 }, SendingEnabled: true };
      }
    });
    assert.deepEqual(await mailer.quota?.(), { maxPerSecond: 14, remainingToday: 49000, sendingEnabled: true });

    const denied = createSesMailer(ENV, {
      async send() {
        throw awsError("AccessDeniedException", 403);
      }
    });
    assert.equal(await denied.quota?.(), null);
  });
});
