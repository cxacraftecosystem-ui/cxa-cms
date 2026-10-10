import { hasDatabase } from "./setup";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { setNewsletterMailer, type NewsletterMailer, type NewsletterMessage } from "@/lib/newsletter/delivery";
import { drainOutbox } from "@/lib/newsletter/drain";
import { applySesFeedback } from "@/lib/newsletter/feedback";
import { cancelIssue, enqueueIssue } from "@/lib/newsletter/issues";
import { MailSendError } from "@/lib/newsletter/mail-errors";
import {
  MAX_SEND_ATTEMPTS,
  STALE_CLAIM_MS,
  claimDueRows,
  markAttemptFailed,
  markSent,
  newClaimToken,
  releaseStaleClaims
} from "@/lib/newsletter/outbox-store";
import { mailableSubscriberWhere } from "@/lib/newsletter/subscribers";
import { oneClickUnsubscribeUrlFor } from "@/lib/newsletter/tokens";

/**
 * The outbox against a real PostgreSQL: idempotent queueing, atomic claims, stale-claim release, the
 * attempt cap, the drain end to end with a fake provider, SES feedback, and the one-click endpoint.
 *
 * ⚠ THESE TESTS EMPTY THE THREE NEWSLETTER TABLES, so they refuse to run against anything but a database
 * on this machine (CI's service container, or a local one). The rest of the schema is untouched.
 */

const LOCAL = /@(127\.0\.0\.1|localhost|\[::1\]|postgres)(:\d+)?\//.test(process.env.DATABASE_URL ?? "");
const skip = !hasDatabase ? "no DATABASE_URL" : !LOCAL ? "DATABASE_URL is not a local database" : false;

const BODY = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello from the Centre." }] }]
};

async function emptyNewsletterTables() {
  await prisma.newsletterDelivery.deleteMany({});
  await prisma.newsletterIssue.deleteMany({});
  await prisma.newsletterSubscriber.deleteMany({});
}

let counter = 0;
async function subscriber(
  status: "PENDING" | "CONFIRMED" | "UNSUBSCRIBED" = "CONFIRMED",
  extra: { bouncedAt?: Date; complainedAt?: Date } = {}
) {
  counter += 1;
  const emailKey = `reader${counter}-${Date.now()}@example.org`;
  return prisma.newsletterSubscriber.create({
    data: {
      email: emailKey,
      emailKey,
      status,
      consentText: "test",
      consentVersion: "2026-08-14",
      consentAt: new Date(),
      ...extra
    }
  });
}

async function issue() {
  return prisma.newsletterIssue.create({ data: { title: "Autumn", subject: "Autumn issue", body: BODY } });
}

/** A provider that records what it was given and can be told to fail for particular addresses. */
function fakeMailer(failFor: Map<string, MailSendError> = new Map()) {
  const sent: NewsletterMessage[] = [];
  const mailer: NewsletterMailer = {
    name: "Test provider",
    async send(message) {
      const failure = failFor.get(message.emailKey);
      if (failure) throw failure;
      sent.push(message);
      return { providerMessageId: `msg-${sent.length}` };
    },
    async quota() {
      return { maxPerSecond: 200, remainingToday: null, sendingEnabled: true };
    }
  };
  return { mailer, sent };
}

describe("newsletter outbox (database)", { skip }, () => {
  before(emptyNewsletterTables);
  after(async () => {
    setNewsletterMailer(null);
    await emptyNewsletterTables();
    await prisma.$disconnect();
  });

  it("queues an issue exactly once, to mailable subscribers only, however many times Send is pressed", async () => {
    await emptyNewsletterTables();
    const confirmed = [await subscriber(), await subscriber(), await subscriber()];
    await subscriber("PENDING");
    await subscriber("UNSUBSCRIBED");
    await subscriber("CONFIRMED", { bouncedAt: new Date() });
    await subscriber("CONFIRMED", { complainedAt: new Date() });
    const draft = await issue();

    // A double click: two requests at once.
    const outcomes = await Promise.all([enqueueIssue(draft.id, null), enqueueIssue(draft.id, null)]);
    assert.equal(outcomes.filter((outcome) => outcome.queued).length, 1);

    const rows = await prisma.newsletterDelivery.findMany({ where: { issueId: draft.id } });
    assert.equal(rows.length, confirmed.length);
    assert.equal(await prisma.newsletterSubscriber.count({ where: mailableSubscriberWhere() }), confirmed.length);
    assert.deepEqual(new Set(rows.map((row) => row.subscriberId)), new Set(confirmed.map((row) => row.id)));

    // A third press later, and a direct duplicate insert, both change nothing.
    const again = await enqueueIssue(draft.id, null);
    assert.equal(again.queued, false);
    const duplicate = await prisma.newsletterDelivery.createMany({
      data: confirmed.map((row) => ({
        subscriberId: row.id,
        emailKey: row.emailKey,
        kind: "ISSUE" as const,
        subject: "dup",
        issueId: draft.id
      })),
      skipDuplicates: true
    });
    assert.equal(duplicate.count, 0);

    const queued = await prisma.newsletterIssue.findUniqueOrThrow({ where: { id: draft.id } });
    assert.equal(queued.status, "SENDING");
    assert.equal(queued.recipientCount, confirmed.length);
  });

  it("claims rows atomically: two concurrent runs never share a row", async () => {
    await emptyNewsletterTables();
    const reader = await subscriber();
    await prisma.newsletterDelivery.createMany({
      data: Array.from({ length: 12 }, () => ({
        subscriberId: reader.id,
        emailKey: reader.emailKey,
        kind: "WELCOME" as const,
        subject: "Welcome"
      }))
    });

    const [first, second] = await Promise.all([claimDueRows(7, newClaimToken()), claimDueRows(7, newClaimToken())]);
    const ids = [...first, ...second].map((row) => row.id);
    assert.equal(ids.length, 12);
    assert.equal(new Set(ids).size, 12);
    assert.ok([...first, ...second].every((row) => row.attempts === 1));
    assert.equal(await prisma.newsletterDelivery.count({ where: { state: "SENDING" } }), 12);
    assert.equal((await claimDueRows(5, newClaimToken())).length, 0);
  });

  it("settles only under the claim that holds the row, and releases stale claims", async () => {
    await emptyNewsletterTables();
    const reader = await subscriber();
    await prisma.newsletterDelivery.createMany({
      data: Array.from({ length: 3 }, () => ({
        subscriberId: reader.id,
        emailKey: reader.emailKey,
        kind: "WELCOME" as const,
        subject: "Welcome"
      }))
    });
    const token = newClaimToken();
    const claimed = await claimDueRows(3, token);
    const [a, b, c] = claimed;
    assert.ok(a && b && c);

    // A different run's token cannot settle the row.
    assert.equal(await markSent(a.id, newClaimToken(), "Test", null), false);
    assert.equal(await markSent(a.id, token, "Test", "m-1"), true);

    // Make the other two look like they belong to a run that died, one of them out of attempts.
    const longAgo = new Date(Date.now() - STALE_CLAIM_MS - 60_000);
    await prisma.newsletterDelivery.update({ where: { id: b.id }, data: { claimedAt: longAgo } });
    await prisma.newsletterDelivery.update({
      where: { id: c.id },
      data: { claimedAt: longAgo, attempts: MAX_SEND_ATTEMPTS }
    });

    const released = await releaseStaleClaims();
    assert.deepEqual(released, { released: 1, abandoned: 1 });
    const after = await prisma.newsletterDelivery.findMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    const state = Object.fromEntries(after.map((row) => [row.id, row.state]));
    assert.equal(state[a.id], "SENT");
    assert.equal(state[b.id], "RECORDED");
    assert.equal(state[c.id], "FAILED");

    // The slow run waking up later cannot overwrite what happened since.
    assert.equal(await markSent(b.id, token, "Test", null), false);
  });

  it("backs off on retry, fails at once on reject, returns the attempt on halt, and caps attempts", async () => {
    await emptyNewsletterTables();
    const reader = await subscriber();
    const make = () =>
      prisma.newsletterDelivery.create({
        data: { subscriberId: reader.id, emailKey: reader.emailKey, kind: "WELCOME", subject: "Welcome" }
      });
    await make();
    await make();
    await make();
    await make();
    const token = newClaimToken();
    const [retry, reject, halt, capped] = await claimDueRows(4, token);
    assert.ok(retry && reject && halt && capped);

    assert.equal(
      await markAttemptFailed({ id: retry.id, token, provider: "Test", attempts: 1, disposition: "retry", error: "429" }),
      "RECORDED"
    );
    assert.equal(
      await markAttemptFailed({ id: reject.id, token, provider: "Test", attempts: 1, disposition: "reject", error: "bad" }),
      "FAILED"
    );
    assert.equal(
      await markAttemptFailed({ id: halt.id, token, provider: "Test", attempts: 1, disposition: "halt", error: "creds" }),
      "RECORDED"
    );
    assert.equal(
      await markAttemptFailed({
        id: capped.id,
        token,
        provider: "Test",
        attempts: MAX_SEND_ATTEMPTS,
        disposition: "retry",
        error: "503"
      }),
      "FAILED"
    );

    const retried = await prisma.newsletterDelivery.findUniqueOrThrow({ where: { id: retry.id } });
    assert.ok(retried.nextAttemptAt && retried.nextAttemptAt.getTime() > Date.now());
    const halted = await prisma.newsletterDelivery.findUniqueOrThrow({ where: { id: halt.id } });
    assert.equal(halted.attempts, 0);
    // Neither is due yet, so a run straight after claims nothing.
    assert.equal((await claimDueRows(10, newClaimToken())).length, 0);
  });

  it("drains an issue at the provider's pace, suppressing anybody who left before their copy went", async () => {
    await emptyNewsletterTables();
    const readers = [await subscriber(), await subscriber(), await subscriber(), await subscriber()];
    const draft = await issue();
    await enqueueIssue(draft.id, null);

    // One leaves after the send was queued; one address is throttled by the provider.
    await prisma.newsletterSubscriber.update({
      where: { id: readers[0]!.id },
      data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() }
    });
    const throttled = readers[1]!.emailKey;
    const { mailer, sent } = fakeMailer(
      new Map([[throttled, new MailSendError("retry", "TooManyRequestsException", "slow down")]])
    );
    setNewsletterMailer(mailer);

    const result = await drainOutbox({ budgetMs: 20_000 });
    assert.equal(result.claimed, 4);
    assert.equal(result.sent, 2);
    assert.equal(result.suppressed, 1);
    assert.equal(result.requeued, 1);

    for (const message of sent) {
      assert.equal(message.kind, "ISSUE");
      assert.ok(message.bodyHtml?.includes("Hello from the Centre."));
      assert.ok(message.headers.some((header) => header.name === "List-Unsubscribe-Post"));
    }

    let current = await prisma.newsletterIssue.findUniqueOrThrow({ where: { id: draft.id } });
    assert.equal(current.status, "SENDING");
    assert.equal(current.sentCount, 2);
    assert.equal(current.suppressedCount, 1);

    // Cancelling stops the copy still waiting; the issue's figures say so.
    assert.equal(await cancelIssue(draft.id), true);
    const waiting = await prisma.newsletterDelivery.findFirstOrThrow({ where: { issueId: draft.id, emailKey: throttled } });
    assert.equal(waiting.state, "CANCELLED");
    current = await prisma.newsletterIssue.findUniqueOrThrow({ where: { id: draft.id } });
    assert.equal(current.status, "CANCELLED");
  });

  it("marks an issue SENT once nothing is left in its queue", async () => {
    await emptyNewsletterTables();
    await subscriber();
    await subscriber();
    const draft = await issue();
    await enqueueIssue(draft.id, null);
    const { mailer, sent } = fakeMailer();
    setNewsletterMailer(mailer);
    await drainOutbox({ budgetMs: 20_000 });
    assert.equal(sent.length, 2);
    const current = await prisma.newsletterIssue.findUniqueOrThrow({ where: { id: draft.id } });
    assert.equal(current.status, "SENT");
    assert.ok(current.sentAt);
  });

  it("applies SES feedback: a permanent bounce stops mail, a transient one does not, a complaint unsubscribes", async () => {
    await emptyNewsletterTables();
    const bounced = await subscriber();
    const transient = await subscriber();
    const complained = await subscriber();

    const bounce = (type: string, address: string) =>
      JSON.stringify({ notificationType: "Bounce", bounce: { bounceType: type, bouncedRecipients: [{ emailAddress: address }] } });

    assert.deepEqual(await applySesFeedback(bounce("Permanent", bounced.email.toUpperCase())), { kind: "bounce", marked: 1 });
    assert.deepEqual(await applySesFeedback(bounce("Transient", transient.email)), { kind: "ignored", marked: 0 });
    assert.deepEqual(
      await applySesFeedback(
        JSON.stringify({ eventType: "Complaint", complaint: { complainedRecipients: [{ emailAddress: `"Reader" <${complained.email}>` }] } })
      ),
      { kind: "complaint", marked: 1 }
    );

    const rows = await prisma.newsletterSubscriber.findMany({ where: { id: { in: [bounced.id, transient.id, complained.id] } } });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.ok(byId[bounced.id]?.bouncedAt);
    assert.equal(byId[transient.id]?.bouncedAt, null);
    assert.equal(byId[complained.id]?.status, "UNSUBSCRIBED");
    assert.ok(byId[complained.id]?.complainedAt);

    const mailable = await prisma.newsletterSubscriber.findMany({ where: mailableSubscriberWhere(), select: { id: true } });
    assert.deepEqual(mailable.map((row) => row.id), [transient.id]);
  });

  it("one-click: POST unsubscribes at once with no receipt; GET changes nothing; a bad token is refused", async () => {
    await emptyNewsletterTables();
    setNewsletterMailer(fakeMailer().mailer);
    const { GET, POST } = await import("@/app/api/public/newsletter/one-click/route");
    const reader = await subscriber();
    const draft = await issue();
    await enqueueIssue(draft.id, null);

    const url = oneClickUnsubscribeUrlFor(reader.emailKey);

    // A link scanner's GET: redirected to the page, nothing written.
    const scanned = await GET(new NextRequest(url, { method: "GET" }));
    assert.equal(scanned.status, 303);
    assert.ok(scanned.headers.get("location")?.startsWith("/newsletter/unsubscribe?token="));
    assert.equal((await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { id: reader.id } })).status, "CONFIRMED");

    // The mail provider's POST, exactly as RFC 8058 describes it.
    const oneClick = () =>
      POST(
        new NextRequest(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click"
        })
      );
    const response = await oneClick();
    assert.equal(response.status, 200);
    const row = await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { id: reader.id } });
    assert.equal(row.status, "UNSUBSCRIBED");
    assert.ok(row.unsubscribedAt);

    // No receipt was composed, and the queued issue copy is suppressed.
    assert.equal(await prisma.newsletterDelivery.count({ where: { subscriberId: reader.id, kind: "UNSUBSCRIBE_RECEIPT" } }), 0);
    const copy = await prisma.newsletterDelivery.findFirstOrThrow({ where: { subscriberId: reader.id, issueId: draft.id } });
    assert.equal(copy.state, "SUPPRESSED");

    // Again: still a success, and the first unsubscribe date stands.
    assert.equal((await oneClick()).status, 200);
    const again = await prisma.newsletterSubscriber.findUniqueOrThrow({ where: { id: reader.id } });
    assert.equal(again.unsubscribedAt?.getTime(), row.unsubscribedAt?.getTime());

    const forged = await POST(
      new NextRequest(url.replace(/token=[^&]+/, "token=v1.bm9wZQ.0000"), { method: "POST", body: "List-Unsubscribe=One-Click" })
    );
    assert.equal(forged.status, 400);
  });
});
