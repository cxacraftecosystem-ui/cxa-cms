import "./setup";

import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  isAmazonSnsUrl,
  parseSnsMessage,
  snsStringToSign,
  verifySnsMessage,
  type SnsMessage
} from "@/lib/newsletter/sns";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const CERT_URL = "https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem";
const TOPIC = "arn:aws:sns:ap-south-1:626159998512:ses-feedback";

function signed(message: Omit<SnsMessage, "Signature">, algorithm: "RSA-SHA1" | "RSA-SHA256"): SnsMessage {
  const unsigned = { ...message, Signature: "" } as SnsMessage;
  const signer = createSign(algorithm);
  signer.update(snsStringToSign(unsigned), "utf8");
  return { ...unsigned, Signature: signer.sign(privateKey, "base64") };
}

const notification = (version: "1" | "2"): SnsMessage =>
  signed(
    {
      Type: "Notification",
      MessageId: "a1b2",
      TopicArn: TOPIC,
      Subject: "Amazon SES Email Event Notification",
      Message: JSON.stringify({ notificationType: "Bounce", bounce: { bounceType: "Permanent" } }),
      Timestamp: "2026-10-10T10:00:00.000Z",
      SignatureVersion: version,
      SigningCertURL: CERT_URL
    },
    version === "1" ? "RSA-SHA1" : "RSA-SHA256"
  );

const fetchKey = async () => publicKey;

describe("SNS message signatures", () => {
  it("verifies a notification signed with SignatureVersion 2 (SHA-256) and 1 (SHA-1)", async () => {
    assert.deepEqual(await verifySnsMessage(notification("2"), fetchKey), { ok: true });
    assert.deepEqual(await verifySnsMessage(notification("1"), fetchKey), { ok: true });
  });

  it("verifies a SubscriptionConfirmation, whose signed fields differ", async () => {
    const message = signed(
      {
        Type: "SubscriptionConfirmation",
        MessageId: "c3",
        TopicArn: TOPIC,
        Message: "You have chosen to subscribe…",
        SubscribeURL: "https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t",
        Token: "t",
        Timestamp: "2026-10-10T10:00:00.000Z",
        SignatureVersion: "2",
        SigningCertURL: CERT_URL
      },
      "RSA-SHA256"
    );
    assert.ok(snsStringToSign(message).includes("SubscribeURL\n"));
    assert.ok(!snsStringToSign(message).includes("Subject\n"));
    assert.deepEqual(await verifySnsMessage(message, fetchKey), { ok: true });
  });

  it("refuses a tampered message", async () => {
    const message = notification("2");
    const tampered = { ...message, Message: message.Message.replace("Permanent", "Transient") };
    assert.deepEqual(await verifySnsMessage(tampered, fetchKey), { ok: false, reason: "bad-signature" });
  });

  it("refuses a message signed by a different key", async () => {
    assert.deepEqual(await verifySnsMessage(notification("2"), async () => other.publicKey), {
      ok: false,
      reason: "bad-signature"
    });
  });

  it("refuses a certificate URL that is not Amazon SNS, before fetching anything", async () => {
    let fetched = false;
    const message = { ...notification("2"), SigningCertURL: "https://sns.ap-south-1.amazonaws.com.evil.example/cert.pem" };
    const result = await verifySnsMessage(message, async () => {
      fetched = true;
      return publicKey;
    });
    assert.deepEqual(result, { ok: false, reason: "bad-certificate-url" });
    assert.equal(fetched, false);
  });

  it("refuses an unknown signature version and an unreachable certificate", async () => {
    assert.deepEqual(await verifySnsMessage({ ...notification("2"), SignatureVersion: "3" }, fetchKey), {
      ok: false,
      reason: "unsupported-version"
    });
    assert.deepEqual(
      await verifySnsMessage(notification("2"), async () => {
        throw new Error("offline");
      }),
      { ok: false, reason: "certificate-unavailable" }
    );
  });

  it("accepts only HTTPS URLs on an sns.<region>.amazonaws.com host", () => {
    assert.ok(isAmazonSnsUrl(CERT_URL, "certificate"));
    assert.ok(isAmazonSnsUrl("https://sns.cn-north-1.amazonaws.com.cn/x.pem", "certificate"));
    assert.ok(!isAmazonSnsUrl("http://sns.ap-south-1.amazonaws.com/x.pem", "certificate"));
    assert.ok(!isAmazonSnsUrl("https://sns.ap-south-1.amazonaws.com/x.txt", "certificate"));
    assert.ok(!isAmazonSnsUrl("https://evil.example/sns.ap-south-1.amazonaws.com/x.pem", "certificate"));
    assert.ok(!isAmazonSnsUrl("https://user@sns.ap-south-1.amazonaws.com/x.pem", "certificate"));
    assert.ok(isAmazonSnsUrl("https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription", "subscribe"));
  });

  it("parses only well-formed SNS bodies", () => {
    assert.equal(parseSnsMessage({ Type: "Notification" }), null);
    assert.equal(parseSnsMessage("nope"), null);
    assert.ok(parseSnsMessage(JSON.parse(JSON.stringify(notification("2")))));
  });
});
