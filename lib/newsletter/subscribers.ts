import type { NewsletterMailKind, NewsletterMailState, Prisma, SubscriberStatus } from "@prisma/client";

/**
 * The reading vocabulary for newsletter records: the filter every read path uses, and the plain words
 * every status is rendered with.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ `liveSubscriberWhere()` IS A **THIRD** FILTER OF THE KIND lib/content.ts DESCRIBES, AND IT IS
 *   HERE RATHER THAN THERE FOR THE SAME REASON `activeAnnouncementWhere()` IS IN lib/announcements.ts.
 *
 * `NewsletterSubscriber` has neither a `ContentStatus` nor `publishAt`/`unpublishAt`, so neither
 * `livePublishableWhere()` nor `liveStatusWhere()` can be pointed at it — a Prisma filter naming a
 * column the model does not have is a RUNTIME error, not a type error, and the note at the foot of
 * lib/content.ts says exactly that about putting a third builder in that file: it becomes an
 * invitation to reach for the wrong one.
 *
 * ⚠ AND THE WORD "LIVE" MEANS SOMETHING DIFFERENT HERE, WHICH IS THE TRAP WORTH THE MOST WORDS.
 *
 * For content, "live" means "the public may read this". For a subscriber it means "this record has not
 * been erased" — and that is **not** the same as "this person would receive a mailing". A record can
 * be perfectly live and be PENDING (never confirmed, must never be mailed) or UNSUBSCRIBED (asked to
 * stop, must never be mailed). So:
 *
 *   • `liveSubscriberWhere()`      → what the STUDIO lists and counts. Everything not erased.
 *   • `mailableSubscriberWhere()`  → who a mailing may actually go to. CONFIRMED only.
 *   • `isMailableSubscriber(row)`  → the SAME question asked of a row already in hand, for the one caller
 *                                    that cannot use a `where` at all (the CSV has to describe the rows
 *                                    inside itself). Both read `MAILABLE_STATUS`; see its own header for
 *                                    why a hand-written `status === "CONFIRMED"` at a call site is a
 *                                    defect and not a shortcut.
 *   • `liveDeliveryWhere()`        → the same "not erased" test, applied to an OUTBOX row through its
 *                                    subscriber, plus its exact complement `erasedDeliveryWhere()`.
 *                                    See their own header: an erasure that left the address printed in
 *                                    the outbox was a real defect on the studio screen, not a theory.
 *
 * Two functions, because one of them is a legal question. A mailing built on the first would email
 * every address that has ever been typed into the form, including addresses typed by somebody else
 * and never confirmed, and including people who have explicitly asked to stop. That is the single most
 * expensive mistake available in this part of the product, so the two are named apart and the
 * dangerous one does not exist.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Not erased. What the studio's list, counts, search and export all start from.
 *
 * ⚠ Includes UNSUBSCRIBED rows on purpose — an unsubscribe is an instruction to be kept and shown,
 * not a deletion (see the header of the model in prisma/schema.prisma). A studio list that hid them
 * would make "did this person unsubscribe or were they never here?" unanswerable.
 */
export function liveSubscriberWhere(): Prisma.NewsletterSubscriberWhereInput {
  return { deletedAt: null };
}

/**
 * The one status a mailing may go to.
 *
 * Named, and NOT exported, so that the `where` builder and the row-level test below are the only two
 * things in the repository that read it — and so that a call site cannot import the bare status and
 * re-implement the question a third time. `satisfies` keeps the literal type, which is what Prisma's
 * `where` needs.
 */
const MAILABLE_STATUS = "CONFIRMED" satisfies SubscriberStatus;

/**
 * Who a mailing may be sent to. CONFIRMED, not erased, and nothing else.
 *
 * ⚠ THE ONLY FILTER A MAILING MAY EVER USE. It is written here, once, with no parameters and nothing
 * to spread into it wrongly, so that the day something is actually sent there is no version of this
 * question that a call site can get subtly wrong.
 */
export function mailableSubscriberWhere(): Prisma.NewsletterSubscriberWhereInput {
  return { deletedAt: null, status: MAILABLE_STATUS };
}

/**
 * THE SAME QUESTION, ASKED OF A ROW THAT HAS ALREADY BEEN READ.
 *
 * ══ ⚠ WHY THIS EXISTS, AND IT IS NOT CONVENIENCE ══
 *
 * `mailableSubscriberWhere()` can only be used where a query is being built. The CSV export has to state,
 * in the file itself, how many of the rows IT CARRIES may lawfully be mailed — a figure about the capped,
 * filtered set of rows in that particular download, which no `count()` can answer — so it filtered the
 * rows it had with `row.status === "CONFIRMED"` written out by hand, under a comment that said
 * "`mailableSubscriberWhere()` exists so that question has one answer in code". That is this repository's
 * worst defect shape: a comment naming a rule while the code beside it keeps a private copy of the rule.
 * And the artefact it was wrong in is the one somebody may paste into a mail provider.
 *
 * ⚠ BOTH HALVES OF THE TEST ARE HERE — the erasure AND the status. A caller that has already filtered by
 * `liveSubscriberWhere()` satisfies the first half twice over, which costs nothing; a caller that has NOT
 * would otherwise count an erased person as mailable, and there is no version of this function that is
 * safe to apply half of. `deletedAt` is therefore required, not optional: an optional field would let a
 * `select` that forgot it pass the test silently.
 */
export function isMailableSubscriber(row: {
  status: SubscriberStatus;
  deletedAt: Date | null;
}): boolean {
  return row.deletedAt === null && row.status === MAILABLE_STATUS;
}

/**
 * THE OUTBOX'S HALF OF THE SAME QUESTION: one message, and whether it belongs to a record that still
 * exists.
 *
 * ══ ⚠ WHY THIS HAD TO EXIST, WRITTEN DOWN BECAUSE IT WAS A REAL DEFECT AND NOT A HYPOTHETICAL ══
 *
 * `NewsletterDelivery.emailKey` is DENORMALISED on purpose — the schema says "so a delivery row remains
 * readable after an erasure". That is right for the row and wrong for the screen: the studio's outbox
 * panels were querying `newsletterDelivery` with no reference to the subscriber at all, so an
 * administrator who erased a record was shown a green notice saying the address was "no longer listed,
 * counted or exported here" while the same address was still printed in full, in monospace, two panels
 * above — on the one screen whose purpose is handling erasure requests.
 *
 * ⚠ AND IT IS NOT ONLY COPY. Every RECORDED row is the replay backlog for the day a provider is
 * registered. A confirmation message composed for an address that has since been erased must NEVER be
 * replayed, so the backlog an operator is shown must not contain it either — the number they are told
 * to expect to send is the number that may lawfully be sent.
 *
 * ⚠ `is:` IS EXPLICIT, AND THE SEMANTICS ARE THE TRAP. `subscriber` is a NULLABLE to-one relation, so
 * `{ subscriber: { is: { deletedAt: null } } }` means "a subscriber row exists AND it is not erased" —
 * a delivery whose `subscriberId` is null matches NEITHER this nor `deletedAt: { not: null }`. That is
 * why the complement below spells the null case out as its own `OR` branch rather than wrapping this
 * one in `NOT`: the two must partition every row in the table, or the "withheld" count on the studio
 * screen would silently disagree with the list it is explaining.
 */
export function liveDeliveryWhere(): Prisma.NewsletterDeliveryWhereInput {
  return { subscriber: { is: { deletedAt: null } } };
}

/**
 * The exact complement of `liveDeliveryWhere()`: a message composed for a record that has since been
 * erased, or for one that is no longer there at all (`onDelete: SetNull`, which nothing in this
 * application currently triggers — the erase action sets `deletedAt` and never deletes the row).
 *
 * Used for ONE thing only: telling the studio how many messages have been withheld from the outbox, as
 * a bare number with no address in it. A list that quietly stops is indistinguishable from a complete
 * one (contract §1.6), and the honest way to hide an erased person's address is to say that something
 * was hidden without saying whose it was.
 */
export function erasedDeliveryWhere(): Prisma.NewsletterDeliveryWhereInput {
  return {
    OR: [{ subscriberId: null }, { subscriber: { is: { deletedAt: { not: null } } } }]
  };
}

/** Every status, in the order the studio counts them. A total tuple, so a new status is a build error. */
export const SUBSCRIBER_STATUSES: readonly SubscriberStatus[] = [
  "PENDING",
  "CONFIRMED",
  "UNSUBSCRIBED"
];

export function isSubscriberStatus(value: string): value is SubscriberStatus {
  return (SUBSCRIBER_STATUSES as readonly string[]).includes(value);
}

/**
 * Plain words, never the enum. "PENDING" is a database value; "Waiting to confirm" is the same fact in
 * language an administrator can act on — and it is the wording the CSV column uses too, so a
 * spreadsheet and the screen agree.
 */
export const SUBSCRIBER_STATUS_LABELS: Record<SubscriberStatus, string> = {
  PENDING: "Waiting to confirm",
  CONFIRMED: "Subscribed",
  UNSUBSCRIBED: "Unsubscribed"
};

/**
 * The tone for a status chip.
 *
 * ⚠ PENDING IS `warn`, NOT `neutral`, and the choice is load-bearing on this screen. A pending row is
 * not a quiet intermediate state: with no mail provider configured it is a person who signed up and
 * was never written to. Amber says "somebody should look at this", which is true, where grey would say
 * "nothing to see", which is not. UNSUBSCRIBED is neutral rather than error — it is a perfectly
 * correct outcome and colouring it red would read as a fault.
 */
export const SUBSCRIBER_STATUS_TONES: Record<SubscriberStatus, "neutral" | "info" | "warn" | "success"> =
  {
    PENDING: "warn",
    CONFIRMED: "success",
    UNSUBSCRIBED: "neutral"
  };

/** One sentence per status, for the studio's count tiles. Says what the number MEANS, not what it is. */
export const SUBSCRIBER_STATUS_DESCRIPTIONS: Record<SubscriberStatus, string> = {
  PENDING:
    "Signed up but have not clicked the link in the confirmation email, so they must not be sent anything else.",
  CONFIRMED: "Confirmed their address. These are the only people a mailing may go to.",
  UNSUBSCRIBED:
    "Asked to stop. The record is kept deliberately, so a later import cannot put them back on the list."
};

/** Plain words for each kind of message in the outbox. */
export const MAIL_KIND_LABELS: Record<NewsletterMailKind, string> = {
  CONFIRMATION: "Confirmation link",
  ALREADY_SUBSCRIBED: "Already subscribed notice",
  WELCOME: "Welcome message",
  UNSUBSCRIBE_RECEIPT: "Unsubscribe receipt"
};

/**
 * Plain words for what happened to a message.
 *
 * "Written down, not sent" rather than "recorded": an administrator reading a screen needs to know
 * that nothing left the building, and "recorded" sounds like success.
 */
export const MAIL_STATE_LABELS: Record<NewsletterMailState, string> = {
  RECORDED: "Written down, not sent",
  SENT: "Sent",
  FAILED: "Refused by the provider"
};

/**
 * The `where` for the studio's search box.
 *
 * ⚠ IT SEARCHES `emailKey` AND `email` BOTH. `email` keeps the capitals the person typed and
 * `emailKey` is folded, so a search for "Reader" would match the first and a search for "reader" the
 * second — and `mode: "insensitive"` on one column is not a substitute for looking at both, because a
 * subscriber whose stored spelling differs from the search only in case is exactly who somebody is
 * looking for when they paste an address out of an email.
 */
export function subscriberSearchWhere(query: string): Prisma.NewsletterSubscriberWhereInput {
  return {
    OR: [
      { emailKey: { contains: query, mode: "insensitive" } },
      { email: { contains: query, mode: "insensitive" } }
    ]
  };
}
