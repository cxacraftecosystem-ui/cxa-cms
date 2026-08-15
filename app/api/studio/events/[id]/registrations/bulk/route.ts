import { z } from "zod";
// `Prisma` is imported as a VALUE: `Prisma.sql` is the tagged template `$queryRaw` needs. See `lockEvent`.
import { Prisma, type RegistrationStatus } from "@prisma/client";

import { assertSameOrigin, conflict, ok, route } from "@/lib/api";
import { writeAudit, type AuditContext, type TxClient } from "@/lib/audit";
import { requireCapability } from "@/lib/auth/current-user";
import { prisma } from "@/lib/db";
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
 * transaction, and the rows are walked in order.
 *
 * ⚠ `mutateWithHistory()` IS NOT USED, AND THIS IS THE SAME DELIBERATE EXCEPTION THE COLLECTION ROUTE
 * MAKES. That helper opens a transaction per entity, which is right for one row and wrong for forty. The
 * property it exists to guarantee — a change and its log cannot exist without each other — is preserved by
 * calling `writeAudit` on THIS transaction, at the granularity that matters: one entry per person, because
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

/** The states that occupy a place. The screen and both sibling routes count places the same way. */
const PLACE_HOLDING_STATES: readonly RegistrationStatus[] = ["CONFIRMED", "ATTENDED"];

const ALL_STATES = ["PENDING", "CONFIRMED", "WAITLISTED", "CANCELLED", "ATTENDED"] as const;

/** The most rows one batch may cover. A larger one is a script, not an organiser. Stated in the refusal. */
const MAX_BATCH = 200;

/** Plain words for a state. Never the enum name — every one of these reaches a reader. */
const STATE_WORDS: Record<RegistrationStatus, string> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  WAITLISTED: "waitlisted",
  CANCELLED: "cancelled",
  ATTENDED: "attended"
};

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

const REGISTRATION_SELECT = {
  id: true,
  name: true,
  email: true,
  state: true,
  certificateCode: true
} as const;

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface RowOutcome {
  id: string;
  /** The person, where the row was found. Null for an id that is no longer on this event's list. */
  name: string | null;
  from: RegistrationStatus | null;
  /** A sentence, ready to render. */
  message: string;
}

/**
 * Hold the event row until this transaction ends, so every writer that changes the number of places held
 * queues behind whoever got there first.
 *
 * ⚠ Duplicated in the sibling `[registrationId]/route.ts` rather than shared, because a `route.ts` may only
 * export its handlers and its route config — Next's generated type check refuses anything else — so there is
 * nowhere to put a shared helper without adding a module outside these two files. The two copies must stay
 * identical.
 *
 * `"events"` is `CoeEvent`'s table (`@@map`), and the model is named that way because `Event` is a DOM
 * global.
 */
async function lockEvent(tx: TxClient, eventId: string): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT "id" FROM "events" WHERE "id" = ${eventId} FOR UPDATE`
  );
  if (locked.length === 0) {
    throw conflict(
      "This event was removed while the change was being made, so nothing has been changed. Reload the events list."
    );
  }
}

/** "1 person" / "14 people". Written out because an English plural is not a suffix rule worth guessing. */
function people(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

interface BatchResult {
  state: RegistrationStatus;
  changed: number;
  /** Rows that were already in the state asked for. Not a failure. */
  unchanged: RowOutcome[];
  /** Rows that could not be moved, each with the reason. */
  failed: RowOutcome[];
  capacity: number | null;
  placesTaken: number;
  overCapacity: boolean;
  warnings: string[];
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
  const result = await applyBatch({ event, ids, state, body, context: auditContext });

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

/**
 * Walk the rows in order, inside one transaction, collecting an outcome for every one of them.
 *
 * Sequential rather than a single `updateMany`, because the capacity arithmetic is per row: the fifty-ninth
 * confirmation in a room of sixty is allowed and the sixty-first is the one to report, and a set-based
 * update cannot tell them apart or say which rows it left behind.
 */
async function applyBatch(input: {
  event: { id: string; title: string; capacity: number | null };
  ids: readonly string[];
  state: RegistrationStatus;
  body: { allowOverCapacity: boolean; expectedPlacesTaken?: number | undefined };
  context: AuditContext;
}): Promise<BatchResult> {
  const { event, ids, state, body } = input;
  const takesPlace = PLACE_HOLDING_STATES.includes(state);

  return prisma.$transaction(async (tx) => {
    await lockEvent(tx, event.id);

    const targets = await tx.eventRegistration.findMany({
      where: { id: { in: [...ids] }, eventId: event.id },
      select: REGISTRATION_SELECT
    });
    const byId = new Map(targets.map((row) => [row.id, row]));

    /** How many places are held right now, across the whole event. Read under the lock. */
    let placesTaken = await tx.eventRegistration.count({
      where: { eventId: event.id, state: { in: [...PLACE_HOLDING_STATES] } }
    });

    if (body.expectedPlacesTaken !== undefined && body.expectedPlacesTaken !== placesTaken) {
      throw conflict(
        `The numbers changed while this was being decided: ${placesTaken} ${placesTaken === 1 ? "place is" : "places are"} now taken, not ${body.expectedPlacesTaken}. Nothing has been changed — look again and repeat it if you still want to.`
      );
    }

    const unchanged: RowOutcome[] = [];
    const failed: RowOutcome[] = [];
    const withCertificates: string[] = [];
    let changed = 0;

    for (const rowId of ids) {
      const row = byId.get(rowId);

      if (!row) {
        // A stale screen: the registration was deleted, or belongs to another event. Reported per row rather
        // than abandoning the batch, so one bad id does not cost an organiser thirty-nine good ones.
        failed.push({
          id: rowId,
          name: null,
          from: null,
          message:
            "This registration is no longer on this event's list, so it has been left alone. Reload the page to see the list as it is now."
        });
        continue;
      }

      if (row.state === state) {
        unchanged.push({
          id: row.id,
          name: row.name,
          from: row.state,
          message: `${row.name} was already marked ${STATE_WORDS[state]}.`
        });
        continue;
      }

      const wasHolding = PLACE_HOLDING_STATES.includes(row.state);

      // Only an allocation is capacity-checked. Marking somebody ATTENDED records a fact — they were in the
      // room — and refusing to record it would make the attendance list a worse record of what happened.
      if (
        state === "CONFIRMED" &&
        !wasHolding &&
        event.capacity !== null &&
        placesTaken + 1 > event.capacity &&
        !body.allowOverCapacity
      ) {
        failed.push({
          id: row.id,
          name: row.name,
          from: row.state,
          message: `${row.name} has been left as they are: ${placesTaken} of the ${event.capacity} ${event.capacity === 1 ? "place" : "places"} are taken, so confirming them would go over the limit.`
        });
        continue;
      }

      await tx.eventRegistration.update({ where: { id: row.id }, data: { state } });
      changed += 1;

      if (wasHolding && !takesPlace) placesTaken -= 1;
      if (!wasHolding && takesPlace) placesTaken += 1;

      if (row.certificateCode !== null && row.state === "ATTENDED" && state !== "ATTENDED") {
        withCertificates.push(row.name);
      }

      // One entry per person, on THIS transaction. See the header for why this is not `mutateWithHistory`.
      await writeAudit(tx, input.context, {
        action: "UPDATE",
        entityType: "EventRegistration",
        entityId: row.id,
        entityLabel: `${row.name} <${row.email}> — ${event.title}`,
        before: { state: row.state },
        after: {
          state,
          batchOf: ids.length,
          capacity: event.capacity,
          placesTakenAfter: placesTaken,
          overCapacityAllowed:
            body.allowOverCapacity && event.capacity !== null && placesTaken > event.capacity
        }
      });
    }

    const warnings: string[] = [];

    if (withCertificates.length === 1 && withCertificates[0]) {
      // Not a refusal: an organiser correcting a mistake must not be stranded. But a certificate that has
      // been issued stays verifiable, and saying nothing leaves a document nobody remembers exists.
      warnings.push(
        `${withCertificates[0]} has already been issued a certificate for this event. It stays valid and can still be checked with its code, even though they are no longer marked as having attended.`
      );
    } else if (withCertificates.length > 1) {
      warnings.push(
        `${withCertificates.length} of these people have already been issued certificates. Those stay valid and can still be checked with their codes, even though they are no longer marked as having attended.`
      );
    }

    if (event.capacity !== null && placesTaken > event.capacity) {
      warnings.push(
        `There are now ${placesTaken} places taken against a limit of ${event.capacity}. Nobody is stopped from attending by this number; it only decides who the site puts on the waiting list.`
      );
    }

    return {
      state,
      changed,
      unchanged,
      failed,
      capacity: event.capacity,
      placesTaken,
      overCapacity: event.capacity !== null && placesTaken > event.capacity,
      warnings
    };
  });
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
