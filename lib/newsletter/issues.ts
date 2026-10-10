import "server-only";

import type { NewsletterIssueStatus, NewsletterMailState, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { siteName, siteUrl } from "@/lib/env";
import { parseRichText } from "@/lib/richtext";
import { deliverNewsletterMail, type DeliveryOutcome, type NewsletterMessage } from "@/lib/newsletter/delivery";
import {
  personaliseIssueEmail,
  renderIssueEmail,
  type RenderedIssueEmail
} from "@/lib/newsletter/email-layout";
import { richTextToEmailHtml, richTextToEmailText } from "@/lib/newsletter/email-richtext";
import { listUnsubscribeHeaders } from "@/lib/newsletter/list-unsubscribe";
import { mailableSubscriberWhere } from "@/lib/newsletter/subscribers";
import { oneClickUnsubscribeUrlFor, unsubscribeUrlFor } from "@/lib/newsletter/tokens";

/**
 * Newsletter issues: rendering one, queueing it for every confirmed subscriber, cancelling it, and keeping
 * its counts. The drain (lib/newsletter/drain.ts) does the sending.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ██  QUEUEING IS IDEMPOTENT TWICE OVER, AND BOTH HALVES ARE NEEDED.  ██
 *
 *   1. **The issue's status moves DRAFT/SCHEDULED → SENDING in a guarded `updateMany`.** Two requests
 *      (a double click, two editors, the scheduler racing a manual send) both run it; Postgres serialises
 *      them on the row lock, the second re-checks the `where` after the first commits, finds SENDING, and
 *      updates nothing. Only the request that moved the status inserts rows.
 *   2. **`(issueId, subscriberId)` is UNIQUE in the outbox, and the insert skips duplicates.** So even a
 *      code path that bypassed step 1 could not put a second copy of an issue in anybody's queue.
 *
 * ⚠ THE AUDIENCE IS `mailableSubscriberWhere()` AND NOTHING ELSE — CONFIRMED, not erased, not bounced, not
 * complained. It is taken at the moment of sending: somebody who confirms afterwards is not added, and
 * somebody who leaves afterwards is suppressed by the drain when it reaches their row.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const ISSUE_TITLE_MAX = 160;
export const ISSUE_SUBJECT_MAX = 150;
export const ISSUE_PREHEADER_MAX = 200;

/** The states an issue can be edited in. Once queued, the words are what was sent. */
export const EDITABLE_ISSUE_STATUSES: readonly NewsletterIssueStatus[] = ["DRAFT", "SCHEDULED"];

export const ISSUE_STATUS_LABELS: Record<NewsletterIssueStatus, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  SENDING: "Sending",
  SENT: "Sent",
  CANCELLED: "Cancelled"
};

export const ISSUE_STATUS_TONES: Record<NewsletterIssueStatus, "neutral" | "info" | "warn" | "success"> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  SENDING: "warn",
  SENT: "success",
  CANCELLED: "neutral"
};

interface IssueContent {
  id: string;
  title: string;
  subject: string;
  preheader: string | null;
  body: Prisma.JsonValue | null;
}

/** The issue rendered once — HTML and text, with the unsubscribe URL still a placeholder. */
export function renderIssue(issue: IssueContent, options: { isTest?: boolean } = {}): RenderedIssueEmail {
  const origin = siteUrl();
  const doc = parseRichText(issue.body);
  return renderIssueEmail({
    title: issue.title,
    preheader: issue.preheader,
    bodyHtml: richTextToEmailHtml(doc, { siteOrigin: origin }),
    bodyText: richTextToEmailText(doc, { siteOrigin: origin }),
    siteName: siteName(),
    siteOrigin: origin,
    isTest: options.isTest
  });
}

/** One recipient's copy of a rendered issue. */
export function composeIssueMessage(
  rendered: RenderedIssueEmail,
  issue: { subject: string },
  recipient: { to: string; emailKey: string; subscriberId: string | null },
  kind: "ISSUE" | "ISSUE_TEST"
): NewsletterMessage {
  // The visible link opens the unsubscribe PAGE (a person confirms with a button); the header carries the
  // one-click endpoint a mail client POSTs to. Both are the same signed, non-expiring token.
  const personal = personaliseIssueEmail(rendered, unsubscribeUrlFor(recipient.emailKey));
  return {
    to: recipient.to,
    emailKey: recipient.emailKey,
    subscriberId: recipient.subscriberId,
    kind,
    subject: kind === "ISSUE_TEST" ? `[Test] ${issue.subject}` : issue.subject,
    bodyText: personal.text,
    bodyHtml: personal.html,
    headers: listUnsubscribeHeaders(oneClickUnsubscribeUrlFor(recipient.emailKey)),
    actionUrl: null
  };
}

/** How many people a send would go to right now. */
export function countIssueAudience(): Promise<number> {
  return prisma.newsletterSubscriber.count({ where: mailableSubscriberWhere() });
}

/** Rows are inserted in slices this size, so one statement never carries an unbounded parameter list. */
const ENQUEUE_SLICE = 1000;

export type EnqueueOutcome =
  | { queued: true; recipients: number }
  /** Somebody else already queued it, or it is no longer a draft or scheduled. */
  | { queued: false; status: NewsletterIssueStatus | null };

/**
 * Queue an issue for every mailable subscriber. Safe to call any number of times — see the header.
 *
 * `allowFrom` says which statuses may be queued from: a manual send accepts DRAFT and SCHEDULED, the
 * scheduler accepts SCHEDULED only (so a schedule withdrawn a moment ago is not sent anyway).
 */
export async function enqueueIssue(
  issueId: string,
  actorId: string | null,
  allowFrom: readonly NewsletterIssueStatus[] = ["DRAFT", "SCHEDULED"]
): Promise<EnqueueOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const issue = await tx.newsletterIssue.findUnique({
        where: { id: issueId },
        select: { id: true, subject: true, status: true, deletedAt: true }
      });
      if (!issue || issue.deletedAt) return { queued: false, status: null } as const;

      const now = new Date();
      const moved = await tx.newsletterIssue.updateMany({
        where: { id: issueId, deletedAt: null, status: { in: [...allowFrom] } },
        data: { status: "SENDING", sendStartedAt: now, sentById: actorId, cancelledAt: null }
      });
      if (moved.count === 0) {
        const current = await tx.newsletterIssue.findUnique({ where: { id: issueId }, select: { status: true } });
        return { queued: false, status: current?.status ?? null } as const;
      }

      const audience = await tx.newsletterSubscriber.findMany({
        where: mailableSubscriberWhere(),
        select: { id: true, emailKey: true },
        orderBy: { id: "asc" }
      });

      let inserted = 0;
      for (let start = 0; start < audience.length; start += ENQUEUE_SLICE) {
        const slice = audience.slice(start, start + ENQUEUE_SLICE);
        const result = await tx.newsletterDelivery.createMany({
          data: slice.map((subscriber) => ({
            subscriberId: subscriber.id,
            emailKey: subscriber.emailKey,
            kind: "ISSUE" as const,
            state: "RECORDED" as const,
            subject: issue.subject,
            issueId
          })),
          // ON CONFLICT DO NOTHING on (issueId, subscriberId) — the second idempotency guard.
          skipDuplicates: true
        });
        inserted += result.count;
      }

      await tx.newsletterIssue.update({
        where: { id: issueId },
        data: {
          recipientCount: inserted,
          sentCount: 0,
          failedCount: 0,
          suppressedCount: 0,
          // An issue with nobody to send to is finished the moment it starts.
          ...(inserted === 0 ? { status: "SENT" as const, sentAt: now } : {})
        }
      });

      return { queued: true, recipients: inserted } as const;
    },
    // A large list is thousands of inserts; the default five-second interactive timeout is too short.
    { timeout: 60_000, maxWait: 10_000 }
  );
}

/**
 * Stop an issue that is sending (or withdraw one that is scheduled). Rows already sent stay sent; rows
 * still waiting are marked CANCELLED. Returns false when there was nothing to cancel.
 */
export async function cancelIssue(issueId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const moved = await tx.newsletterIssue.updateMany({
      where: { id: issueId, deletedAt: null, status: { in: ["SENDING", "SCHEDULED"] } },
      data: { status: "CANCELLED", cancelledAt: new Date() }
    });
    if (moved.count === 0) return false;
    await tx.newsletterDelivery.updateMany({
      where: { issueId, kind: "ISSUE", state: "RECORDED" },
      data: { state: "CANCELLED", error: "The issue was cancelled before this was sent." }
    });
    return true;
  });
}

export interface IssueDeliveryCounts {
  /** Waiting in the queue, or being handed to the provider right now. */
  queued: number;
  sent: number;
  failed: number;
  suppressed: number;
  cancelled: number;
  total: number;
}

/** Live counts for one issue, from the outbox. Test copies are not counted. */
export async function issueDeliveryCounts(issueId: string): Promise<IssueDeliveryCounts> {
  const groups = await prisma.newsletterDelivery.groupBy({
    by: ["state"],
    where: { issueId, kind: "ISSUE" },
    _count: true
  });
  const by = (states: NewsletterMailState[]) =>
    groups.filter((group) => states.includes(group.state)).reduce((sum, group) => sum + group._count, 0);
  return {
    queued: by(["RECORDED", "SENDING"]),
    sent: by(["SENT"]),
    failed: by(["FAILED"]),
    suppressed: by(["SUPPRESSED"]),
    cancelled: by(["CANCELLED"]),
    total: by(["RECORDED", "SENDING", "SENT", "FAILED", "SUPPRESSED", "CANCELLED"])
  };
}

/**
 * Copy the live counts onto the issue, and mark it SENT once nothing is left waiting.
 *
 * The SENT transition is guarded on SENDING, so a cancellation that lands in between wins.
 */
export async function refreshIssue(issueId: string): Promise<void> {
  const counts = await issueDeliveryCounts(issueId);
  await prisma.newsletterIssue.update({
    where: { id: issueId },
    data: { sentCount: counts.sent, failedCount: counts.failed, suppressedCount: counts.suppressed }
  });
  if (counts.queued === 0) {
    await prisma.newsletterIssue.updateMany({
      where: { id: issueId, status: "SENDING" },
      data: { status: "SENT", sentAt: new Date() }
    });
  }
}

/** Every issue still SENDING — refreshed by the drain after each batch. */
export async function refreshSendingIssues(): Promise<number> {
  const sending = await prisma.newsletterIssue.findMany({
    where: { status: "SENDING", deletedAt: null },
    select: { id: true }
  });
  for (const issue of sending) await refreshIssue(issue.id);
  return sending.length;
}

/** Queue every SCHEDULED issue whose time has come. Returns how many were queued by this call. */
export async function enqueueDueIssues(now: Date = new Date()): Promise<number> {
  const due = await prisma.newsletterIssue.findMany({
    where: { status: "SCHEDULED", deletedAt: null, scheduledAt: { lte: now } },
    select: { id: true, sentById: true }
  });
  let queued = 0;
  for (const issue of due) {
    const outcome = await enqueueIssue(issue.id, issue.sentById, ["SCHEDULED"]);
    if (outcome.queued) queued += 1;
  }
  return queued;
}

/**
 * Send one copy of an issue to a member of staff, now.
 *
 * Recorded in the outbox as ISSUE_TEST with no subscriber, so it never counts towards the issue's figures
 * and never touches the idempotency key.
 */
export async function sendIssueTest(
  issue: IssueContent,
  recipient: { email: string; emailKey: string }
): Promise<DeliveryOutcome> {
  const rendered = renderIssue(issue, { isTest: true });
  const message = composeIssueMessage(
    rendered,
    issue,
    { to: recipient.email, emailKey: recipient.emailKey, subscriberId: null },
    "ISSUE_TEST"
  );
  return deliverNewsletterMail(message, { issueId: issue.id });
}
