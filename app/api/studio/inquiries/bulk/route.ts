import { z } from "zod";
import type { Prisma, SubmissionStatus } from "@prisma/client";

import { ApiError, assertSameOrigin, ok, route } from "@/lib/api";
import { mutateWithHistory } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { canManageInquiries } from "@/lib/permissions";
import { buildAuditContext, parseStudioJson } from "@/lib/studio/crud";

/**
 * The bulk action on the contact inbox: move many enquiries to one state, one at a time.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ THERE IS NO BULK DELETE HERE, AND THERE MUST NEVER BE ONE. A deleted enquiry is a lost enquiry: it is
 * somebody's only attempt to reach the Centre and there is no second copy anywhere. ARCHIVING clears the
 * queue and keeps every word. The recycle bin is the only removal path and it is reached from its own screen,
 * one record at a time, by an administrator. Adding a `delete` action to the list below would be the most
 * destructive line anybody could write in this studio, and it would sit above a column of checkboxes.
 *
 * ⚠ THIS FILE TAKES OVER A PATH THAT WAS BEING SERVED BY A RESERVED ID. `app/api/studio/inquiries/[id]/
 * route.ts` dispatches `POST` with `id="bulk"` to a bulk archive of its own, and its header says that if a
 * static route file is ever added at this path, Next prefers it and that dispatch becomes dead code to be
 * deleted. A static segment does beat a dynamic one (contract §13b), so this file now serves every
 * `POST /api/studio/inquiries/bulk` and the branch in that file is unreachable. It is left in place here only
 * because it is not this file's to edit — see the manifest.
 *
 * ⚠ SEQUENTIAL, AND FAILURES ARE COLLECTED RATHER THAN ABORTING ON THE FIRST.
 *
 * One `updateMany` would be a single statement and no audit trail at all — and the audit log is read to answer
 * "who archived my enquiry", which a single entry naming twenty ids does not answer. So each row is its own
 * `mutateWithHistory` (its own transaction, its own audit entry), and the loop keeps going when one fails.
 * Twenty rows where the eleventh is refused must not leave nineteen untouched, and the reader must be told
 * WHICH one failed rather than being sent back to a list of twenty to find out.
 *
 * ⚠ A PARTIAL FAILURE IS ANSWERED AS AN ERROR, ON PURPOSE, and the message leads with what did work. The
 * inbox screen keeps its selection when this call throws (see `archiveMany` in InquiryInbox.tsx), which is
 * what makes a retry one click — and pressing the button again skips the rows that are already done. Answering
 * 200 with a report nobody reads would print "20 enquiries archived" over a failure, which is the bug class
 * contract §1.6 exists to stop.
 *
 * WHAT WAS SKIPPED IS REPORTED BUT IS NOT A FAILURE. A row already in the target state, and a row that has
 * gone from the inbox since the screen was drawn, are both "no write was needed" rather than "the write did
 * not work" — so they travel in the 200 body and in its sentence.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

/**
 * How many enquiries one request may touch.
 *
 * ⚠ The same number as `MAX_BULK` in `app/api/studio/inquiries/[id]/route.ts`, so the cap does not change as
 * this path moves between the two files. Stated in the refusal when it bites.
 */
const MAX_BULK = 200;

/**
 * The actions, and the state each one means.
 *
 * A closed list of verbs rather than a raw state name, because "archive" is the word the inbox sends and the
 * word an editor uses. `satisfies` pins every value to a real `SubmissionStatus`, so a typo is a compile error
 * rather than a 500 from Prisma.
 *
 * ⚠ NO `delete`. See the header.
 */
const ACTIONS = [
  "archive",
  "mark-as-new",
  "mark-as-being-handled",
  "mark-as-replied",
  "mark-as-spam"
] as const;

type BulkAction = (typeof ACTIONS)[number];

const NEXT_STATE = {
  archive: "ARCHIVED",
  "mark-as-new": "NEW",
  "mark-as-being-handled": "IN_PROGRESS",
  "mark-as-replied": "REPLIED",
  "mark-as-spam": "SPAM"
} as const satisfies Record<BulkAction, SubmissionStatus>;

/** What each action is called in a sentence, so the report reads as English rather than as an enum. */
const DONE_LABEL = {
  archive: "archived",
  "mark-as-new": "put back in the queue as new",
  "mark-as-being-handled": "marked as being handled",
  "mark-as-replied": "marked as replied",
  "mark-as-spam": "marked as spam"
} as const satisfies Record<BulkAction, string>;

const bulkBody = z.object({
  ids: z
    .array(z.string().trim().min(1, "An empty reference to an enquiry cannot be used.").max(64))
    .min(1, "Choose at least one enquiry.")
    .max(MAX_BULK, `At most ${MAX_BULK} enquiries can be dealt with at once.`),
  action: z.enum(ACTIONS, {
    message:
      "That is not something that can be done to a batch of enquiries. Archiving keeps every word and clears the queue; enquiries are never deleted in bulk."
  })
});

function enquiries(count: number): string {
  return count === 1 ? "1 enquiry" : `${count} enquiries`;
}

/** One row's report line. `reason` is always a sentence ready to render (lib/api.ts). */
interface Failure {
  id: string;
  name: string;
  reason: string;
}

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);

  const actor = await requireCapability(
    canManageInquiries,
    "Working through the contact inbox needs editor access or higher, because a reply speaks for the institution. An administrator can raise yours."
  );

  const body = await parseStudioJson(request, bulkBody);
  const action: BulkAction = body.action;
  const nextState: SubmissionStatus = NEXT_STATE[action];

  // A duplicate in the selection is the screen's business, not a refusal: the same row archived twice is
  // archived once.
  const ids = [...new Set(body.ids)];

  const rows = await prisma.contactSubmission.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, email: true, state: true, repliedAt: true }
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  /** Ids that are no longer in the inbox — moved to the recycle bin, or dealt with in another window. */
  const notFound = ids.filter((candidate) => !byId.has(candidate));

  const context = buildAuditContext(request, actor);
  const failed: Failure[] = [];
  let changed = 0;
  let alreadyThere = 0;

  // The reader's own order, so the report reads in the order the list was selected in.
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;

    if (row.state === nextState) {
      alreadyThere += 1;
      continue;
    }

    const changes: Prisma.ContactSubmissionUpdateInput = { state: nextState };

    /**
     * `repliedAt` is stamped the first time an enquiry is marked as replied, and never cleared.
     *
     * The reply itself is written in the reader's own mail program, so nothing can observe it; stamping the
     * moment somebody says "I have replied" is the closest honest record available. ⚠ The same rule as the
     * single-enquiry PATCH in `../[id]/route.ts` — if one changes, change both, or the same action would
     * record a different thing depending on which button was pressed.
     */
    if (nextState === "REPLIED" && row.repliedAt === null) changes.repliedAt = new Date();

    try {
      await mutateWithHistory<{ id: string }>(
        context,
        {
          action: nextState === "ARCHIVED" ? "ARCHIVE" : "UPDATE",
          entityType: "ContactSubmission",
          entityLabel: `${row.name} <${row.email}>`,
          /**
           * NO REVISION, AND NO MESSAGE IN THE LOG. The enquiry's own words are never edited here — only its
           * state — so a revision would be a second copy of correspondence that has not changed, in a table
           * more people read and that gets exported. Same reasoning as the single-enquiry PATCH.
           */
          revise: false,
          before: { state: row.state, repliedAt: row.repliedAt }
        },
        async (tx) =>
          tx.contactSubmission.update({
            where: { id: row.id },
            data: changes,
            select: { id: true }
          })
      );
      changed += 1;
    } catch (error) {
      /**
       * An `ApiError` carries a sentence written for a reader; anything else is a fault whose message would
       * name a table or a driver, so it goes to the server log and the reader gets a plain sentence
       * (lib/api.ts makes the same distinction for a whole response).
       */
      if (error instanceof ApiError) {
        failed.push({ id: row.id, name: row.name, reason: error.message });
      } else {
        console.error("[inquiries/bulk] could not update", row.id, error);
        failed.push({
          id: row.id,
          name: row.name,
          reason: "Something went wrong on our side and this one was not changed."
        });
      }
    }
  }

  const done = DONE_LABEL[action];

  const skippedSentence =
    (alreadyThere > 0 ? ` ${enquiries(alreadyThere)} ${alreadyThere === 1 ? "was" : "were"} already ${done}.` : "") +
    (notFound.length > 0
      ? ` ${enquiries(notFound.length)} ${notFound.length === 1 ? "is" : "are"} no longer in the inbox — somebody may have dealt with ${notFound.length === 1 ? "it" : "them"} while your screen was open.`
      : "");

  if (failed.length > 0) {
    /**
     * The message LEADS WITH WHAT WORKED, because those rows are saved and the reader needs to know not to
     * repeat them by hand. Three names at most: a list of twenty in a toast is a wall nobody reads, and the
     * `failed` array below carries every one for a screen that wants to show them all.
     */
    const named = failed
      .slice(0, 3)
      .map((entry) => `${entry.name} (${entry.reason})`)
      .join("; ");

    throw new ApiError(
      409,
      `${changed === 0 ? "None of the enquiries could be changed" : `${enquiries(changed)} ${changed === 1 ? "was" : "were"} ${done}, and ${enquiries(failed.length)} could not be`}.` +
        skippedSentence +
        ` ${failed.length === 1 ? "The one that failed" : "The ones that failed"}: ${named}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""}.` +
        " Nothing has been lost. Press the same button again to try the rest — the ones already done will be left alone.",
      { code: "bulk_partial_failure" }
    );
  }

  return ok({
    action,
    /** How many rows this request actually wrote. */
    changed,
    /** Rows that were already in that state, so no write was needed. */
    alreadyThere,
    notFound,
    failed,
    message:
      `${enquiries(changed)} ${changed === 1 ? "was" : "were"} ${done}.` +
      (nextState === "ARCHIVED"
        ? " Nothing has been deleted — every word is still there under the Archived filter."
        : "") +
      skippedSentence
  });
});
