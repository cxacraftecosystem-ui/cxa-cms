import { z } from "@/lib/zod";
import type { RegistrationStatus } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
import { applyRegistrationBatch, STATE_WORDS, type BatchResult } from "@/lib/events/registration-writes";
import { canManageContent } from "@/lib/permissions";
import { buildAuditContext, fieldProblem, found, parseStudioJson } from "@/lib/studio/crud";

/**
 * Move a batch of registrations to one state, in a single request.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ONE REQUEST, ONE TRANSACTION, ONE AUDIT ENTRY PER PERSON — AND A REPORT PER ROW.
 *
 * `RegistrationsManager` sends every selected id at once rather than a request per row, and the reason is
 * in its own comment: forty separate calls are forty transactions for one intention, competing for the same
 * event, with no way to say afterwards that twelve worked and twenty-eight did not. So this is one
 * transaction, and the rows are walked in order (`applyRegistrationBatch`, lib/events/registration-writes.ts,
 * which then writes the moves and their audit entries as one statement each).
 *
 * ⚠ `mutateWithHistory()` IS NOT USED, AND THIS IS THE SAME DELIBERATE EXCEPTION THE COLLECTION ROUTE
 * MAKES. That helper opens a transaction per entity, which is right for one row and wrong for forty. The
 * property it exists to guarantee — a change and its log cannot exist without each other — is preserved by
 * writing the audit on THIS transaction, at the granularity that matters: one entry per person, because
 * "who cancelled MY registration" is the question the log is read to answer. No revision is written, for
 * the reason the collection route gives: a registration is not editorial content and nothing would ever
 * restore one.
 *
 * A ROW THAT CANNOT BE MOVED IS REPORTED BY NAME, NOT COUNTED. `failed` carries the id, the person's name
 * where it is known, and a sentence per row. `unchanged` carries the ones that were already in the state
 * asked for — which is not a failure and must not read as one. And if NOTHING changed, this answers a 409
 * rather than a 200 with a list of disappointments: a client that reads only the status would otherwise
 * print "40 people confirmed" over work that did not happen.
 *
 * ⚠ GOING OVER CAPACITY IS ALLOWED BY DEFAULT HERE, AND ONLY HERE. Read this before changing it.
 *
 * `RegistrationsManager` asks the organiser FIRST whenever a bulk confirm would pass the limit: it states
 * how many places there are, how many are taken, what the number would become, and by how much the limit
 * would be passed — then sends the request only if they agree. By construction, every batch reaching this
 * address that goes over the limit has already been agreed to with the arithmetic on screen. Refusing it
 * here would refuse the exact request somebody was just asked about and said yes to, and — because that
 * screen does not read this response body — the refusal would land as "nothing has changed" against a
 * screen that had already promised the change. `allowOverCapacity: false` restores the refusal for a caller
 * that has NOT asked; the single-registration route beside this one defaults the other way, because the row
 * menu it serves asks nothing. Both files carry this note.
 *
 * The overrun is never silent: `overCapacity`, `capacity` and `placesTaken` are in the answer, `warnings`
 * carries the sentence about it, and the screen's capacity line turns amber the moment it re-reads.
 *
 * ⚠ THE EVENT ROW IS LOCKED BEFORE THE COUNT IS READ. At Postgres's default READ COMMITTED, two organisers
 * confirming at the same moment each take a snapshot that does not contain the other's rows, both read
 * "58 of 60 taken", and the room ends up with 64 people in it. `SELECT … FOR UPDATE` on the event makes them
 * queue; the second one's count then runs on a fresh statement snapshot that includes the first one's
 * committed rows. The same technique as the collection route, so the two read alike.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

export const dynamic = "force-dynamic";

const ALL_STATES = ["PENDING", "CONFIRMED", "WAITLISTED", "CANCELLED", "ATTENDED"] as const;

/** The most rows one batch may cover. A larger one is a script, not an organiser. Stated in the refusal. */
const MAX_BATCH = 200;

/**
 * `action` as an alias for `state`, and where its vocabulary comes from.
 *
 * `RegistrationsManager` sends `{ ids, state }`, and that is the shape this route is built around. `action`
 * is accepted as well because the same four operations are identified in that file as `confirm`,
 * `attended`, `waitlist` and `cancel` — the ids of its bulk buttons — so a caller that sends the button's
 * own name gets what it plainly meant rather than a 422. Nothing here is invented: every key below is
 * either a state this schema stores or a bulk action that screen already declares.
 */
const ACTION_STATES: Record<string, RegistrationStatus> = {
  confirm: "CONFIRMED",
  confirmed: "CONFIRMED",
  attend: "ATTENDED",
  attended: "ATTENDED",
  waitlist: "WAITLISTED",
  waitlisted: "WAITLISTED",
  cancel: "CANCELLED",
  cancelled: "CANCELLED",
  pending: "PENDING"
};

const bulkSchema = z.object({
  ids: z
    .array(z.string().trim().min(1, "An empty registration reference cannot be used.").max(40))
    .min(1, "Choose at least one registration to change.")
    .max(MAX_BATCH, `Change at most ${MAX_BATCH} registrations at a time.`),
  state: z.enum(ALL_STATES).optional(),
  /** See `ACTION_STATES`. Case is ignored, because a button id and an enum name are spelled differently. */
  action: z.string().trim().max(40).optional(),
  /** See the header. Defaults to allowing the overrun BECAUSE THE SCREEN HAS ALREADY ASKED. */
  allowOverCapacity: z.boolean().default(true),
  /**
   * How many places the organiser BELIEVED were taken when they decided.
   *
   * Optional, and worth sending: it is what turns "two people confirming at once" from a silent overbooking
   * into a question asked again. Checked before anything is written, so a batch refused for this reason
   * changes nothing at all.
   */
  expectedPlacesTaken: z.coerce.number().int().min(0).optional()
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** "1 person" / "14 people". Written out because an English plural is not a suffix rule worth guessing. */
function people(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

export const POST = route(async (request: Request, context: RouteContext) => {
  assertSameOrigin(request);

  const user = await requireCapability(
    canManageContent,
    "Changing registrations needs editor access. An administrator can raise yours."
  );

  const { id } = await context.params;
  const body = await parseStudioJson(request, bulkSchema);

  const state = resolveState(body.state, body.action);

  // De-duplicated, keeping the order they arrived in, so the report reads down the screen. A repeated id
  // would otherwise be counted twice in the capacity arithmetic.
  const ids = [...new Set(body.ids)];

  const event = found(
    await prisma.coeEvent.findUnique({
      where: { id },
      select: { id: true, title: true, capacity: true }
    }),
    "That event"
  );

  const auditContext = buildAuditContext(request, user);
  const result = await applyRegistrationBatch({ event, ids, state, body, context: auditContext });

  /**
   * NOTHING CHANGED BUT SOMETHING FAILED IS A FAILURE, and it answers like one.
   *
   * A 200 here would be reported by every client as a successful batch. Nothing was written in this case —
   * the transaction had no updates to commit — so refusing costs nothing and tells the truth.
   */
  if (result.changed === 0 && result.failed.length > 0) {
    const first = result.failed[0];

    // The rows that were already in the state asked for are named too. Telling an organiser that nothing
    // worked, when four of their five people were already confirmed, sends them looking for a fault.
    const already =
      result.unchanged.length > 0
        ? `${people(result.unchanged.length)} ${result.unchanged.length === 1 ? "was" : "were"} already marked ${STATE_WORDS[state]}. `
        : "";

    const reason =
      result.failed.length === 1 && first
        ? first.message
        : `${people(result.failed.length)} could not be changed, so nothing has changed. One of the reasons: ${first?.message ?? ""}`;

    throw conflict(`${already}${reason}`.trim());
  }

  return ok({
    ...result,
    message: describeBatch(result, ids.length)
  });
});

/** Which state a batch is moving to, from either key. */
function resolveState(
  state: RegistrationStatus | undefined,
  action: string | undefined
): RegistrationStatus {
  if (state !== undefined) return state;

  if (action !== undefined) {
    const mapped = ACTION_STATES[action.toLowerCase()];
    if (mapped) return mapped;
    throw fieldProblem(
      "action",
      `“${action}” is not something that can be done to a registration. The choices are: confirm, attended, waitlist, cancel or pending.`
    );
  }

  throw fieldProblem(
    "state",
    "The request did not say what to change these registrations to. Send the state they should be moved to."
  );
}

/** One sentence covering what happened to the whole batch. Counts, never "some". */
function describeBatch(result: BatchResult, asked: number): string {
  const word = STATE_WORDS[result.state];

  if (result.changed === 0 && result.failed.length === 0) {
    return asked === 1
      ? `That person was already marked ${word}, so nothing has changed.`
      : `All ${people(asked)} were already marked ${word}, so nothing has changed.`;
  }

  const lead = `${people(result.changed)} ${result.changed === 1 ? "is" : "are"} now marked ${word}.`;
  const skipped =
    result.unchanged.length > 0
      ? ` ${people(result.unchanged.length)} ${result.unchanged.length === 1 ? "was" : "were"} already ${word}.`
      : "";
  const refused =
    result.failed.length > 0
      ? ` ${people(result.failed.length)} could not be changed; each one is listed with the reason.`
      : "";

  return `${lead}${skipped}${refused}`;
}
