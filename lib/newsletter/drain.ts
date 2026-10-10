import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  activeNewsletterMailer,
  recomposeTransactional,
  sendClaimed,
  type NewsletterMailer,
  type NewsletterMessage,
  type SendQuota
} from "@/lib/newsletter/delivery";
import type { RenderedIssueEmail } from "@/lib/newsletter/email-layout";
import {
  composeIssueMessage,
  enqueueDueIssues,
  refreshSendingIssues,
  renderIssue
} from "@/lib/newsletter/issues";
import {
  claimDueRows,
  markSuppressed,
  newClaimToken,
  releaseStaleClaims,
  releaseUnattempted,
  type ClaimedRow
} from "@/lib/newsletter/outbox-store";
import { isMailableSubscriber } from "@/lib/newsletter/subscribers";

/**
 * The drain: one bounded batch of the outbox, sent at the provider's pace.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY "A BATCH PER CALL" AND NOT "UNTIL THE QUEUE IS EMPTY"
 *
 * It runs inside a serverless function with a hard time limit, invoked by a GitHub Actions schedule every
 * few minutes (best-effort — GitHub delays and drops scheduled runs), by Vercel's daily cron as a
 * fallback, and once straight after an editor presses Send. Each call does what fits in its time budget
 * and stops; the queue is the state, so the next call carries on exactly where this one left off, and any
 * number of calls may overlap (rows are claimed with `FOR UPDATE SKIP LOCKED`).
 *
 * ══ PACING ══
 *
 * SES enforces a per-second rate (14/s for a typical production account, 1/s in the sandbox) and a daily
 * quota. The drain reads both from the account (`GetAccount`, cached for ten minutes) and spaces its sends
 * so it never exceeds the rate — a throttled send is not lost (it is retried with a backoff), but it is a
 * wasted attempt. With the quota unreadable it assumes one per second, the sandbox rate, which is never
 * wrong, only slow.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DrainOptions {
  /** Stop starting new sends after this long. Default 40 s, inside a 60 s function limit. */
  budgetMs?: number;
  /** Never claim more than this many rows in one call. */
  maxMessages?: number;
}

export interface DrainResult {
  configured: boolean;
  released: number;
  abandoned: number;
  issuesQueued: number;
  claimed: number;
  sent: number;
  failed: number;
  requeued: number;
  suppressed: number;
  unattempted: number;
  halted: string | null;
  ratePerSecond: number;
}

const DEFAULT_BUDGET_MS = 40_000;
const DEFAULT_MAX_MESSAGES = 500;
/** Never more than this many sends in flight, whatever the account's rate. */
const MAX_CONCURRENCY = 10;
const QUOTA_TTL_MS = 10 * 60 * 1000;
const FALLBACK_RATE = 1;

interface QuotaCache {
  at: number;
  quota: SendQuota | null;
}

const globalForQuota = globalThis as unknown as { __cxaNewsletterQuota?: QuotaCache };

async function currentQuota(mailer: NewsletterMailer): Promise<SendQuota | null> {
  const cached = globalForQuota.__cxaNewsletterQuota;
  if (cached && Date.now() - cached.at < QUOTA_TTL_MS) return cached.quota;
  const quota = mailer.quota ? await mailer.quota() : null;
  globalForQuota.__cxaNewsletterQuota = { at: Date.now(), quota };
  return quota;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SUBSCRIBER_SELECT = {
  id: true,
  email: true,
  emailKey: true,
  status: true,
  deletedAt: true,
  bouncedAt: true,
  complainedAt: true
} satisfies Prisma.NewsletterSubscriberSelect;

type SubscriberRow = Prisma.NewsletterSubscriberGetPayload<{ select: typeof SUBSCRIBER_SELECT }>;

type Prepared = { message: NewsletterMessage } | { suppress: string };

export async function drainOutbox(options: DrainOptions = {}): Promise<DrainResult> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const result: DrainResult = {
    configured: false,
    released: 0,
    abandoned: 0,
    issuesQueued: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    requeued: 0,
    suppressed: 0,
    unattempted: 0,
    halted: null,
    ratePerSecond: 0
  };

  const stale = await releaseStaleClaims();
  result.released = stale.released;
  result.abandoned = stale.abandoned;

  // Scheduled issues are queued even with no sender, so the studio shows them as sending and the rows
  // are ready the moment there is one.
  result.issuesQueued = await enqueueDueIssues();

  const mailer = activeNewsletterMailer();
  if (!mailer) {
    await refreshSendingIssues();
    return result;
  }
  result.configured = true;

  const quota = await currentQuota(mailer);
  if (quota && !quota.sendingEnabled) {
    result.halted = "Sending is disabled on the provider account.";
    await refreshSendingIssues();
    return result;
  }
  const rate = Math.max(0.2, quota?.maxPerSecond ?? FALLBACK_RATE);
  result.ratePerSecond = rate;

  const byTime = Math.floor((rate * budgetMs) / 1000);
  const byQuota = quota?.remainingToday ?? Number.POSITIVE_INFINITY;
  const limit = Math.max(0, Math.min(options.maxMessages ?? DEFAULT_MAX_MESSAGES, byTime, byQuota));

  const token = newClaimToken();
  const rows = await claimDueRows(limit, token);
  result.claimed = rows.length;
  if (rows.length === 0) {
    await refreshSendingIssues();
    return result;
  }

  const prepared = await prepareMessages(rows);

  const intervalMs = 1000 / rate;
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.ceil(rate)));
  const inFlight = new Set<Promise<void>>();
  const unattempted: string[] = [];
  let halted = false;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as ClaimedRow;

    if (halted || Date.now() - startedAt > budgetMs) {
      unattempted.push(row.id);
      continue;
    }

    const plan = prepared.get(row.id) ?? { suppress: "The message could not be composed." };
    if ("suppress" in plan) {
      if (await markSuppressed(row.id, token, plan.suppress)) result.suppressed += 1;
      continue;
    }

    // Pace: the n-th send starts no earlier than n intervals after the first.
    const due = startedAt + index * intervalMs;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    while (inFlight.size >= concurrency) await Promise.race(inFlight);

    const task = (async () => {
      const outcome = await sendClaimed(mailer, plan.message, { id: row.id, token, attempts: row.attempts });
      if (outcome === "sent") result.sent += 1;
      else if (outcome === "failed") result.failed += 1;
      else result.requeued += 1;
      if (outcome === "halted") {
        halted = true;
        result.halted = "The provider refused the sender or the credentials; sending has paused.";
      }
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }

  await Promise.all(inFlight);
  result.unattempted = await releaseUnattempted(unattempted, token);

  await refreshSendingIssues();
  return result;
}

/**
 * Compose every claimed row's message, or the reason it must not be sent — one subscriber query and one
 * render per issue for the whole batch, however many rows it holds.
 */
async function prepareMessages(rows: readonly ClaimedRow[]): Promise<Map<string, Prepared>> {
  const plans = new Map<string, Prepared>();

  const issueIds = [...new Set(rows.filter((row) => row.kind === "ISSUE" || row.kind === "ISSUE_TEST").map((row) => row.issueId).filter((id): id is string => Boolean(id)))];
  const issues = issueIds.length
    ? await prisma.newsletterIssue.findMany({
        where: { id: { in: issueIds } },
        select: { id: true, title: true, subject: true, preheader: true, body: true, status: true, deletedAt: true }
      })
    : [];
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  const rendered = new Map<string, RenderedIssueEmail>();
  const renderedTest = new Map<string, RenderedIssueEmail>();

  const subscriberIds = [...new Set(rows.filter((row) => row.kind === "ISSUE").map((row) => row.subscriberId).filter((id): id is string => Boolean(id)))];
  const subscribers = subscriberIds.length
    ? await prisma.newsletterSubscriber.findMany({ where: { id: { in: subscriberIds } }, select: SUBSCRIBER_SELECT })
    : [];
  const subscriberById = new Map<string, SubscriberRow>(subscribers.map((row) => [row.id, row]));

  for (const row of rows) {
    if (row.kind === "ISSUE" || row.kind === "ISSUE_TEST") {
      const issue = row.issueId ? issueById.get(row.issueId) : undefined;
      if (!issue || issue.deletedAt) {
        plans.set(row.id, { suppress: "The issue no longer exists." });
        continue;
      }

      if (row.kind === "ISSUE_TEST") {
        let copy = renderedTest.get(issue.id);
        if (!copy) {
          copy = renderIssue(issue, { isTest: true });
          renderedTest.set(issue.id, copy);
        }
        plans.set(row.id, {
          message: composeIssueMessage(copy, issue, { to: row.emailKey, emailKey: row.emailKey, subscriberId: null }, "ISSUE_TEST")
        });
        continue;
      }

      if (issue.status !== "SENDING") {
        plans.set(row.id, { suppress: "The issue was cancelled before this was sent." });
        continue;
      }
      const subscriber = row.subscriberId ? subscriberById.get(row.subscriberId) : undefined;
      if (!subscriber || !isMailableSubscriber(subscriber)) {
        plans.set(row.id, {
          suppress: "The subscriber unsubscribed, bounced, complained or was erased before this was sent."
        });
        continue;
      }
      let copy = rendered.get(issue.id);
      if (!copy) {
        copy = renderIssue(issue);
        rendered.set(issue.id, copy);
      }
      plans.set(row.id, {
        message: composeIssueMessage(
          copy,
          issue,
          { to: subscriber.email, emailKey: subscriber.emailKey, subscriberId: subscriber.id },
          "ISSUE"
        )
      });
      continue;
    }

    plans.set(row.id, await recomposeTransactional(row));
  }

  return plans;
}
