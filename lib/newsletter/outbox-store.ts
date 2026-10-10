import "server-only";

import { randomBytes } from "node:crypto";
import { Prisma, type NewsletterMailKind } from "@prisma/client";

import { prisma } from "@/lib/db";
import type { SendDisposition } from "@/lib/newsletter/mail-errors";

/**
 * The outbox's state machine, as database writes — the ONLY code that moves a `newsletter_deliveries`
 * row between states.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LIFE OF ONE ROW
 *
 *     RECORDED ──claim──▶ SENDING ──▶ SENT
 *        ▲                  │  ├────▶ FAILED      (rejected, or out of attempts)
 *        │                  │  └────▶ SUPPRESSED  (nobody to send it to any more)
 *        └──retry/halt──────┘
 *        └──stale claim released (the run that claimed it died)
 *     RECORDED ──issue cancelled──▶ CANCELLED
 *
 * ⚠ EVERY TRANSITION OUT OF SENDING IS GUARDED BY THE CLAIM TOKEN. A run that stalls past the stale
 * window has its rows released and re-claimed by a later run; if the first run then wakes up and settles
 * its rows, the token no longer matches and its write is a no-op. Without the guard, the slow run would
 * mark FAILED a row the fast run had already SENT.
 *
 * ⚠ AT-LEAST-ONCE, NOT EXACTLY-ONCE, AND THE GAP IS STATED. A process that dies AFTER the provider
 * accepted a message and BEFORE `markSent` committed leaves the row SENDING; the stale release puts it
 * back in the queue and it is sent again. The window is one HTTP round trip, the alternative (never
 * retrying a stale claim) loses messages outright, and the attempt cap bounds the worst case.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** A row reaching this many attempts is FAILED rather than retried. */
export const MAX_SEND_ATTEMPTS = 5;

/** A SENDING row older than this belongs to a run that died, and is released. */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

/** How long a halted row (credentials, paused account) waits before anybody tries again. */
export const HALT_PAUSE_MS = 5 * 60 * 1000;

const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * The wait before attempt `attempts + 1`, after `attempts` have failed: 1, 2, 4, 8 minutes … capped at
 * six hours. Deterministic on purpose — the drain is invoked minutes apart, so jitter would buy nothing
 * and would make the tests guess.
 */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
}

/** A fresh claim token: which run holds a row. */
export function newClaimToken(): string {
  return randomBytes(12).toString("hex");
}

export interface ClaimedRow {
  id: string;
  kind: NewsletterMailKind;
  emailKey: string;
  subscriberId: string | null;
  issueId: string | null;
  /** INCLUDING the attempt this claim is for. */
  attempts: number;
  createdAt: Date;
}

/**
 * Claim up to `limit` due rows for one run, atomically.
 *
 * ⚠ `FOR UPDATE SKIP LOCKED` IS WHAT MAKES CONCURRENT RUNS SAFE. Two drains started together (the GitHub
 * schedule and Vercel's fallback cron, or a studio "Send" that kicks a batch while a scheduled run is
 * mid-flight) each lock a disjoint set of rows; neither waits for the other and no row is claimed twice.
 * The select and the update are one statement, so there is no window between choosing a row and owning it.
 *
 * Transactional messages go first: a confirmation link is useless an hour late, a newsletter is not.
 */
export async function claimDueRows(limit: number, token: string): Promise<ClaimedRow[]> {
  if (limit <= 0) return [];
  return prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
    WITH picked AS (
      SELECT id
      FROM newsletter_deliveries
      WHERE state = 'RECORDED'::"NewsletterMailState"
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
      ORDER BY (kind = 'ISSUE'::"NewsletterMailKind") ASC, "createdAt" ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE newsletter_deliveries AS d
    SET state = 'SENDING'::"NewsletterMailState",
        "claimedAt" = now(),
        "claimToken" = ${token},
        attempts = d.attempts + 1
    FROM picked
    WHERE d.id = picked.id
    RETURNING d.id, d.kind, d."emailKey", d."subscriberId", d."issueId", d.attempts, d."createdAt"
  `);
}

/**
 * Put back every claim older than the stale window.
 *
 * A row that has already used its last attempt is FAILED rather than released, so a message whose send
 * reliably kills the process (an enormous body, a provider that hangs) cannot loop for ever.
 */
export async function releaseStaleClaims(now: Date = new Date()): Promise<{ released: number; abandoned: number }> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);

  const abandoned = await prisma.newsletterDelivery.updateMany({
    where: { state: "SENDING", claimedAt: { lt: cutoff }, attempts: { gte: MAX_SEND_ATTEMPTS } },
    data: {
      state: "FAILED",
      claimToken: null,
      claimedAt: null,
      error: "The send did not finish after the maximum number of attempts, so it was given up."
    }
  });

  const released = await prisma.newsletterDelivery.updateMany({
    where: { state: "SENDING", claimedAt: { lt: cutoff } },
    data: { state: "RECORDED", claimToken: null, claimedAt: null, nextAttemptAt: now }
  });

  return { released: released.count, abandoned: abandoned.count };
}

/** Guard every settle on the claim, so a slow run cannot overwrite a fast one. See the header. */
function claimed(id: string, token: string): Prisma.NewsletterDeliveryWhereInput {
  return { id, claimToken: token, state: "SENDING" };
}

export async function markSent(
  id: string,
  token: string,
  provider: string,
  providerMessageId: string | null
): Promise<boolean> {
  const result = await prisma.newsletterDelivery.updateMany({
    where: claimed(id, token),
    data: {
      state: "SENT",
      provider,
      providerMessageId,
      sentAt: new Date(),
      error: null,
      claimToken: null,
      claimedAt: null,
      nextAttemptAt: null
    }
  });
  return result.count === 1;
}

/** Not sent, on purpose — the recipient can no longer be written to. */
export async function markSuppressed(id: string, token: string, reason: string): Promise<boolean> {
  const result = await prisma.newsletterDelivery.updateMany({
    where: claimed(id, token),
    data: { state: "SUPPRESSED", error: reason.slice(0, 1000), claimToken: null, claimedAt: null }
  });
  return result.count === 1;
}

/**
 * A failed attempt, settled by its disposition (lib/newsletter/mail-errors.ts).
 *
 * Returns the state the row ended in, so the caller can count it.
 */
export async function markAttemptFailed(input: {
  id: string;
  token: string;
  provider: string;
  /** The row's attempt count INCLUDING this one. */
  attempts: number;
  disposition: SendDisposition;
  error: string;
  now?: Date;
}): Promise<"RECORDED" | "FAILED" | null> {
  const now = input.now ?? new Date();
  const error = input.error.slice(0, 1000);

  if (input.disposition === "halt") {
    // Not the message's fault: the attempt is handed back so a configuration mistake cannot exhaust it.
    const result = await prisma.newsletterDelivery.updateMany({
      where: claimed(input.id, input.token),
      data: {
        state: "RECORDED",
        provider: input.provider,
        error,
        attempts: { decrement: 1 },
        nextAttemptAt: new Date(now.getTime() + HALT_PAUSE_MS),
        claimToken: null,
        claimedAt: null
      }
    });
    return result.count === 1 ? "RECORDED" : null;
  }

  const final = input.disposition === "reject" || input.attempts >= MAX_SEND_ATTEMPTS;
  const result = await prisma.newsletterDelivery.updateMany({
    where: claimed(input.id, input.token),
    data: final
      ? { state: "FAILED", provider: input.provider, error, claimToken: null, claimedAt: null, nextAttemptAt: null }
      : {
          state: "RECORDED",
          provider: input.provider,
          error,
          nextAttemptAt: new Date(now.getTime() + backoffMs(input.attempts)),
          claimToken: null,
          claimedAt: null
        }
  });
  if (result.count !== 1) return null;
  return final ? "FAILED" : "RECORDED";
}

/**
 * Hand back rows this run claimed and never attempted (its time budget ran out, or a halt stopped it).
 * The attempt the claim counted is returned with them, because no attempt was made.
 */
export async function releaseUnattempted(ids: readonly string[], token: string): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await prisma.newsletterDelivery.updateMany({
    where: { id: { in: [...ids] }, claimToken: token, state: "SENDING" },
    data: { state: "RECORDED", claimToken: null, claimedAt: null, attempts: { decrement: 1 } }
  });
  return result.count;
}

/**
 * Write a transactional row ALREADY CLAIMED by the request that is about to send it inline.
 *
 * ⚠ CREATED AS SENDING, NEVER AS RECORDED-THEN-CLAIMED. A RECORDED row is visible to the drain from the
 * moment it commits, and a drain running at that instant would claim it and send it while this request
 * was sending it too — two confirmation emails. Created SENDING with this request's token, the drain
 * cannot touch it unless this request dies and the claim goes stale, which is exactly when it should.
 */
export async function createClaimedRow(input: {
  subscriberId: string | null;
  emailKey: string;
  kind: NewsletterMailKind;
  subject: string;
  issueId?: string | null;
  token: string;
}): Promise<{ id: string; attempts: number }> {
  const row = await prisma.newsletterDelivery.create({
    data: {
      subscriberId: input.subscriberId,
      emailKey: input.emailKey,
      kind: input.kind,
      subject: input.subject,
      issueId: input.issueId ?? null,
      state: "SENDING",
      claimToken: input.token,
      claimedAt: new Date(),
      attempts: 1
    },
    select: { id: true, attempts: true }
  });
  return row;
}
