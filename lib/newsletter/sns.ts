import { X509Certificate, createPublicKey, createVerify, type KeyObject } from "node:crypto";

/**
 * Verifying an Amazon SNS message delivered to an HTTPS endpoint.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS MATTERS ENOUGH TO BE ITS OWN FILE
 *
 * The SES feedback webhook marks subscribers as bounced or complained, which STOPS MAIL TO THEM. An
 * unauthenticated endpoint that did that would let anybody on the internet silence the newsletter for any
 * address they could name. So nothing in a message is believed until its signature has been checked
 * against a certificate fetched from Amazon — and the certificate URL is itself checked, because it
 * arrives inside the message an attacker controls.
 *
 * The construction is Amazon's documented one ("Verifying the signatures of Amazon SNS messages"):
 *
 *   1. `SigningCertURL` must be HTTPS on `sns.<region>.amazonaws.com` (or `.amazonaws.com.cn`) and name a
 *      `.pem`. Anything else is refused BEFORE it is fetched — fetching an attacker's URL to obtain the key
 *      that verifies the attacker's message would verify everything.
 *   2. The string to sign is `Key\nValue\n` for a fixed list of fields, in a fixed order that differs by
 *      message type. A field that is absent is skipped (only `Subject` can be).
 *   3. `SignatureVersion` 1 is RSA-SHA1, 2 is RSA-SHA256. Anything else is refused.
 *
 * The certificate fetch is injected, so the tests can verify messages they signed themselves; production
 * uses `fetchSnsCertificate`, which fetches over HTTPS, checks the certificate's validity window and
 * caches it for the life of the process.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * No `server-only`, no database: the tests import it directly.
 */

export type SnsMessageType = "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";

export interface SnsMessage {
  Type: SnsMessageType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

const NOTIFICATION_FIELDS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const SUBSCRIPTION_FIELDS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** Parse a request body into an SNS message, or null when it is not one. */
export function parseSnsMessage(raw: unknown): SnsMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const str = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : undefined);
  const type = str("Type");
  if (type !== "Notification" && type !== "SubscriptionConfirmation" && type !== "UnsubscribeConfirmation") {
    return null;
  }
  const required = ["MessageId", "TopicArn", "Message", "Timestamp", "SignatureVersion", "Signature", "SigningCertURL"];
  for (const key of required) if (!str(key)) return null;
  return {
    Type: type,
    MessageId: str("MessageId") as string,
    TopicArn: str("TopicArn") as string,
    Message: str("Message") as string,
    Timestamp: str("Timestamp") as string,
    SignatureVersion: str("SignatureVersion") as string,
    Signature: str("Signature") as string,
    SigningCertURL: str("SigningCertURL") as string,
    Subject: str("Subject"),
    SubscribeURL: str("SubscribeURL"),
    Token: str("Token"),
    UnsubscribeURL: str("UnsubscribeURL")
  };
}

/** Is this a URL Amazon SNS would sign with, or send a subscription confirmation from? */
export function isAmazonSnsUrl(raw: string | undefined, kind: "certificate" | "subscribe"): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (!SNS_HOST.test(url.hostname)) return false;
  if (kind === "certificate" && !url.pathname.endsWith(".pem")) return false;
  return true;
}

/** The exact string SNS signed. Exported so a test can sign the same bytes. */
export function snsStringToSign(message: SnsMessage): string {
  const fields = message.Type === "Notification" ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
  let out = "";
  for (const field of fields) {
    const value = message[field];
    if (value === undefined) continue;
    out += `${field}\n${value}\n`;
  }
  return out;
}

export type CertificateFetcher = (url: string) => Promise<KeyObject | string>;

export type SnsVerification =
  | { ok: true }
  | { ok: false; reason: "bad-certificate-url" | "unsupported-version" | "certificate-unavailable" | "bad-signature" };

export async function verifySnsMessage(
  message: SnsMessage,
  fetchCertificate: CertificateFetcher = fetchSnsCertificate
): Promise<SnsVerification> {
  if (!isAmazonSnsUrl(message.SigningCertURL, "certificate")) return { ok: false, reason: "bad-certificate-url" };

  const algorithm =
    message.SignatureVersion === "1" ? "RSA-SHA1" : message.SignatureVersion === "2" ? "RSA-SHA256" : null;
  if (!algorithm) return { ok: false, reason: "unsupported-version" };

  let key: KeyObject | string;
  try {
    key = await fetchCertificate(message.SigningCertURL);
  } catch {
    return { ok: false, reason: "certificate-unavailable" };
  }

  try {
    const verifier = createVerify(algorithm);
    verifier.update(snsStringToSign(message), "utf8");
    verifier.end();
    const valid = verifier.verify(key, Buffer.from(message.Signature, "base64"));
    return valid ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
}

const certificateCache = new Map<string, KeyObject>();

/**
 * Fetch, check and cache an SNS signing certificate. Only ever called with a URL that has passed
 * `isAmazonSnsUrl`.
 */
export async function fetchSnsCertificate(url: string): Promise<KeyObject> {
  const cached = certificateCache.get(url);
  if (cached) return cached;

  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`certificate fetch answered ${response.status}`);
  const pem = await response.text();

  const certificate = new X509Certificate(pem);
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new Error("the SNS signing certificate is outside its validity window");
  }
  if (!/amazonaws\.com/i.test(`${certificate.subject} ${certificate.subjectAltName ?? ""}`)) {
    throw new Error("the SNS signing certificate is not issued to an amazonaws.com name");
  }

  const key = createPublicKey(certificate.publicKey.export({ type: "spki", format: "pem" }));
  certificateCache.set(url, key);
  return key;
}
