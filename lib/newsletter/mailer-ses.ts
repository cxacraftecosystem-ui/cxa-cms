import "server-only";

import {
  GetAccountCommand,
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandInput
} from "@aws-sdk/client-sesv2";

import type { SesEnv } from "@/lib/env";
import { MailSendError, type SendDisposition } from "@/lib/newsletter/mail-errors";
import type { NewsletterMailer, NewsletterMessage, SendQuota } from "@/lib/newsletter/delivery";

/**
 * The Amazon SES adapter — the one `NewsletterMailer` this deployment registers.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY `Content.Simple` AND NOT `Content.Raw`.
 *
 * SESv2's `Message` (the Simple form) has carried `Headers` since 2024, and the SDK pinned here types it
 * (`MessageHeader[]`). That is everything this feature needs: a subject, an HTML part, a plain-text part
 * and the two RFC 8058 headers. Raw would mean hand-assembling MIME — boundaries, transfer encodings,
 * RFC 2047 subjects — which is a parser's worth of code to get wrong in ways that only show up in one
 * mail client. SES builds the MIME from Simple correctly every time.
 *
 * ══ WHAT IS NEVER LOGGED ══
 *
 * No body, ever, and no address beyond the `emailKey` the rest of the feature already logs. A provider
 * error message can quote an address ("The following identities failed the check: …"), so every message
 * that leaves this file passes through `scrubAddresses` first — the outbox stores it and the studio shows
 * it, and both are read by more people than the subscriber list is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Error names SES returns, sorted by what they mean for the message. Anything not named here is judged
 * by its HTTP status: 5xx is the provider's problem (retry), 4xx is ours (reject).
 */
const RETRY_CODES = new Set([
  "TooManyRequestsException",
  "Throttling",
  "ThrottlingException",
  "ThrottledException",
  "RequestThrottled",
  "RequestTimeout",
  "RequestTimeoutException",
  "TimeoutError",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "InternalFailure",
  "InternalServiceErrorException",
  "InternalError",
  // Over the daily quota. The message is fine; tomorrow it will be accepted.
  "LimitExceededException",
  // A network failure before any HTTP answer.
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "NetworkingError"
]);

const HALT_CODES = new Set([
  "AccountSuspendedException",
  "SendingPausedException",
  "MailFromDomainNotVerifiedException",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "AccessDeniedException",
  "AccessDenied",
  "ExpiredTokenException",
  "CredentialsProviderError"
]);

const REJECT_CODES = new Set(["MessageRejected", "BadRequestException", "NotFoundException"]);

/** Any address-shaped run of characters, for `scrubAddresses`. */
const ADDRESS_PATTERN = /[^\s@<>"',;:()[\]]+@[^\s@<>"',;:()[\]]+/g;

export function scrubAddresses(text: string): string {
  return text.replace(ADDRESS_PATTERN, "<address>");
}

interface AwsLikeError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

/**
 * Turn whatever the SDK threw into a `MailSendError` with a disposition.
 *
 * Exported for the tests, which are the reason the order below is written down:
 *
 *   1. A NAMED code wins over the status, because SES answers both "your account is paused" and "this
 *      message is malformed" with a 400 and they need opposite treatment.
 *   2. `MessageRejected` whose text says the SENDER is unverified is a halt, not a reject: it fails every
 *      message identically, and rejecting each one would empty the queue into FAILED.
 *   3. The SDK's own `$retryable` flag, then the status: 429 and 5xx retry, any other 4xx rejects.
 *   4. No status at all is a transport failure before an answer arrived — retried.
 */
export function classifySesError(error: unknown): MailSendError {
  if (error instanceof MailSendError) return error;

  const shape = (typeof error === "object" && error !== null ? error : {}) as AwsLikeError;
  const name = typeof shape.name === "string" ? shape.name : "";
  const code = typeof shape.code === "string" ? shape.code : "";
  const label = name && name !== "Error" ? name : code || name || "UnknownError";
  const rawMessage =
    typeof shape.message === "string" ? shape.message : error instanceof Error ? error.message : String(error);
  const message = scrubAddresses(rawMessage).slice(0, 500);
  const status =
    typeof shape.$metadata?.httpStatusCode === "number" ? shape.$metadata.httpStatusCode : null;

  const make = (disposition: SendDisposition) => new MailSendError(disposition, label, message);

  if (HALT_CODES.has(name) || HALT_CODES.has(code)) return make("halt");
  if (REJECT_CODES.has(name)) {
    if (/not verified|identit(y|ies) failed|sending (is )?paused/i.test(rawMessage)) return make("halt");
    return make("reject");
  }
  if (RETRY_CODES.has(name) || RETRY_CODES.has(code)) return make("retry");

  const throttling = (shape.$retryable as { throttling?: unknown } | undefined)?.throttling === true;
  if (throttling || status === 429) return make("retry");
  if (status !== null && status >= 500) return make("retry");
  if (status === 401 || status === 403) return make("halt");
  if (status !== null && status >= 400) return make("reject");
  if (shape.$retryable) return make("retry");

  // No HTTP answer at all: a dropped connection or a timeout inside the SDK.
  return make("retry");
}

/**
 * `"Centre of Excellence" <news@example.org>`, with the display name quoted and escaped.
 *
 * SES encodes a non-ASCII display name itself (RFC 2047) when it builds the message from Simple content,
 * so only the quoting is done here.
 */
export function formatFromAddress(name: string, address: string): string {
  const cleaned = name.replace(/[\r\n]/g, " ").trim();
  if (cleaned.length === 0) return address;
  return `"${cleaned.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${address}>`;
}

/** The SendEmail request for one message. Exported so the tests can see the headers exactly as sent. */
export function buildSendEmailInput(env: SesEnv, message: NewsletterMessage): SendEmailCommandInput {
  return {
    FromEmailAddress: formatFromAddress(env.fromName, env.fromAddress),
    Destination: { ToAddresses: [message.to] },
    ConfigurationSetName: env.configurationSet,
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: message.bodyText, Charset: "UTF-8" },
          ...(message.bodyHtml ? { Html: { Data: message.bodyHtml, Charset: "UTF-8" } } : {})
        },
        ...(message.headers.length > 0
          ? { Headers: message.headers.map((header) => ({ Name: header.name, Value: header.value })) }
          : {})
      }
    },
    // A tag per message kind, so SES's own metrics and any event destination can split transactional
    // mail from issues without anybody reading an address.
    EmailTags: [{ Name: "kind", Value: message.kind.toLowerCase() }]
  };
}

/** The minimal client surface the adapter uses, so the tests can hand it a fake. */
export interface SesClientLike {
  send(command: SendEmailCommand | GetAccountCommand): Promise<unknown>;
}

export function createSesMailer(env: SesEnv, client?: SesClientLike): NewsletterMailer {
  const ses: SesClientLike =
    client ??
    new SESv2Client({
      region: env.region,
      credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
      // Two attempts inside the SDK for a blip; anything longer is the outbox's backoff, which can wait
      // minutes rather than holding a request open.
      maxAttempts: 2
    });

  return {
    name: "Amazon SES",

    async send(message) {
      try {
        const result = (await ses.send(new SendEmailCommand(buildSendEmailInput(env, message)))) as {
          MessageId?: string;
        };
        return { providerMessageId: result.MessageId ?? null };
      } catch (error) {
        throw classifySesError(error);
      }
    },

    async quota(): Promise<SendQuota | null> {
      try {
        const account = (await ses.send(new GetAccountCommand({}))) as {
          SendQuota?: { MaxSendRate?: number; Max24HourSend?: number; SentLast24Hours?: number };
          SendingEnabled?: boolean;
        };
        const quota = account.SendQuota;
        if (!quota) return null;
        return {
          maxPerSecond: typeof quota.MaxSendRate === "number" && quota.MaxSendRate > 0 ? quota.MaxSendRate : 1,
          remainingToday:
            typeof quota.Max24HourSend === "number" && quota.Max24HourSend >= 0
              ? Math.max(0, quota.Max24HourSend - (quota.SentLast24Hours ?? 0))
              : null,
          sendingEnabled: account.SendingEnabled !== false
        };
      } catch (error) {
        // Not fatal: the drain falls back to a conservative rate. Logged by name only.
        const classified = classifySesError(error);
        console.warn(`[newsletter] could not read the SES sending quota (${classified.code}).`);
        return null;
      }
    }
  };
}
