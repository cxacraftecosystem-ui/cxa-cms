import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect as navigate } from "next/navigation";
import type { Prisma, SubscriberStatus } from "@prisma/client";
import {
  Download,
  MailWarning,
  MailX,
  Search,
  TriangleAlert,
  UserRoundX,
  Users
} from "lucide-react";

import { requireStudioCapability } from "@/lib/auth/current-user";
import { writeAudit, type AuditContext } from "@/lib/audit";
import { prisma } from "@/lib/db";
import {
  NEWSLETTER_SOURCES,
  NEWSLETTER_SOURCE_LABELS,
  maskEmail,
  type NewsletterSource
} from "@/lib/newsletter/address";
import { newsletterMailerInfo } from "@/lib/newsletter/delivery";
import { NEWSLETTER_PATH } from "@/lib/newsletter/paths";
import {
  MAIL_KIND_LABELS,
  MAIL_STATE_LABELS,
  SUBSCRIBER_STATUSES,
  SUBSCRIBER_STATUS_DESCRIPTIONS,
  SUBSCRIBER_STATUS_LABELS,
  SUBSCRIBER_STATUS_TONES,
  erasedDeliveryWhere,
  isSubscriberStatus,
  liveDeliveryWhere,
  liveSubscriberWhere,
  mailableSubscriberWhere,
  subscriberSearchWhere
} from "@/lib/newsletter/subscribers";
import { canManageInquiries, canPurge } from "@/lib/permissions";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { CENTRE_TIME_ZONE } from "@/components/site/EventDateBlock";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { StudioPageHeader } from "@/components/studio/StudioPageHeader";

/**
 * Newsletter subscribers — who is on the list, who is waiting, and what has not been sent.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * `requireStudioCapability(canManageInquiries)` IS THE FIRST STATEMENT of the page, and every action below
 * repeats a check of its own. The page's check decides what is RENDERED; the actions' checks are the
 * boundary that actually matters, because a form can be submitted by anything that can make a POST and a
 * guard that only hides a control is not a guard (contract §1.7).
 *
 * ⚠ WHY `canManageInquiries` AND NOT `canManageSettings`. This screen holds reader-submitted personal
 * data, which is the same thing the contact inbox holds, so it takes the same predicate — one rule for
 * "may this person read what members of the public typed into a form". Inventing a second, differently
 * named permission for a second inbox is how two screens holding the same class of data end up with two
 * different answers to the same question.
 *
 * ⚠ AND WHY ERASING TAKES `canPurge` INSTEAD. See `eraseSubscriber` below: this model is deliberately NOT
 * in the recycle bin's registry, so an erasure here cannot be undone from any screen in the studio. That
 * is a purge in everything but the column it writes, and a purge is an administrator's act everywhere
 * else in this application.
 *
 * ══ THE SCREEN USES SERVER ACTIONS AND PLAIN FORMS, like `app/studio/redirects/page.tsx` ══
 *
 * A deliberate fit rather than a shortcut. There is no autosave to schedule, no selection to preserve and
 * no panel to keep open: the whole screen is a filter, a list, and two buttons per row. Plain forms mean
 * it works with no JavaScript at all, the permission check runs on the server for every submission, and
 * the filters live in the URL where they can be shared and walked with the Back button.
 *
 * ══ THE THREE THINGS THIS SCREEN EXISTS TO SAY, IN THE ORDER IT SAYS THEM ══
 *
 *   1. **NOTHING IS BEING SENT.** No mail provider is chosen in this deployment, so every message the
 *      feature composes is written to the outbox and not delivered. `newsletterMailerInfo()` is the only
 *      honest source for that fact and this is the only screen that reads it. Without the banner, a
 *      subscriber list that never moves past "waiting to confirm" looks like a quiet month rather than
 *      like a feature that is switched off — which is the failure the header of lib/newsletter/delivery.ts
 *      calls the worst one available here.
 *   2. **WHAT IS WAITING.** Every `newsletter_deliveries` row in state RECORDED **whose subscriber has
 *      not been erased** is a message that should have been sent and was not. The count is the backlog to
 *      replay the moment a provider exists, and the oldest one's date is how long somebody has been
 *      waiting for a confirmation link that is never coming. ⚠ The scope is `liveDeliveryWhere()` and it
 *      is load-bearing twice over: an erased person's address must not be printed on the screen that
 *      handles erasure requests, and a message composed for an erased record must never be replayed — so
 *      the number an operator is told to expect to send is the number that may lawfully be sent. What the
 *      scope hides is stated as a bare count beside the erased-record count, with no address in it.
 *   3. **WHO IS ACTUALLY ON THE LIST.** Which is not the number of rows: a mailing may go to CONFIRMED
 *      addresses only (`mailableSubscriberWhere()`), and PENDING and UNSUBSCRIBED rows are counted here
 *      precisely so nobody reads the total as an audience size.
 *
 * ══ ⚠ THE DIFFERENCE BETWEEN "UNSUBSCRIBED" AND "ERASED" IS STATED ON SCREEN, AND THIS IS WHY ══
 *
 * It is the one thing on this page that is genuinely counter-intuitive, and getting it wrong has a
 * consequence a reader would never guess:
 *
 *   • **UNSUBSCRIBED is the STRONGER record.** The row stays, and it is a suppression record — schema
 *     fact 2 keeps it so that a later import, or the sign-up form filled in by somebody else, cannot
 *     quietly put that person back on the list.
 *   • **ERASED (`deletedAt`) REMOVES THAT PROTECTION.** Every read path filters on `deletedAt`, so the
 *     row stops being visible here, stops being exported and stops being mailable — but the sign-up route
 *     REVIVES an erased row as PENDING on the next sign-up (see the fifth state in its header), because
 *     the alternative is an address that can never subscribe again for as long as the database lives.
 *
 * So an administrator who erases a record thinking it is a firmer unsubscribe has in fact made it
 * possible for anybody to sign that address up again. The copy beside the button says exactly that. This
 * is the sort of thing that is obvious in the code and invisible on a screen, and a screen that does not
 * say it will be used wrongly.
 *
 * ══ WHY THERE IS A "REMOVE BY HAND" BUTTON AT ALL ══
 *
 * Because the product already promises one. The unsubscribe route's refusal message and the `bad-link`
 * notice on the unsubscribe page BOTH end with "write to the Centre using the contact page and your
 * address will be removed by hand". Those two sentences are the last thing a reader who cannot get out
 * any other way is told — and until this button existed there was no mechanism behind them anywhere in
 * the application. A promise in copy with no implementation is the same defect as a comment stating a
 * rule the code does not keep; it is just harder to grep for.
 *
 * ⚠ OUTCOMES COME BACK AS A CODE IN THE QUERY STRING, NEVER AS A SENTENCE. `?problem=not_found` is looked
 * up in the table below. A free-text message taken from the query would let anybody craft a link that
 * shows an administrator a message this application never wrote, over the studio's own chrome.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Newsletter subscribers"
};

/**
 * How many rows are listed at once.
 *
 * Stated on screen when it bites, and stated again beside the export button — a list that quietly stops
 * is indistinguishable from a place with only that many records (contract §1.6), and an export that
 * quietly stops is worse because the file outlives the screen.
 */
const LIST_LIMIT = 200;

/** How many waiting messages the outbox panel names individually before it stops listing them. */
const OUTBOX_SAMPLE = 8;

/** How many refused messages are shown with the reason the provider gave. */
const FAILED_SAMPLE = 5;

/** The search box's cap. Protection, not validation — far above any address. */
const QUERY_MAX = 200;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Outcomes, as codes
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PROBLEMS: Record<string, string> = {
  not_found:
    "That subscriber record no longer exists — somebody may have erased it while this page was open. Nothing has been changed.",
  already_out:
    "That address was already unsubscribed or erased, so there was nothing to change. Its original unsubscribe date has been left as it was rather than being overwritten with today's.",
  missing_id: "Nothing identified which record to change, so nothing has been changed."
};

const NOTICES: Record<string, string> = {
  /**
   * ⚠ THE LAST CLAUSE IS THERE BECAUSE THIS SCREEN USED TO IMPLY THE OPPOSITE, and the moment a notice
   * appears is the moment somebody who has just clicked the wrong row needs to be told the truth. There is
   * no undo for this action anywhere in the studio — see the `HelpText` at the foot of the list, and
   * `unsubscribeByHand`'s own header for why re-subscribing by hand is not offered rather than not built.
   */
  unsubscribed:
    "That address has been unsubscribed by hand. Nothing further will be sent to it, and the record is kept as evidence that it asked to stop — so a later sign-up by somebody else cannot put it back on the list. ⚠ The person has NOT been emailed about this: if they wrote in to ask, reply to them yourself. ⚠ And this cannot be undone from this studio — only the person themselves can rejoin, by signing up again and opening the confirmation link.",
  /**
   * ⚠ EVERY CLAUSE OF THIS SENTENCE IS NOW TRUE, AND ONE OF THEM WAS NOT.
   *
   * It used to end "It is no longer listed, counted or exported here" while the outbox panels above went
   * on printing the erased address in full — the queries behind them had no reference to the subscriber
   * at all. The queries were scoped rather than the sentence softened (see `liveDeliveryWhere()` in the
   * transaction below), so "here" now means the whole screen, which is what a reader takes it to mean.
   * The last clause is the one an administrator will not guess and is why the notice is this long.
   */
  erased:
    "That record has been erased. It is no longer listed, counted or exported here, its address has been taken out of the outbox this screen shows, and nothing will be sent to it. ⚠ Erasing also removes the note that the address asked to stop, so a fresh sign-up — by them or by anybody else — can create a new pending record for it."
};

/** `?problem=` and `?notice=` are read against those two tables and nothing else. */
function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The actions
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who is doing this, for the audit entry.
 *
 * `clientIp()`/`userAgent()` in lib/api.ts take a `Request`, which a Server Action does not have — so the
 * same two headers are read from `headers()` here, exactly as `app/studio/redirects/page.tsx` does.
 * `x-forwarded-for` carries a list and the FIRST entry is the client; everything after it is a proxy.
 */
async function auditContext(actor: { id: string; email: string }): Promise<AuditContext> {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for");
  return {
    actor,
    ipAddress: forwarded?.split(",")[0]?.trim() ?? incoming.get("x-real-ip") ?? null,
    userAgent: incoming.get("user-agent")
  };
}

/** Back to this screen with an outcome code. Codes only — never a sentence from the query string. */
function backWith(params: Record<string, string>): never {
  const search = new URLSearchParams(params).toString();
  navigate(`/studio/subscribers${search.length > 0 ? `?${search}` : ""}`);
}

/**
 * ⚠ THE AUDIT ENTRY DELIBERATELY CARRIES A **MASKED** ADDRESS AND NO `before` SNAPSHOT.
 *
 * Both write paths below share this, and the reasoning is the same one the sign-up route gives for
 * writing no audit entry at all: `audit_logs` is read by more people than this screen is and it is
 * included in exports, so copying a member of the public's email address into it widens who can read
 * that address without adding a single fact — the subscriber row itself holds the address, and
 * `entityId` names the row.
 *
 * For an ERASURE it is stronger than a preference and closer to a correctness rule. `mutateWithHistory`
 * would do two things that quietly defeat an erasure:
 *
 *   • `writeRevision` snapshots the mutation's result into `revisions.data`, and
 *   • `writeAudit` copies whatever `before` is given into `audit_logs.before`.
 *
 * `redact()` strips password hashes and secrets by name. It does NOT strip `email`, `emailKey`,
 * `ipAddress`, `userAgent` or `consentText` — I checked the list. So an "erase" implemented with the
 * house wrapper would erase the row from every screen while writing a complete, permanent copy of the
 * erased person's address and IP into two other tables. That is why this file calls `writeAudit`
 * directly inside its own transaction instead: one entry that says WHAT happened to WHICH row, and no
 * copy of the data being erased.
 */
function auditLabel(emailKey: string): string {
  return maskEmail(emailKey);
}

/**
 * Unsubscribe an address on the Centre's behalf — the mechanism behind "your address will be removed by
 * hand".
 *
 * ⚠ NO RECEIPT IS EMAILED, AND THAT IS A CONSIDERED CHOICE RATHER THAN AN OMISSION.
 *
 * `app/api/public/newsletter/unsubscribe/route.ts` sends a receipt on a CONFIRMED → UNSUBSCRIBED
 * transition, and its header says why that is defensible: it is the receipt for an action the reader
 * themselves took a second earlier. Nothing about that argument survives here. A member of staff typing
 * into a studio screen is not that reader, and the failure mode is concrete — remove the wrong row and
 * this application sends an unsolicited "you have been unsubscribed" email to somebody who never wrote
 * in. So the write is silent, and the notice on screen tells the operator, in as many words, that they
 * must reply to the person themselves.
 *
 * ⚠ GUARDED `updateMany`, NOT `update`. The `where` repeats the status, so an address that is already
 * UNSUBSCRIBED is left completely alone — `update` would rewrite `unsubscribedAt` to today and destroy
 * the date the person actually asked to stop, which is the one fact this row exists to hold.
 *
 * ══ ⚠ THERE IS NO PARTNER ACTION THAT UNDOES THIS, AND THAT IS A DECISION RATHER THAN A GAP ══
 *
 * Written here because "why is there no re-subscribe button?" is the first question this screen provokes,
 * and because the copy at the foot of the list now states the consequence to the operator in as many
 * words. Both candidate reversals are worse than the honest sentence:
 *
 *   • **"Re-subscribe" (straight back to CONFIRMED) is the one thing this feature may never do.** It
 *     would put an address on a mailing list because a member of staff said so. The fourth state in the
 *     header of `app/api/public/newsletter/subscribe/route.ts` states the rule it would break: the ONLY
 *     thing that can re-subscribe somebody is a click in their own mailbox. A studio button that
 *     contradicts the double opt-in destroys the legal basis for every message sent to that address, and
 *     it does it silently.
 *   • **"Put it back to waiting to confirm" would be honest and, in this deployment, useless.** No mail
 *     provider is registered (the amber banner at the top of this screen says so), so the confirmation it
 *     would issue goes to the outbox and no further: the row would sit in PENDING for ever. That is the
 *     appearance of a reversal without the substance, which is worse than no button — it is the "silently
 *     stranded subscriber" the header of lib/newsletter/delivery.ts calls this feature's worst failure.
 *
 * So the reversal is a person signing up again themselves, and every place an operator can meet this
 * action says so: the note beside the button, `NOTICES.unsubscribed`, the sentence that replaces the
 * button on an UNSUBSCRIBED row, and the `HelpText` at the foot of the list. ⚠ If a provider is ever
 * registered, "put it back to waiting to confirm" becomes worth building — and it must issue a FRESH
 * challenge through `newConfirmationChallenge()`/`sendConfirmationEmail()` rather than reviving the old
 * nonce, which this action deliberately cleared.
 */
async function unsubscribeByHand(formData: FormData): Promise<void> {
  "use server";

  // THE BOUNDARY. Not the render — a form can be submitted by anything that can make a POST.
  const user = await requireStudioCapability(
    canManageInquiries,
    "Changing a newsletter subscription needs editor access or higher."
  );

  const id = String(formData.get("id") ?? "").trim();
  if (id.length === 0) backWith({ problem: "missing_id" });

  const row = await prisma.newsletterSubscriber.findUnique({
    where: { id },
    select: { id: true, emailKey: true, status: true, deletedAt: true }
  });
  if (!row || row.deletedAt !== null) backWith({ problem: "not_found" });

  const context = await auditContext({ id: user.id, email: user.email });

  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.newsletterSubscriber.updateMany({
      where: { id: row.id, status: { in: ["PENDING", "CONFIRMED"] }, deletedAt: null },
      data: {
        status: "UNSUBSCRIBED",
        unsubscribedAt: new Date(),
        /**
         * ⚠ CLEARING THE NONCE IS SECURITY-RELEVANT, NOT TIDYING — the same two lines the public
         * unsubscribe route carries, for the same reason. An unspent confirmation link may still be
         * sitting in this person's inbox; left alone it would remain a way to put them back on the list
         * after they asked to leave. The confirm route's nonce check is what refuses it, and it can only
         * refuse it because there is nothing here left to match.
         */
        confirmationToken: null,
        confirmationExpiresAt: null
      }
    });

    if (updated.count === 0) return 0;

    // Inside the transaction, so the row and the record of who changed it cannot come apart.
    await writeAudit(tx, context, {
      action: "UPDATE",
      entityType: "NewsletterSubscriber",
      entityId: row.id,
      entityLabel: auditLabel(row.emailKey)
      // No `before`/`after`. See `auditLabel`.
    });

    return updated.count;
  });

  if (changed === 0) backWith({ problem: "already_out" });
  backWith({ notice: "unsubscribed" });
}

/**
 * Erase a subscriber record — an erasure request, not a tidy-up.
 *
 * ⚠ `canPurge` (ADMINISTRATOR), NOT `canManageInquiries`. `NewsletterSubscriber` is deliberately absent
 * from the recycle bin's registry (`app/api/studio/recycle-bin/route.ts`), which the schema states
 * explicitly — so setting `deletedAt` here cannot be undone from any screen in this studio. It is a
 * purge in everything but the column it writes, and a purge is an administrator's act everywhere else in
 * this application. Adding the model to that registry would be the change that makes an editor's
 * erasure recoverable and therefore safe to delegate; it is reported in the handover rather than made
 * here, because that file is not this one's to edit.
 *
 * ⚠ WHAT THIS DOES **NOT** DO, STATED SO IT IS NOT DISCOVERED IN A DATABASE LATER: it does not overwrite
 * `email`, `emailKey`, `consentText`, `ipAddress` or `userAgent`. The row is hidden from every read path
 * and from the export, and nothing can be mailed to it — but the columns are still there. Two reasons,
 * and the first is load-bearing: `emailKey` is `@unique` and the sign-up route matches on it to REVIVE
 * an erased row rather than colliding with it, so blanking it would either break that path or free the
 * address to be inserted twice. The second is that `consentAt`/`consentText` are the evidence that this
 * application had a lawful basis for the messages it already sent, which an erasure of the subscription
 * does not retrospectively remove. If a true column-level scrub is ever required it is a new action with
 * a different name, and it must reckon with the unique key first.
 */
async function eraseSubscriber(formData: FormData): Promise<void> {
  "use server";

  const user = await requireStudioCapability(
    canPurge,
    "Erasing a subscriber record needs administrator access. It cannot be undone from any screen here."
  );

  const id = String(formData.get("id") ?? "").trim();
  if (id.length === 0) backWith({ problem: "missing_id" });

  const row = await prisma.newsletterSubscriber.findUnique({
    where: { id },
    select: { id: true, emailKey: true, deletedAt: true }
  });
  if (!row || row.deletedAt !== null) backWith({ problem: "not_found" });

  const context = await auditContext({ id: user.id, email: user.email });

  const changed = await prisma.$transaction(async (tx) => {
    // Guarded on `deletedAt: null` so two administrators clicking together cannot overwrite the first
    // erasure's date with the second's.
    const updated = await tx.newsletterSubscriber.updateMany({
      where: { id: row.id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        /**
         * The nonce is the one column on this row that is a live credential, so an erasure should not
         * leave one lying about. ⚠ It is belt-and-braces rather than the thing that closes the hole: the
         * confirm route already refuses an erased row before it looks at the nonce at all. Said plainly
         * so nobody later deletes the route's check believing this line covers it.
         */
        confirmationToken: null,
        confirmationExpiresAt: null
      }
    });

    if (updated.count === 0) return 0;

    await writeAudit(tx, context, {
      action: "DELETE",
      entityType: "NewsletterSubscriber",
      entityId: row.id,
      entityLabel: auditLabel(row.emailKey)
    });

    return updated.count;
  });

  if (changed === 0) backWith({ problem: "not_found" });
  backWith({ notice: "erased" });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The status filter's options, derived from the total tuple so a new status appears here by itself. */
const STATUS_OPTIONS = SUBSCRIBER_STATUSES.map((status) => ({
  value: status,
  label: SUBSCRIBER_STATUS_LABELS[status]
}));

/** The source filter's options, derived from the closed list for the same reason. */
const SOURCE_OPTIONS = NEWSLETTER_SOURCES.map((source) => ({
  value: source,
  label: NEWSLETTER_SOURCE_LABELS[source]
}));

export default async function StudioSubscribersPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireStudioCapability(
    canManageInquiries,
    "The newsletter list needs editor access or higher. An administrator can raise yours."
  );

  /**
   * ⚠ A RENDER-ONLY CHECK, and it is not a duplicate of the one in `eraseSubscriber`.
   *
   * That one is the boundary; this one decides whether the button is drawn at all. Showing an editor a
   * button that will refuse them is a worse screen than not showing it — and hiding it is not a
   * substitute for the action's own check, which is why both exist (contract §1.7).
   *
   * ⚠ The SAME `user` the capability check above already resolved, never a second
   * `requireStudioCapability` call. `canPurge` is a pure rank test over the row that call returned;
   * asking for the user twice would be a second database read for a fact already in hand.
   */
  const mayErase = canPurge(user);

  const params = await searchParams;
  const q = first(params.q).trim().slice(0, QUERY_MAX);

  /**
   * ⚠ THE FILTERS ARE NARROWED, NEVER COERCED, AND THE SOURCE ONE IS THE TRAP.
   *
   * `isSubscriberStatus` is a type guard: an unrecognised `?status=` is dropped and the list is
   * unfiltered, which is the safe direction. `toNewsletterSource()` exists next door and must NOT be
   * used here — it FALLS BACK TO `"other"`, so an absent or misspelled parameter would silently become
   * a filter for sign-ups from "somewhere else" and the screen would show a nearly empty list with a
   * filter control that looked untouched. That function is for recording what a form posted; this is
   * for reading what a URL asked. A membership test is the right shape for the second job.
   */
  const statusParam = first(params.status);
  const status: SubscriberStatus | null = isSubscriberStatus(statusParam) ? statusParam : null;

  const sourceParam = first(params.source);
  const source: NewsletterSource | null = (NEWSLETTER_SOURCES as readonly string[]).includes(
    sourceParam
  )
    ? (sourceParam as NewsletterSource)
    : null;

  const problem = PROBLEMS[first(params.problem)] ?? null;
  const notice = NOTICES[first(params.notice)] ?? null;

  /**
   * ⚠ `liveSubscriberWhere()` FIRST, AND EVERY OTHER CLAUSE ON TOP OF IT. It is the "not erased" filter,
   * and it is spread rather than restated so this screen cannot drift from the export and from the
   * counts. `subscriberSearchWhere()` returns an `OR`, and nothing else here writes one — so spreading
   * it is safe today. ⚠ If a second `OR` is ever added, both must move inside a single `AND` or the
   * later spread silently replaces the earlier one and the search stops filtering.
   */
  const where: Prisma.NewsletterSubscriberWhereInput = {
    ...liveSubscriberWhere(),
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
    ...(q.length > 0 ? subscriberSearchWhere(q) : {})
  };

  /**
   * Everything in ONE transaction **AT `RepeatableRead`**, so the counts, the list and the outbox all
   * describe the same instant. A sign-up that lands between two of these queries would otherwise make
   * the tiles and the list disagree, which reads as a bug in the count rather than as a race.
   *
   * ⚠ THE ISOLATION LEVEL IS THE WHOLE GUARANTEE, AND A TRANSACTION ALONE IS NOT A SNAPSHOT. This
   * paragraph previously claimed the consistency above while calling `$transaction` with no options,
   * which runs at Postgres's default READ COMMITTED — where **every statement takes a fresh snapshot**.
   * Under that level a sign-up committing between `statusGroups` (the first statement) and `rows` (the
   * sixth) is invisible to the tiles and visible in the list, so the screen reads “PENDING 4 … 4 records
   * altogether” above “All 5 matching records are shown above. The export contains exactly these.” —
   * precisely the disagreement the comment promised was impossible, and a reader who trusted it would go
   * hunting for a bug in `groupBy`. `RepeatableRead` takes ONE snapshot for the whole transaction, which
   * is the property actually being described.
   *
   * ⚠ `RepeatableRead` AND NOT `Serializable`, which is what the two write paths use
   * (`app/api/public/events/[slug]/register/route.ts:251`,
   * `app/api/studio/events/[id]/registrations/route.ts:608`). Those two READ-THEN-WRITE and need
   * serialisable to make the check they perform binding. This block only reads, and on Postgres a
   * serialisable transaction can be aborted with a 40001 serialisation failure that a read-only
   * transaction has no business risking — a studio screen that occasionally throws instead of rendering
   * would be a worse defect than the one being fixed. `RepeatableRead` gives the single snapshot without
   * that exposure.
   *
   * ⚠ THE INTERACTIVE FORM (a callback), NOT THE ARRAY FORM, and it is a TYPING constraint rather than a
   * preference — `app/studio/events/[id]/registrations/page.tsx` documents it and it cost that author
   * real time. `groupBy` has one of the most elaborate signatures Prisma generates, and inside
   * `$transaction([...])` the array's contextual type erases the inference so `_count` comes back as
   * `true | { … } | undefined` instead of a number. In a callback each call infers correctly.
   *
   * ⚠ `_count: true`, NOT `_count: { _all: true }`. The boolean form counts ROWS IN THE GROUP and types
   * as a plain number; the nested form asks for a per-column object, which is not the figure any tile
   * on this screen wants.
   */
  const {
    statusGroups,
    mailable,
    erasedCount,
    deliveryGroups,
    waiting,
    withheldWaiting,
    refused,
    rows,
    matching
  } = await prisma.$transaction(
    async (tx) => {
      // ⚠ The counts ignore the filters, deliberately. A tile that moved when somebody searched would be
      // answering a different question from the one it is labelled with — "how many are subscribed" is a
      // fact about the list, not about the current search.
      const statusGroups = await tx.newsletterSubscriber.groupBy({
        by: ["status"],
        where: liveSubscriberWhere(),
        _count: true
      });

      /**
       * ⚠ HOW MANY MAY ACTUALLY BE MAILED, ASKED WITH `mailableSubscriberWhere()` RATHER THAN INFERRED.
       *
       * `counts.CONFIRMED` from the `groupBy` above is the same number today, and using it would have
       * been one query cheaper. It is not the same QUESTION: that tile counts a status, and this sentence
       * makes a legal claim about who this deployment may write to. lib/newsletter/subscribers.ts exists
       * so that claim has exactly one definition in this repository, and a screen that restates it as
       * `status === "CONFIRMED"` is a second definition that stops agreeing the moment the first one
       * changes — the day a `BOUNCED` status or a suppression flag is added, this line must move with it
       * and the tile must not. Asking the shared filter is what makes that automatic.
       */
      const mailable = await tx.newsletterSubscriber.count({ where: mailableSubscriberWhere() });

      // Erased records are stated rather than allowed to vanish: this model is not in the recycle bin,
      // so this number is the only place the studio admits they exist at all.
      const erasedCount = await tx.newsletterSubscriber.count({
        where: { deletedAt: { not: null } }
      });

      /**
       * ⚠ ALL THREE OUTBOX QUERIES ARE SCOPED THROUGH `liveDeliveryWhere()`, AND THAT IS A FIX, NOT A
       * FLOURISH.
       *
       * `NewsletterDelivery.emailKey` is denormalised so a row stays readable after an erasure, and the
       * erase action sets `deletedAt` without touching any delivery row — so an unscoped outbox printed
       * an erased person's address, in full, two panels above a green notice telling the administrator it
       * was "no longer listed, counted or exported here". Scoping is the root fix: it makes the notice
       * true, and it makes the RECORDED backlog equal to the set of messages that may lawfully still be
       * sent, which is the only number an operator should be given to replay.
       *
       * ⚠ THE SHARED BUILDER FIRST AND THE STATE ON TOP, as everywhere else in this file.
       * `liveDeliveryWhere()` writes no `OR`, and `erasedDeliveryWhere()` writes nothing BUT an `OR`, so
       * neither spread can collide with `state` — if either ever grows a second `OR` these must move
       * inside a single `AND` or the later spread silently replaces the earlier one.
       */
      const deliveryGroups = await tx.newsletterDelivery.groupBy({
        by: ["state"],
        where: liveDeliveryWhere(),
        _count: true
      });

      // Oldest first: the first row is how long the person who has waited longest has been waiting.
      const waiting = await tx.newsletterDelivery.findMany({
        where: { ...liveDeliveryWhere(), state: "RECORDED" },
        orderBy: { createdAt: "asc" },
        take: OUTBOX_SAMPLE,
        select: { id: true, emailKey: true, kind: true, subject: true, createdAt: true }
      });

      /**
       * The messages the scope above hides, as a bare number and nothing else.
       *
       * A list that quietly stops is indistinguishable from a complete one (contract §1.6), so the count
       * is stated beside the erased-record count further down the screen. ⚠ NO ADDRESS AND NO SUBJECT
       * ARE READ HERE, deliberately: the entire point of the scope is that an erased person's address is
       * not on this screen, and a "withheld" panel that named them would put it straight back.
       */
      const withheldWaiting = await tx.newsletterDelivery.count({
        where: { ...erasedDeliveryWhere(), state: "RECORDED" }
      });

      /**
       * Refused messages, WITH the reason the provider gave.
       *
       * ⚠ Rendered rather than merely counted. `NewsletterDelivery.error` is written by
       * `deliverNewsletterMail` and there is no other screen in this application that reads it — a
       * column nothing displays is a column whose contents nobody can act on, which is the defect class
       * this repository keeps producing. A count alone would tell an operator that something was
       * refused and not one word about why.
       */
      const refused = await tx.newsletterDelivery.findMany({
        where: { ...liveDeliveryWhere(), state: "FAILED" },
        orderBy: { createdAt: "desc" },
        take: FAILED_SAMPLE,
        select: { id: true, emailKey: true, kind: true, provider: true, error: true, createdAt: true }
      });

      const rows = await tx.newsletterSubscriber.findMany({
        where,
        // A TOTAL ordering — the id breaks the tie. Without it two rows created in the same millisecond
        // can swap places between requests, which reads as data changing under the reader.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LIST_LIMIT,
        select: {
          id: true,
          email: true,
          emailKey: true,
          status: true,
          source: true,
          sourcePath: true,
          consentText: true,
          consentVersion: true,
          consentAt: true,
          confirmationSentAt: true,
          confirmationExpiresAt: true,
          confirmedAt: true,
          unsubscribedAt: true,
          createdAt: true,
          ipAddress: true,
          userAgent: true,
          _count: { select: { deliveries: true } }
        }
      });

      const matching = await tx.newsletterSubscriber.count({ where });

      return {
        statusGroups,
        mailable,
        erasedCount,
        deliveryGroups,
        waiting,
        withheldWaiting,
        refused,
        rows,
        matching
      };
    },
    // See the header above: the single snapshot IS the consistency this block claims, and READ COMMITTED
    // — the default with no options — does not provide it.
    { isolationLevel: "RepeatableRead" }
  );

  /**
   * Totals seeded with zeros.
   *
   * `groupBy` returns rows only for statuses that actually occur, and a missing key would render as
   * "undefined subscribed". Seeding from `SUBSCRIBER_STATUSES` — the total tuple — means every tile can
   * always be written, and a status added to the schema appears here without this file being touched.
   */
  const counts: Record<SubscriberStatus, number> = { PENDING: 0, CONFIRMED: 0, UNSUBSCRIBED: 0 };
  for (const group of statusGroups) counts[group.status] = group._count;

  const liveTotal = SUBSCRIBER_STATUSES.reduce((sum, key) => sum + counts[key], 0);

  const deliveryCounts = { RECORDED: 0, SENT: 0, FAILED: 0 };
  for (const group of deliveryGroups) deliveryCounts[group.state] = group._count;

  /**
   * ⚠ THIS REPORTS THE PROCESS THAT RENDERED THE PAGE.
   *
   * `setNewsletterMailer()` registers into a `globalThis` slot, so this answer is authoritative for THIS
   * worker. A deployment running several processes could in principle have one that was initialised
   * differently — which cannot happen when the registration lives in `instrumentation.ts` as the seam's
   * header instructs, because that runs once per process before any request. Written down because
   * "the studio said mail was configured" is a sentence somebody may one day have to weigh.
   */
  const mailer = newsletterMailerInfo();

  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: CENTRE_TIME_ZONE
  });

  /**
   * The export carries the filters that are set, so the file matches the screen.
   *
   * ⚠ Only the filters — never `problem` or `notice`, which describe something that has already happened
   * and would end up in a spreadsheet's URL for no reason.
   */
  const exportParams = new URLSearchParams();
  if (q.length > 0) exportParams.set("q", q);
  if (status) exportParams.set("status", status);
  if (source) exportParams.set("source", source);
  // `.toString()` rather than `.size`: the property is recent enough that reading it is a bet on the
  // runtime, and the string is needed anyway.
  const exportQuery = exportParams.toString();
  const exportHref = `/studio/subscribers/export${exportQuery.length > 0 ? `?${exportQuery}` : ""}`;

  const oldestWaiting = waiting[0];
  const filtered = q.length > 0 || status !== null || source !== null;

  return (
    <div className="mx-auto w-full max-w-[84rem] space-y-6">
      <StudioPageHeader
        title="Newsletter subscribers"
        /*
          ⚠ THE STATUS NAME IS INTERPOLATED, NOT TYPED OUT. It is a direct quotation of the chip a reader
          can see further down the page, and the only way to guarantee it stays one is to read it from the
          same map the chip does.
        */
        description={`Everybody who has put their address into the newsletter form, and what has happened to each one. A mailing may only ever go to the addresses marked “${SUBSCRIBER_STATUS_LABELS.CONFIRMED}” — the others have either not confirmed yet or have asked to stop.`}
        meta={
          <span className="text-xs tabular-nums text-ink-500">
            {counts.CONFIRMED === 1 ? "1 subscribed" : `${counts.CONFIRMED} subscribed`}
          </span>
        }
        actions={
          /*
            ⚠ A PLAIN `<a download>`, NOT A `LinkButton`, and this is the one precedent on this screen
            that is not a matter of taste. `LinkButton` renders a `next/link` for any href beginning with
            `/` (components/ui/Button.tsx), and `next/link` PREFETCHES what is in the viewport — this
            button sits in the page header, so it is always in the viewport. A prefetch of this href runs
            the whole export: `middleware.ts` sees a valid editor token and lets it through, and the
            handler reads up to 200 rows of `email`, `emailKey`, `ipAddress`, `userAgent` and
            `consentText`, assembles a complete personal-data CSV, and the router throws it away. Nobody
            clicked anything. Clicking then routes the navigation through the App Router first, which
            receives `text/csv` where it expected a flight payload and has to fall back to a hard
            navigation — so the same query and the same file are built a second time per download, and
            whether the file is SAVED rather than rendered rests entirely on `content-disposition`
            surviving that fallback.

            `download` is what makes the browser save it without leaving this screen, and it is why
            app/studio/health/page.tsx and app/studio/inquiries/InquiryInbox.tsx both do exactly this,
            both with a comment saying why. `buttonClasses(...)` gives the anchor the button's appearance
            with none of the routing.
          */
          <a href={exportHref} download className={buttonClasses({ variant: "secondary", size: "sm" })}>
            <Download aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            Export as a spreadsheet
          </a>
        }
      />

      {/*
        `role="alert"` for a refusal — the operator has just tried to do something and been stopped, which
        is the one case that warrants interrupting them. `role="status"` for something that worked.
      */}
      {problem ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-error-200 bg-error-100 px-3.5 py-3 text-sm leading-relaxed text-error-700"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{problem}</span>
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="rounded-md border border-success-600/25 bg-success-100 px-3.5 py-3 text-sm leading-relaxed text-success-600"
        >
          {notice}
        </p>
      ) : null}

      {/*
        ── 1. NOTHING IS BEING SENT ──
        The first thing on the screen, because it changes the meaning of every number below it. A list
        full of "waiting to confirm" is a mystery without this sentence and obvious with it.
      */}
      {!mailer.configured ? (
        <div className="rounded-md border border-amber-800/25 bg-amber-100 px-3.5 py-3 text-amber-800">
          <p className="flex items-start gap-2 text-sm font-semibold">
            <MailWarning aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>No email provider is set up, so nothing is being sent</span>
          </p>
          <p className="mt-1.5 text-xs leading-relaxed">
            Every message this feature composes — confirmation links, welcomes, unsubscribe receipts — is
            being written down and not delivered. Nothing is lost: each one is a queued message counted
            below, and they can all be sent once a provider is connected. Until then, anybody who signs
            up will stay on “{SUBSCRIBER_STATUS_LABELS.PENDING}” for ever, because the link they need has
            not reached them.
          </p>
          <p className="mt-1.5 text-xs leading-relaxed">
            Connecting a provider is a developer task and it is written up in full in the header of{" "}
            <code className="font-mono text-[0.6875rem]">lib/newsletter/delivery.ts</code>: one small
            adapter file and one line at start-up. No part of the newsletter needs changing.
          </p>
        </div>
      ) : (
        /*
          ⚠ NO `tone`, AND NOT `tone="success"` — WHICH DOES NOT EXIST.

          `HelpTone` is `"neutral" | "warn" | "error"` and nothing else (components/studio/HelpText.tsx);
          there is no success variant in this primitive, and inventing one at the call site is a type error
          rather than a green panel. The default neutral tone is also the honest register here: "mail is
          being sent" is the ORDINARY state of a working deployment, not an achievement to congratulate
          somebody on. The abnormal state is the amber branch above, and that is the one that shouts.
        */
        <HelpText>
          Email is being sent through {mailer.name}. Anything that provider refuses is listed below with
          the reason it gave.
        </HelpText>
      )}

      {/*
        ── 2. WHAT IS WAITING ──
      */}
      {deliveryCounts.RECORDED > 0 ? (
        <FormSection
          title={
            deliveryCounts.RECORDED === 1
              ? "1 message is waiting to be sent"
              : `${deliveryCounts.RECORDED} messages are waiting to be sent`
          }
          description={
            oldestWaiting
              ? `Each one is a message this application decided to send and could not. The oldest has been waiting since ${formatter.format(oldestWaiting.createdAt)}. They are kept in order, and connecting a provider is what sends them.`
              : "Each one is a message this application decided to send and could not."
          }
          /*
            ⚠ NO `tone`. `FormSectionTone` is `"default" | "danger"` and nothing else — there is no
            "warn" panel in this primitive. A message that has not been sent yet is not an error, so the
            ordinary panel is the honest surface and the amber `HelpText` inside it carries the caution.
          */
        >
          <ul className="space-y-2">
            {waiting.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border border-line-200 bg-surface-50 px-3 py-2 text-xs"
              >
                <Badge tone="warn" size="sm">
                  {MAIL_KIND_LABELS[row.kind]}
                </Badge>
                {/*
                  The address in full. This screen already lists addresses and is behind an editor
                  permission; `maskEmail` is for the PUBLIC unsubscribe page, where the reader may be
                  holding a forwarded link. Masking here would only stop an operator matching a queued
                  message to the person who wrote in about it.
                */}
                <span className="break-all font-mono text-ink-700">{row.emailKey}</span>
                <span className="text-ink-500">{row.subject}</span>
                <span className="ml-auto shrink-0 tabular-nums text-ink-500">
                  {formatter.format(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>

          {/*
            ⚠ `{" "}` AFTER THE NUMBER, AND IT IS NOT DECORATIVE. JSX strips the newline-and-indent
            between a `{…}` expression and the text child that follows it on the next line, so
            `of {n}` / `altogether.` on two lines compiles to `…, "of ", 9, "altogether."` and renders
            “of 9altogether.”. The identical sentence in the refused panel below keeps both halves on one
            line, which is why only this one was wrong.
          */}
          {deliveryCounts.RECORDED > waiting.length ? (
            <HelpText>
              Showing the {waiting.length} that have waited longest, of {deliveryCounts.RECORDED}{" "}
              altogether.
            </HelpText>
          ) : null}

          {/*
            ⚠ ALL THREE NAMES COME FROM `MAIL_STATE_LABELS`, none is typed out here. The first draft of
            this sentence spelled “Written down, not sent” as a literal — which is the wording of
            `MAIL_STATE_LABELS.RECORDED`, so the screen would have gone on saying it after somebody
            reworded the map, and the badge above would have disagreed with the sentence below it.
          */}
          <HelpText>
            “{MAIL_STATE_LABELS.RECORDED}” is a state, not a failure — nothing has been thrown away and
            no address has been lost. “{MAIL_STATE_LABELS.SENT}” and “{MAIL_STATE_LABELS.FAILED}” are the
            other two.
          </HelpText>
        </FormSection>
      ) : null}

      {refused.length > 0 ? (
        <FormSection
          title={
            deliveryCounts.FAILED === 1
              ? "1 message was refused by the provider"
              : `${deliveryCounts.FAILED} messages were refused by the provider`
          }
          description="These did not arrive. The reason is whatever the provider said, verbatim — an address that does not exist, a domain refusing our mail, or a credential that has expired."
          tone="danger"
        >
          <ul className="space-y-2">
            {refused.map((row) => (
              <li key={row.id} className="rounded-md border border-error-200 bg-surface-50 px-3 py-2">
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                  <Badge tone="error" size="sm">
                    {MAIL_KIND_LABELS[row.kind]}
                  </Badge>
                  <span className="break-all font-mono text-ink-700">{row.emailKey}</span>
                  {row.provider ? <span className="text-ink-500">via {row.provider}</span> : null}
                  <span className="ml-auto shrink-0 tabular-nums text-ink-500">
                    {formatter.format(row.createdAt)}
                  </span>
                </p>
                {row.error ? (
                  <p className="mt-1.5 break-words font-mono text-[0.6875rem] leading-relaxed text-error-700">
                    {row.error}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {deliveryCounts.FAILED > refused.length ? (
            <HelpText>
              Showing the {refused.length} most recent, of {deliveryCounts.FAILED} altogether.
            </HelpText>
          ) : null}
        </FormSection>
      ) : null}

      {/*
        ── 3. WHO IS ON THE LIST ──
        A tile per status, each with a sentence saying what the number MEANS. The descriptions come from
        lib/newsletter/subscribers.ts so this screen and the CSV cannot describe a status differently.
      */}
      <FormSection
        title="The list"
        description="Three states, and the difference between them decides who may be written to."
      >
        <ul className="grid gap-3 sm:grid-cols-3">
          {SUBSCRIBER_STATUSES.map((key) => (
            <li key={key} className="rounded-md border border-line-200 bg-surface-50 p-4">
              <p className="flex items-baseline justify-between gap-2">
                <Badge tone={SUBSCRIBER_STATUS_TONES[key]} size="sm">
                  {SUBSCRIBER_STATUS_LABELS[key]}
                </Badge>
                <span className="font-display text-2xl font-semibold tabular-nums text-ink-900">
                  {counts[key]}
                </span>
              </p>
              <p className="mt-2 text-xs leading-relaxed text-ink-500">
                {SUBSCRIBER_STATUS_DESCRIPTIONS[key]}
              </p>
            </li>
          ))}
        </ul>

        {/*
          ⚠ `{mailable}`, NOT `{counts.CONFIRMED}`. Same number, different question — see the comment on
          the `mailable` count in the transaction above. This sentence is the screen's statement of who may
          lawfully be written to, and it asks lib/newsletter/subscribers.ts rather than restating it.

          ⚠ AND THE ERASED CLAUSE NO LONGER CLAIMS SOMETHING THIS SCREEN DISPROVES. It used to read "not
          listed, counted or exported anywhere here" — in a sentence that was itself printing a count of
          them, and above an outbox that was printing their addresses. It now says exactly what is true:
          the records are gone from the list, the search and the file, this number is all that is left of
          them, and any message already composed for one of them has been withheld from the outbox above
          and must never be sent.
        */}
        <HelpText>
          {liveTotal === 1 ? "1 record altogether" : `${liveTotal} records altogether`}, of which{" "}
          {mailable} may be sent a mailing.{" "}
          {erasedCount > 0
            ? `A further ${erasedCount === 1 ? "record has" : `${erasedCount} records have`} been erased: neither listed, searched nor exported, and this count is all that is left of ${erasedCount === 1 ? "it" : "them"} here.`
            : "No records have been erased."}{" "}
          {withheldWaiting > 0
            ? `${withheldWaiting === 1 ? "One message that was" : `${withheldWaiting} messages that were`} composed for an erased record ${withheldWaiting === 1 ? "is" : "are"} held back from the outbox this screen shows — no address is given for ${withheldWaiting === 1 ? "it" : "them"}, and ${withheldWaiting === 1 ? "it must" : "they must"} never be sent.`
            : ""}
        </HelpText>

        <HelpText tone="warn">
          “Unsubscribed” is the stronger record, not the weaker one. Those rows are kept on purpose: they
          are the evidence that an address asked to stop, and they are what stops a later import or a form
          filled in by somebody else putting that person back on the list. Erasing a record removes that
          protection as well as the record.
        </HelpText>
      </FormSection>

      <FormSection
        title="Everybody who has signed up"
        description="Newest first. Search by any part of an address — the spelling somebody typed and the folded form it is stored under are both searched, so pasting an address out of an email finds it whatever its capitals."
        actions={
          // A GET form: the filters are a place in the URL, so they can be shared and the Back button
          // walks them. No JavaScript involved at all.
          <form method="get" className="flex flex-wrap items-end gap-2">
            <Field label="Search" hideLabel>
              <Input
                name="q"
                type="search"
                defaultValue={q}
                maxLength={QUERY_MAX}
                placeholder="Search addresses"
                iconNode={<Search />}
                autoCapitalize="off"
                spellCheck={false}
                className="w-48"
              />
            </Field>

            <Field label="Status" hideLabel>
              <Select
                name="status"
                defaultValue={status ?? ""}
                options={STATUS_OPTIONS}
                placeholder="Any status"
                className="w-44"
              />
            </Field>

            <Field label="Signed up from" hideLabel>
              <Select
                name="source"
                defaultValue={source ?? ""}
                options={SOURCE_OPTIONS}
                placeholder="Anywhere"
                className="w-48"
              />
            </Field>

            <Button type="submit" variant="secondary" size="sm">
              Filter
            </Button>
          </form>
        }
      >
        {rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={Search}
              headingLevel={3}
              title="Nothing matches those filters"
              description="No record has that in either spelling of its address, or in the status and place you chose. Clear the filters to see everybody."
            />
          ) : (
            <EmptyState
              icon={Users}
              headingLevel={3}
              title="Nobody has signed up yet"
              description={`The form is on the newsletter page at ${NEWSLETTER_PATH} and in the footer of every page on the website. The first address to be entered there will appear here straight away, as “${SUBSCRIBER_STATUS_LABELS.PENDING}”.`}
            />
          )
        ) : (
          <>
            <ul className="space-y-3">
              {rows.map((row) => (
                <li key={row.id} className="rounded-md border border-line-200 bg-surface-50 p-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                    <Badge tone={SUBSCRIBER_STATUS_TONES[row.status]} size="sm">
                      {SUBSCRIBER_STATUS_LABELS[row.status]}
                    </Badge>

                    <span className="break-all font-mono text-sm text-ink-900">{row.email}</span>

                    {/*
                      The folded identity, shown only when it DIFFERS from the spelling above. Printing
                      both every time would be noise; printing neither would make it impossible to see
                      why "Reader@example.org" and "reader@example.org" are one record. This is the one
                      thing on the screen that explains that.
                    */}
                    {row.email !== row.emailKey ? (
                      <span className="break-all font-mono text-xs text-ink-500">
                        stored as {row.emailKey}
                      </span>
                    ) : null}

                    <span className="ml-auto shrink-0 text-xs tabular-nums text-ink-500">
                      signed up {formatter.format(row.createdAt)}
                    </span>
                  </div>

                  <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs leading-relaxed sm:grid-cols-2">
                    <div className="flex gap-2">
                      <dt className="shrink-0 text-ink-500">From</dt>
                      <dd className="text-ink-700">
                        {NEWSLETTER_SOURCE_LABELS[
                          (NEWSLETTER_SOURCES as readonly string[]).includes(row.source)
                            ? (row.source as NewsletterSource)
                            : "other"
                        ]}
                        {row.sourcePath ? (
                          <span className="ml-1.5 break-all font-mono text-ink-500">
                            {row.sourcePath}
                          </span>
                        ) : null}
                      </dd>
                    </div>

                    <div className="flex gap-2">
                      <dt className="shrink-0 text-ink-500">Messages</dt>
                      <dd className="tabular-nums text-ink-700">
                        {row._count.deliveries === 0
                          ? "none composed for this address"
                          : row._count.deliveries === 1
                            ? "1 composed for this address"
                            : `${row._count.deliveries} composed for this address`}
                      </dd>
                    </div>

                    {row.confirmedAt ? (
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-ink-500">Confirmed</dt>
                        <dd className="tabular-nums text-ink-700">
                          {formatter.format(row.confirmedAt)}
                        </dd>
                      </div>
                    ) : row.confirmationSentAt ? (
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-ink-500">Link issued</dt>
                        <dd className="tabular-nums text-ink-700">
                          {formatter.format(row.confirmationSentAt)}
                          {row.confirmationExpiresAt ? (
                            <span className="ml-1.5 text-ink-500">
                              {row.confirmationExpiresAt.getTime() < Date.now()
                                ? "— expired"
                                : `— valid until ${formatter.format(row.confirmationExpiresAt)}`}
                            </span>
                          ) : null}
                        </dd>
                      </div>
                    ) : null}

                    {/*
                      ⚠ SHOWN EVEN WHEN THE ROW IS BACK TO PENDING. The sign-up route deliberately does
                      NOT clear `unsubscribedAt` when an unsubscribed address signs up again, so that
                      "did they leave and come back?" stays answerable. Hiding it for a non-unsubscribed
                      row would throw away exactly the fact that column is kept for.
                    */}
                    {row.unsubscribedAt ? (
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-ink-500">Asked to stop</dt>
                        <dd className="tabular-nums text-ink-700">
                          {formatter.format(row.unsubscribedAt)}
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {/*
                    THE CONSENT RECORD, verbatim and collapsed.
                    ⚠ `consentText` is the sentence this person actually read, copied at sign-up and never
                    updated — it is the evidence, and it is the answer to "what exactly did they agree
                    to?". It is rendered as stored: paraphrasing or truncating it here would defeat the
                    entire purpose of lib/newsletter/consent.ts. A `<details>` keeps it out of the way
                    without putting it behind JavaScript.
                  */}
                  <details className="mt-2 border-t border-line-200 pt-2">
                    <summary className="cursor-pointer text-xs text-ink-500">
                      What they agreed to, and the evidence
                    </summary>
                    <blockquote className="mt-2 border-l-2 border-purple-200 pl-3 text-xs leading-relaxed text-ink-700">
                      “{row.consentText}”
                    </blockquote>
                    <dl className="mt-2 grid gap-x-6 gap-y-1 text-[0.6875rem] leading-relaxed sm:grid-cols-2">
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-ink-500">Agreed</dt>
                        <dd className="tabular-nums text-ink-700">
                          {formatter.format(row.consentAt)} (wording {row.consentVersion})
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-ink-500">From address</dt>
                        <dd className="break-all font-mono text-ink-700">
                          {row.ipAddress ?? "not recorded"}
                        </dd>
                      </div>
                      {row.userAgent ? (
                        <div className="flex gap-2 sm:col-span-2">
                          <dt className="shrink-0 text-ink-500">Browser</dt>
                          <dd className="break-all font-mono text-ink-700">{row.userAgent}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </details>

                  {/*
                    ⚠ TWO SEPARATE FORMS, and never one with two submit buttons. A single form would put
                    "erase" one stray Enter keypress away from the row somebody was looking at — the same
                    reason `app/studio/redirects/page.tsx` splits its delete out.
                  */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line-200 pt-2">
                    {row.status === "UNSUBSCRIBED" ? (
                      /*
                        ⚠ THE SECOND SENTENCE IS THE ONE THAT WAS MISSING, AND ITS ABSENCE MADE THIS THE
                        ONLY PLACE ON THE SCREEN THAT SAID NOTHING ABOUT GETTING BACK.

                        An operator who has just unsubscribed the wrong row lands here — the button they
                        used has been replaced by this line — and until now it read only "nothing further
                        will be sent", which invites the question "so how do I put it back?" and answers
                        it nowhere. There IS no answer inside this studio, and saying so is the only
                        honest option: re-subscribing somebody by hand would be adding an address to a
                        mailing list without that person asking, which is the one thing the whole
                        double opt-in exists to make impossible (see the fourth state in the header of
                        app/api/public/newsletter/subscribe/route.ts).
                      */
                      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-500">
                        <MailX aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>
                          Nothing further will be sent to this address. Putting it back on the list is not
                          something this screen can do — only the person themselves can, by signing up
                          again and opening the confirmation link.
                        </span>
                      </p>
                    ) : (
                      <form action={unsubscribeByHand}>
                        <input type="hidden" name="id" value={row.id} />
                        <Button type="submit" variant="secondary" size="sm" icon={MailX}>
                          Unsubscribe by hand
                        </Button>
                        <span className="ml-2 text-xs text-ink-500">
                          Stops everything to this address and keeps the record. The person is not
                          emailed — reply to them yourself. ⚠ It cannot be undone from here.
                        </span>
                      </form>
                    )}
                  </div>

                  {mayErase ? (
                    <form action={eraseSubscriber} className="mt-2 border-t border-line-200 pt-2">
                      <input type="hidden" name="id" value={row.id} />
                      <Button type="submit" variant="danger" size="sm" icon={UserRoundX}>
                        Erase this record
                      </Button>
                      <span className="ml-2 text-xs text-ink-500">
                        For an erasure request only. It cannot be undone from any screen here, and it
                        also removes the note that this address asked to stop — so a later sign-up can
                        create a fresh pending record for it.
                      </span>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>

            {matching > rows.length ? (
              <HelpText tone="warn">
                Showing the {rows.length} most recent of {matching} records that match. The list stops at{" "}
                {LIST_LIMIT} — search or narrow the status to reach the rest.{" "}
                <strong>The export is capped too</strong>, and the file says so in its last row.
              </HelpText>
            ) : (
              <HelpText>
                {matching === 1
                  ? "1 record matches, and it is shown above."
                  : `All ${matching} matching records are shown above.`}{" "}
                The export contains exactly these.
              </HelpText>
            )}

            {/*
              ══════════════════════════════════════════════════════════════════════════════════════
              ⚠ THIS SENTENCE USED TO ASSERT SOMETHING NO PART OF THE PRODUCT COULD DO. It read
              "Unsubscribing by hand is the reversible half and is available to you" — and there is no
              re-subscribe action in this file, `NewsletterSubscriber` is absent from the recycle-bin
              registry, and the amber banner at the top of this screen states that with no provider
              configured nobody can ever confirm, so the reader-side route back is shut as well. An
              editor could therefore be told an action was reversible, click it on the wrong row with no
              confirmation dialog, and find that nothing anywhere reverses it.

              Fixed by making the sentence true rather than by building a reversal, and that is a
              considered choice, not the cheaper one:

                • A "re-subscribe" button would put an address back on a mailing list because a member of
                  STAFF said so. That is exactly what the double opt-in exists to make impossible — the
                  fourth state in the header of app/api/public/newsletter/subscribe/route.ts says the only
                  thing that may ever re-subscribe somebody is a click in their own mailbox, and a studio
                  button contradicting it would be the most expensive kind of convenience in this feature.
                • A "put it back to waiting-to-confirm" button would be honest, but with no provider
                  configured it strands the row in PENDING for ever (the banner above says so), so it
                  would restore the appearance of a reversal and not the substance.

              So the copy now says what is actually true, on the screen where the click happens, and it
              names the one real route back. The per-row note beside the button and `NOTICES.unsubscribed`
              carry the same fact, because an editor may meet any of the three first.

              ⚠ `tone="warn"` and rendered for EVERYBODY, not only for an editor. The old sentence was
              inside `!mayErase`, so an administrator — the one person who can also erase — was never
              shown either half of it.

              ⚠ AND NO HAND-PLACED GLYPH ANY MORE. The old line carried an inline `ShieldX` because the
              neutral tone has none (`TONE_ICON.neutral` is null in components/studio/HelpText.tsx); a
              loud tone brings `TriangleAlert` itself, so an inline icon here would render two glyphs on
              one sentence. `ShieldX` was used nowhere else in this file and its import went with it.
              ══════════════════════════════════════════════════════════════════════════════════════
            */}
            <HelpText tone="warn">
              Nothing you can do to a row on this screen can be undone from this studio.{" "}
              {!mayErase ? (
                <>
                  Erasing a record needs administrator access for exactly that reason; unsubscribing by hand
                  is available to you and is just as final.{" "}
                </>
              ) : null}
              There is no re-subscribe action, and that is deliberate — putting an address back on the list
              by hand would be subscribing somebody who has not asked. The only route back is the person
              signing up again themselves and opening the confirmation link. If a row was changed by
              mistake, tell whoever maintains the site: restoring it to “
              {SUBSCRIBER_STATUS_LABELS.PENDING}” is a change to the database, not a button.
            </HelpText>
          </>
        )}
      </FormSection>
    </div>
  );
}
