/**
 * What a failed send MEANS for the message, decided once by the provider adapter and obeyed by the
 * outbox (lib/newsletter/outbox.ts).
 *
 * Three dispositions, because there are three different right answers:
 *
 *   • `retry`  — the provider is busy or broken right now (throttling, a 5xx, a dropped connection).
 *                The row goes back to the queue with a backoff, and the attempt counts towards the cap.
 *   • `reject` — the provider looked at THIS message and refused it (a malformed address, a rejected
 *                message). Sending it again would be refused again, so the row is FAILED at once.
 *   • `halt`   — nothing can be sent by anybody until a person fixes something: bad credentials, an
 *                unverified sender, sending paused on the account. The row goes back to the queue
 *                WITHOUT the attempt counting, and the drain stops the batch — burning a thousand rows'
 *                attempts on a revoked key would turn one configuration mistake into a lost mailing.
 *
 * No dependency and no `server-only`: the tests import it directly.
 */

export type SendDisposition = "retry" | "reject" | "halt";

export class MailSendError extends Error {
  readonly disposition: SendDisposition;
  /** The provider's own error name, e.g. `TooManyRequestsException`. Safe to log; carries no address. */
  readonly code: string;

  constructor(disposition: SendDisposition, code: string, message: string) {
    super(message);
    this.name = "MailSendError";
    this.disposition = disposition;
    this.code = code;
  }
}

/**
 * The disposition of anything a mailer threw.
 *
 * An error that is not a `MailSendError` is a bug or an unexpected transport failure, and is retried:
 * the attempt cap stops it looping for ever, and a transient fault is not turned into a lost message.
 */
export function dispositionOf(error: unknown): SendDisposition {
  return error instanceof MailSendError ? error.disposition : "retry";
}

/** A one-line description for the outbox's `error` column and the log. Never includes an address. */
export function describeSendError(error: unknown): string {
  if (error instanceof MailSendError) return `${error.code}: ${error.message}`.slice(0, 1000);
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1000);
  return String(error).slice(0, 1000);
}
